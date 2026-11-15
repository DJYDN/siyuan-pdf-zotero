import {requireNode} from "../runtime";
import type {Settings} from "../types";
import {translationOutputDir} from "./pdf2zh";
import {effectiveTargetLang} from "./target-lang";

export interface Doc2xCheck {
    ok: boolean;
    checks: Array<{label: string; ok: boolean; detail: string}>;
    version?: string;
    account?: any;
    models?: any[];
    terms?: any[];
}

interface ProcessResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

function quote(value: string): string {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function run(command: string, args: string[], timeoutMs = 30_000): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const cp = requireNode("child_process");
        if (!cp?.spawn) {
            reject(new Error("当前运行环境没有 child_process"));
            return;
        }
        const line = [quote(command), ...args.map(quote)].join(" ");
        const child = cp.spawn(line, {
            shell: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result: ProcessResult) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (error: any) => {
            if (settled) return;
            settled = true;
            reject(error);
        });
        child.on("close", (code: number | null) => finish({code: code ?? -1, stdout, stderr, timedOut: false}));
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                // ignore
            }
            finish({code: -1, stdout, stderr, timedOut: true});
        }, timeoutMs);
        child.on("close", () => clearTimeout(timer));
    });
}

function parseJson(text: string): any {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        // CLI may print progress before the final JSON object.
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1));
            } catch {
                return null;
            }
        }
        return null;
    }
}

function baseArgs(settings: Settings): string[] {
    return ["--auth-mode", settings.doc2xAuthMode || "oauth"];
}

function resolveCommand(configured: string): string {
    const value = (configured || "doc2x").trim();
    if (value.includes("\\") || value.includes("/")) return value;
    const fs = requireNode("fs");
    const env = (globalThis as any).process?.env || {};
    const candidates = [
        env.APPDATA ? `${env.APPDATA}\\npm\\${value}.cmd` : "",
        env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\npm\\${value}.cmd` : "",
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (fs?.existsSync?.(candidate)) return candidate;
        } catch {
            // ignore
        }
    }
    return value;
}

export async function checkDoc2xEnvironment(settings: Settings): Promise<Doc2xCheck> {
    const command = resolveCommand(settings.doc2xCommand || "doc2x");
    const checks: Doc2xCheck["checks"] = [];
    const add = (label: string, ok: boolean, detail: string) => checks.push({label, ok, detail});
    if (!command) {
        add("CLI 命令", false, "未配置 doc2x 命令");
        return {ok: false, checks};
    }
    const version = await run(command, ["--version"], 15_000);
    const versionText = (version.stdout || version.stderr).trim().split(/\r?\n/)[0] || "";
    add("Doc2X CLI", version.code === 0 && !version.timedOut, version.timedOut ? "检测超时" : (versionText || `退出码 ${version.code}`));
    if (version.code !== 0 || version.timedOut) {
        return {ok: false, checks, version: versionText};
    }
    const auth = await run(command, ["account", "status", ...baseArgs(settings), "--json"], 25_000);
    const account = parseJson(auth.stdout);
    const authOk = auth.code === 0 && Boolean(account) && !auth.timedOut;
    add("账号授权", authOk, auth.timedOut ? "检测超时" : (authOk ? String(account?.accountId || account?.email || "已登录") : (auth.stderr || auth.stdout || "未登录，请先运行 doc2x login").slice(0, 300)));
    const modelsResult = await run(command, ["models", "list", ...baseArgs(settings), "--json"], 25_000);
    const models = parseJson(modelsResult.stdout);
    const list = Array.isArray(models) ? models : (Array.isArray(models?.models) ? models.models : []);
    const modelsOk = modelsResult.code === 0 && !modelsResult.timedOut && list.length > 0;
    add("可用模型", modelsOk, modelsResult.timedOut ? "检测超时" : (modelsOk ? `${list.length} 个模型` : (modelsResult.stderr || "没有读取到模型").slice(0, 300)));
    const termsResult = await run(command, ["term", "list", ...baseArgs(settings), "--json"], 25_000);
    const terms = parseJson(termsResult.stdout);
    const termList = Array.isArray(terms) ? terms : (Array.isArray(terms?.terms) ? terms.terms : []);
    return {
        ok: checks.every(item => item.ok),
        checks,
        version: versionText,
        account,
        models: list,
        terms: termList,
    };
}

function collectPdfFiles(dir: string): string[] {
    const fs = requireNode("fs");
    const path = requireNode("path");
    if (!fs?.readdirSync || !fs.existsSync(dir)) return [];
    const result: string[] = [];
    const walk = (current: string) => {
        let entries: any[] = [];
        try {
            entries = fs.readdirSync(current, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (/\.pdf$/i.test(entry.name)) {
                result.push(full);
            }
        }
    };
    walk(dir);
    return result;
}

export interface Doc2xTranslateResult {
    files: string[];
    stdout: string;
    stderr: string;
}

export async function translateWithDoc2x(
    settings: Settings,
    inputPath: string,
    outputDir: string,
): Promise<Doc2xTranslateResult> {
    const fs = requireNode("fs");
    const path = requireNode("path");
    fs.mkdirSync(outputDir, {recursive: true});
    const receipt = path.join(outputDir, "doc2x-receipt.json");
    const args = [
        "translate",
        inputPath,
        "--auth-mode", settings.doc2xAuthMode || "oauth",
        "--target-language", effectiveTargetLang(settings, "doc2x"),
        "--out", outputDir,
        "--receipt", receipt,
        "--json",
    ];
    if (settings.doc2xOutputMode === "translatedPdf") {
        args.push("--translate-type", "md", "--to", "pdf", "--convert-trans", "translate");
    } else {
        args.push("--translate-type", "pdf", "--convert-trans", "both");
    }
    if (settings.doc2xModel.trim()) {
        args.push("--target-model", settings.doc2xModel.trim());
    }
    if (settings.doc2xTermId.trim()) {
        args.push("--term-id", settings.doc2xTermId.trim());
    }
    if (settings.doc2xFontColor) args.push("--font-color-extraction");
    if (settings.doc2xContextual) args.push("--contextual-translation");
    if (settings.doc2xOutputMode !== "translatedPdf" && settings.doc2xFontStrategy === "page-optimal") {
        args.push("--pdf-font-strategy", "page-optimal");
    }
    if (settings.doc2xIgnoreTypes?.length) {
        args.push("--ignore-translate-types", ...settings.doc2xIgnoreTypes);
    }
    const result = await run(resolveCommand(settings.doc2xCommand || "doc2x"), args, 45 * 60_000);
    if (result.code !== 0) {
        const log = writeDoc2xErrorLog(settings, "translate", result);
        throw new Error(`${(result.stderr || result.stdout || `Doc2X CLI 退出码 ${result.code}`).slice(0, 12_000)}\n${log ? `错误日志：${log}` : ""}`);
    }
    const payload = parseJson(result.stdout);
    let files: string[] = [];
    const collect = (value: any) => {
        if (typeof value === "string" && /\.pdf$/i.test(value)) files.push(value);
        if (Array.isArray(value)) value.forEach(collect);
        if (value && typeof value === "object") {
            for (const key of ["outputFiles", "files", "outputs"]) {
                if (key in value) collect(value[key]);
            }
        }
    };
    collect(payload);
    if (!files.length) files = collectPdfFiles(outputDir);
    files = files
        .map(file => path.isAbsolute(file) ? file : path.join(outputDir, file))
        .filter(file => fs.existsSync(file));
    if (!files.length) {
        throw new Error("Doc2X 已完成，但没有找到导出的 PDF");
    }
    return {files, stdout: result.stdout, stderr: result.stderr};
}

export function doc2xErrorLogDir(settings: Settings): string {
    const path = requireNode("path");
    return path.join(translationOutputDir(settings), "doc2x-errors");
}

export function writeDoc2xErrorLog(settings: Settings, command: string, result: {code: number; stdout: string; stderr: string; timedOut: boolean}): string {
    try {
        const fs = requireNode("fs");
        const path = requireNode("path");
        const dir = doc2xErrorLogDir(settings);
        fs.mkdirSync(dir, {recursive: true});
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = path.join(dir, `doc2x-${stamp}.log`);
        const content = [
            `command: doc2x ${command}`,
            `time: ${new Date().toISOString()}`,
            `exitCode: ${result.code}`,
            `timedOut: ${result.timedOut}`,
            "--- stdout ---",
            result.stdout,
            "--- stderr ---",
            result.stderr,
        ].join("\n");
        fs.writeFileSync(file, content, "utf8");
        return file;
    } catch {
        return "";
    }
}

function collectFilesByExtension(dir: string, ext: string): string[] {
    const fs = requireNode("fs");
    const path = requireNode("path");
    if (!fs?.readdirSync || !fs.existsSync(dir)) return [];
    const result: string[] = [];
    const walk = (current: string) => {
        let entries: any[] = [];
        try {
            entries = fs.readdirSync(current, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.toLowerCase().endsWith(ext)) result.push(full);
        }
    };
    walk(dir);
    return result.sort();
}

function doc2xCommonArgs(settings: Settings): string[] {
    const args = ["--auth-mode", settings.doc2xAuthMode || "oauth"];
    if (settings.doc2xModel?.trim()) args.push("--target-model", settings.doc2xModel.trim());
    if (settings.doc2xTermId?.trim()) args.push("--term-id", settings.doc2xTermId.trim());
    if (settings.doc2xFontColor) args.push("--font-color-extraction");
    if (settings.doc2xContextual) args.push("--contextual-translation");
    if (settings.doc2xIgnoreTypes?.length) args.push("--ignore-translate-types", ...settings.doc2xIgnoreTypes);
    return args;
}

export interface Doc2xMarkdownResult {
    files: string[];
    markdownFiles: string[];
    stdout: string;
    stderr: string;
}

export async function parseWithDoc2x(
    settings: Settings,
    inputPath: string,
    outputDir: string,
): Promise<Doc2xMarkdownResult> {
    const fs = requireNode("fs");
    const path = requireNode("path");
    fs.mkdirSync(outputDir, {recursive: true});
    const args = [
        "parse",
        inputPath,
        "--auth-mode", settings.doc2xAuthMode || "oauth",
        "--to", "md",
        "--out", outputDir,
        "--json",
        "--overwrite",
    ];
    const command = `parse ${inputPath}`;
    const result = await run(resolveCommand(settings.doc2xCommand || "doc2x"), args, 45 * 60_000);
    if (result.code !== 0) {
        const log = writeDoc2xErrorLog(settings, command, result);
        throw new Error(`${(result.stderr || result.stdout || `Doc2X CLI 退出码 ${result.code}`).slice(0, 12000)}\n${log ? `错误日志：${log}` : ""}`);
    }
    const files = collectFilesByExtension(outputDir, ".md");
    if (!files.length) throw new Error("Doc2X 解析完成，但没有找到 Markdown 文件");
    return {files, markdownFiles: files, stdout: result.stdout, stderr: result.stderr};
}

export async function translateWithDoc2xMarkdown(
    settings: Settings,
    inputPath: string,
    outputDir: string,
    convert: "origin" | "translate" | "both" = "translate",
): Promise<Doc2xMarkdownResult> {
    const fs = requireNode("fs");
    const path = requireNode("path");
    fs.mkdirSync(outputDir, {recursive: true});
    const args = [
        "translate",
        inputPath,
        ...doc2xCommonArgs(settings),
        "--target-language", settings.doc2xTargetLang || "zh",
        "--translate-type", "md",
        "--to", "md",
        "--convert-trans", convert,
        "--out", outputDir,
        "--json",
        "--overwrite",
    ];
    const command = `translate --translate-type md --convert-trans ${convert} ${inputPath}`;
    const result = await run(resolveCommand(settings.doc2xCommand || "doc2x"), args, 45 * 60_000);
    if (result.code !== 0) {
        const log = writeDoc2xErrorLog(settings, command, result);
        throw new Error(`${(result.stderr || result.stdout || `Doc2X CLI 退出码 ${result.code}`).slice(0, 12000)}\n${log ? `错误日志：${log}` : ""}`);
    }
    const files = collectFilesByExtension(outputDir, ".md");
    if (!files.length) throw new Error("Doc2X 翻译完成，但没有找到 Markdown 文件");
    return {files, markdownFiles: files, stdout: result.stdout, stderr: result.stderr};
}

export function doc2xOutputPath(attachmentId: string, fingerprint: string, settings: Settings): string {
    const path = requireNode("path");
    const safe = (fingerprint || attachmentId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
    return path.join(translationOutputDir(settings), `doc2x-${safe}-${settings.doc2xOutputMode}-${effectiveTargetLang(settings, "doc2x").replace(/[^a-zA-Z0-9_-]/g, "")}`);
}

export function doc2xActionOutputDir(settings: Settings, attachmentId: string, fingerprint: string, kind: string): string {
    const path = requireNode("path");
    const safe = (fingerprint || attachmentId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
    return path.join(translationOutputDir(settings), `doc2x-${kind}-${safe}`);
}
