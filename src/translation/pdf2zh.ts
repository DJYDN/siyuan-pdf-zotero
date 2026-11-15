import {fileExists, readFileBytes, requireNode, siyuanDataDir} from "../runtime";
import type {Settings} from "../types";
import {effectiveTargetLang} from "./target-lang";

export interface Pdf2zhTask {
    taskId: string;
    active?: boolean;
    finished?: boolean;
    progress?: number;
    status?: string;
    message?: string;
    fileList?: string[];
    filePaths?: string[];
    error?: string;
}

export interface Pdf2zhProgress {
    progress: number;
    message: string;
}

function normalizeBaseUrl(value: string): string {
    return (value || "http://127.0.0.1:8890").trim().replace(/\/+$/, "");
}

function normalizeService(value: string): string {
    // PDF2zh's CLI compares service names case-sensitively (`Bing` fails,
    // `bing` works), so normalize both old and new server payloads.
    return (value || "bing").trim().toLowerCase();
}

function request(
    urlValue: string,
    options: {method?: string; headers?: Record<string, string>; body?: string; timeout?: number; binary?: boolean} = {},
): Promise<{status: number; body: Buffer; text: string}> {
    const url = new URL(urlValue);
    const transport = requireNode(url.protocol === "https:" ? "https" : "http");
    if (!transport?.request) {
        return Promise.reject(new Error("当前运行环境没有 Node HTTP 能力"));
    }
    return new Promise((resolve, reject) => {
        const req = transport.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: options.method || "GET",
            headers: {...(options.headers || {})},
        }, (res: any) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
                const body = Buffer.concat(chunks);
                resolve({status: res.statusCode || 0, body, text: body.toString("utf8")});
            });
        });
        req.setTimeout(options.timeout || 60_000, () => req.destroy(new Error("PDF2zh 请求超时")));
        req.on("error", reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

async function requestJson(url: string, options: Parameters<typeof request>[1] = {}): Promise<any> {
    const response = await request(url, options);
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`PDF2zh HTTP ${response.status}: ${response.text.slice(0, 400)}`);
    }
    return JSON.parse(response.text);
}

let serverStartPromise: Promise<boolean> | null = null;

export async function ensurePdf2zhServer(settings: Settings): Promise<{ok: boolean; error?: string}> {
    const client = new Pdf2zhClient(settings.pdf2zhBaseUrl);
    const health = await client.health();
    if (health.ok) return {ok: true};
    const root = (settings.pdf2zhServerPath || "").trim();
    if (!root) {
        return {ok: false, error: health.error || "PDF2zh 服务未运行，且没有配置服务目录"};
    }
    if (serverStartPromise) {
        return (await serverStartPromise) ? {ok: true} : {ok: false, error: "PDF2zh 服务启动失败"};
    }
    serverStartPromise = (async (): Promise<boolean> => {
        try {
            const path = requireNode("path");
            const fs = requireNode("fs");
            const cp = requireNode("child_process");
            const python = path.join(root, "build", "runtime", "python.exe");
            const script = path.join(root, "pz_server.py");
            if (!fs.existsSync(python) || !fs.existsSync(script)) {
                return false;
            }
            const url = new URL(settings.pdf2zhBaseUrl || "http://127.0.0.1:8890");
            const port = url.port || "8890";
            const child = cp.spawn(python, [script, port], {
                cwd: root,
                detached: true,
                windowsHide: true,
                stdio: "ignore",
            });
            child.unref();
            for (let index = 0; index < 40; index++) {
                await new Promise(resolve => setTimeout(resolve, 750));
                const status = await client.health();
                if (status.ok) return true;
            }
            return false;
        } catch {
            return false;
        } finally {
            serverStartPromise = null;
        }
    })();
    const ok = await serverStartPromise;
    return ok ? {ok: true} : {ok: false, error: "无法启动 PDF2zh 服务，请检查服务目录"};
}

export interface Pdf2zhEnvironmentCheck {
    ok: boolean;
    checks: Array<{label: string; ok: boolean; detail: string}>;
    health: {ok: boolean; version?: string; error?: string};
}

export async function checkPdf2zhEnvironment(settings: Settings): Promise<Pdf2zhEnvironmentCheck> {
    const checks: Pdf2zhEnvironmentCheck["checks"] = [];
    const root = (settings.pdf2zhServerPath || "").trim();
    const fs = requireNode("fs");
    const path = requireNode("path");
    const add = (label: string, ok: boolean, detail: string) => checks.push({label, ok, detail});
    if (!root) {
        add("服务目录", false, "未填写；自动启动需要填写便携 server 目录");
    } else {
        add("服务目录", fs?.existsSync?.(root) || false, root);
        const python = path?.join?.(root, "build", "runtime", "python.exe") || "";
        const script = path?.join?.(root, "pz_server.py") || "";
        const exe = path?.join?.(root, "build", "pdf2zh.exe") || "";
        const config = path?.join?.(root, "config.json") || "";
        add("Python 运行时", Boolean(fs?.existsSync?.(python)), python || "build/runtime/python.exe");
        add("服务脚本", Boolean(fs?.existsSync?.(script)), script || "pz_server.py");
        add("PDF2zh 引擎", Boolean(fs?.existsSync?.(exe)), exe || "build/pdf2zh.exe");
        let configOk = false;
        try {
            const parsed = JSON.parse(fs.readFileSync(config, "utf8"));
            configOk = Array.isArray(parsed?.translators) && parsed.translators.length > 0;
        } catch {
            configOk = false;
        }
        add("配置文件", configOk, config || "config.json");
    }
    const health = await new Pdf2zhClient(settings.pdf2zhBaseUrl).health();
    add("服务状态", health.ok, health.ok ? `已运行 ${health.version || ""}` : (health.error || "未运行，点击翻译时会尝试自动启动"));
    return {ok: checks.filter(item => item.label !== "服务状态").every(item => item.ok), checks, health};
}

export class Pdf2zhClient {
    private readonly baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
    }

    async progress(): Promise<{running: boolean; progress: number; status: string; logs: string[]} | null> {
        try {
            const data = await requestJson(`${this.baseUrl}/progress`, {timeout: 5000});
            return {
                running: Boolean(data?.running),
                progress: Number(data?.progress) || 0,
                status: String(data?.status || ""),
                logs: Array.isArray(data?.logs) ? data.logs.map((line: any) => String(line)) : [],
            };
        } catch {
            return null;
        }
    }

    async health(): Promise<{ok: boolean; version?: string; error?: string}> {
        try {
            const data = await requestJson(`${this.baseUrl}/health`);
            return {ok: data?.status === "ok", version: String(data?.version || "")};
        } catch (error: any) {
            return {ok: false, error: error?.message || String(error)};
        }
    }

    async start(filePath: string, fileName: string, settings: Settings): Promise<Pdf2zhTask> {
        const bytes = await readFileBytes(filePath);
        const buffer = requireNode("buffer")?.Buffer || (globalThis as any).Buffer;
        if (!buffer) throw new Error("当前运行环境没有 Buffer");
        const base64 = buffer.from(bytes).toString("base64");
        const outputMode = settings.pdf2zhOutputMode;
        const engine = settings.pdf2zhEngine || "pdf2zh_next";
        const payload: Record<string, any> = {
            engine,
            service: normalizeService(settings.pdf2zhService || (engine === "pdf2zh_next" ? "siliconflowfree" : "bing")),
            sourceLang: settings.pdf2zhSourceLang || "en",
            targetLang: effectiveTargetLang(settings, "pdf2zh"),
            fileName,
            fileContent: base64,
            asyncJob: true,
            clientProtocol: "accepted",
            outputMode,
            mono: outputMode === "mono",
            dual: outputMode === "dual",
            noMono: outputMode === "dual",
            noDual: outputMode === "mono",
            original: false,
            dualMode: settings.pdf2zhDualMode || "LR",
            noWatermark: true,
        };
        const data = await requestJson(`${this.baseUrl}/translate`, {
            method: "POST",
            headers: {"Content-Type": "application/json", "X-PDF2zh-Protocol": "accepted"},
            body: JSON.stringify(payload),
            // Legacy sync servers translate inside this request. Do not let a
            // dead Bing request hold the plugin indefinitely.
            timeout: 15 * 60_000,
        });
        if (data?.status === "success") {
            return {taskId: "", fileList: data.fileList || [], filePaths: data.filePaths || []};
        }
        if (data?.status !== "accepted" || !data?.taskId) {
            throw new Error(data?.message || "PDF2zh 没有返回任务 ID");
        }
        return {taskId: String(data.taskId)};
    }

    async task(taskId: string): Promise<Pdf2zhTask | null> {
        const data = await requestJson(`${this.baseUrl}/api/tasks`);
        const list = Array.isArray(data?.tasks) ? data.tasks : [];
        const found = list.find((item: any) => String(item?.taskId || "") === taskId);
        return found ? found as Pdf2zhTask : null;
    }

    async download(fileName: string): Promise<Buffer> {
        const response = await request(`${this.baseUrl}/translatedFile/${encodeURIComponent(fileName)}`, {timeout: 120_000});
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`PDF2zh 下载失败：HTTP ${response.status}`);
        }
        return response.body;
    }
}

export function choosePdf2zhOutput(task: Pdf2zhTask, mode: "mono" | "dual"): string {
    const files = task.fileList || [];
    const preferred = files.find(name => {
        const lower = name.toLowerCase();
        return mode === "dual"
            ? /dual/.test(lower) && !/cut|compare/.test(lower)
            : /mono/.test(lower) && !/cut|compare/.test(lower);
    });
    return preferred || files.find(name => !/cut|compare/.test(name.toLowerCase())) || files[0] || "";
}

export function translationOutputDir(settings?: Settings): string {
    if (settings?.translationOutputDir?.trim()) {
        return settings.translationOutputDir.trim();
    }
    const dataDir = siyuanDataDir();
    if (!dataDir) throw new Error("无法确定思源数据目录");
    return `${dataDir}/storage/petal/siyuan-pdf-zotero/translations`;
}

export function translationOutputPath(attachmentId: string, fingerprint: string, settings: Settings): string {
    const safe = (fingerprint || attachmentId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
    const service = normalizeService(settings.pdf2zhService || "default").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
    return `${translationOutputDir(settings)}/pdf2zh-${safe}-${settings.pdf2zhEngine}-${service}-${settings.pdf2zhOutputMode}-${settings.pdf2zhDualMode}-${effectiveTargetLang(settings, "pdf2zh").replace(/[^a-zA-Z0-9_-]/g, "")}.pdf`;
}

export function writeTranslationPdf(filePath: string, data: Buffer): void {
    const fs = requireNode("fs");
    if (!fs?.mkdirSync || !fs?.writeFileSync) throw new Error("当前运行环境没有文件写入能力");
    const path = requireNode("path");
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(filePath, data);
}

export {fileExists};
