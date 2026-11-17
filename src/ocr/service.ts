import {fileExists, requireNode} from "../runtime";
import type {OcrEngineId, Settings} from "../types";
import {
    engineConfig,
    enginesForMode,
    OCR_ENGINE_DEFS,
    serviceGroupForEngine,
    serviceGroups,
    type OcrServiceGroup,
} from "./engines";
import {
    getOcrHealth,
    ocrServiceUrl,
    recognizeWithEngine,
    OcrHttpError,
    type OcrHealth,
    type OcrResult,
} from "./client";

export interface OcrCheckItem {
    label: string;
    ok: boolean;
    detail: string;
}

export interface OcrEngineEnvironmentCheck {
    engine: OcrEngineId;
    ok: boolean;
    checks: OcrCheckItem[];
    python: string;
    script: string;
    port: number;
    health?: OcrHealth;
    error?: string;
}

export interface OcrEnvironmentCheck {
    ok: boolean;
    checks: OcrCheckItem[];
    engines: OcrEngineEnvironmentCheck[];
}

export interface OcrServicePaths {
    dir: string;
    python: string;
    script: string;
    port: number;
}

export interface OcrAttempt {
    engine: OcrEngineId;
    ok: boolean;
    error?: string;
    skipped?: string;
    elapsedMs?: number;
}

export interface OcrFallbackResult {
    result: OcrResult;
    engine: OcrEngineId;
    attempts: OcrAttempt[];
}

const START_TIMEOUT_MS: Record<OcrEngineId, number> = {
    // First ever start imports a large Python stack (and Defender scans the runtime),
    // which can take 2-3 minutes on Windows; warm starts are much faster.
    pix2text: 300_000,
    unimernet: 240_000,
    texo: 60_000,
};

function pythonCandidates(settings: Settings, dir: string): string[] {
    const path = requireNode("path");
    if (!path?.join) {
        return [];
    }
    const candidates: string[] = [];
    const shared = String(settings.ocrSharedRuntimeDir || "").trim();
    if (shared) {
        candidates.push(path.join(shared, "runtime", "python.exe"), path.join(shared, "python.exe"));
    }
    candidates.push(
        path.join(dir, "runtime", "python.exe"),
        path.join(dir, "build", "runtime", "python.exe"),
        path.join(dir, "python.exe"),
    );
    return candidates;
}

function resolveScript(group: OcrServiceGroup): string {
    const path = requireNode("path");
    if (!path?.join) {
        return "";
    }
    for (const engine of group.engines) {
        for (const script of OCR_ENGINE_DEFS[engine].scriptCandidates) {
            const candidate = path.join(group.dir, script);
            if (fileExists(candidate)) {
                return candidate;
            }
        }
    }
    // Legacy shared service: only usable by Pix2Text / UniMERNet, never by Texo.
    if (group.engines.some(id => id === "pix2text" || id === "unimernet")) {
        const legacy = path.join(group.dir, "pz_ocr_server.py");
        if (fileExists(legacy)) {
            return legacy;
        }
    }
    return "";
}

export function resolveServicePaths(settings: Settings, engine: OcrEngineId): OcrServicePaths {
    const group = serviceGroupForEngine(settings, engine);
    if (!group) {
        return {dir: "", python: "", script: "", port: engineConfig(settings, engine).port};
    }
    const python = pythonCandidates(settings, group.dir).find(fileExists) || "";
    return {dir: group.dir, python, script: resolveScript(group), port: group.port};
}

export function ocrLogDir(settings: Settings): string {
    const path = requireNode("path");
    const shared = String(settings.ocrSharedRuntimeDir || "").trim();
    if (!shared) {
        return "";
    }
    return path?.join ? path.join(shared, "logs") : "";
}

function checkHealthSupportsEngine(health: OcrHealth, engine: OcrEngineId): boolean {
    const capabilities = health.capabilities;
    if (!capabilities) {
        return true;
    }
    const def = OCR_ENGINE_DEFS[engine].capabilities;
    return Boolean(
        (capabilities.formula && def.formula)
        || (capabilities.text && def.text)
        || (capabilities.mixed && def.mixed),
    ) || (!capabilities.formula && !capabilities.text && !capabilities.mixed);
}

export async function checkOcrEngineEnvironment(settings: Settings, engine: OcrEngineId): Promise<OcrEngineEnvironmentCheck> {
    const checks: OcrCheckItem[] = [];
    const add = (label: string, ok: boolean, detail: string) => checks.push({label, ok, detail});
    const config = engineConfig(settings, engine);
    const paths = resolveServicePaths(settings, engine);
    const def = OCR_ENGINE_DEFS[engine];
    add("启用状态", config.enabled, config.enabled ? "已启用" : "未启用");
    const dirExists = Boolean(paths.dir) && Boolean(requireNode("fs")?.existsSync?.(paths.dir));
    add("服务目录", dirExists, paths.dir || `未选择目录（${def.dirHint}）`);
    const bundle = detectOcrBundle(paths.dir);
    add("目录类型", isBundleCompatible(bundle, engine), bundle.kind === "unknown" ? "未识别的目录" : `${bundle.label}${isBundleCompatible(bundle, engine) ? "" : "（不适用于该引擎）"}`);
    add("服务脚本", Boolean(paths.script), paths.script || `未找到 ${def.scriptCandidates.join(" / ")}`);
    add("Python 运行时", Boolean(paths.python || settings.ocrStartCommand?.trim()),
        paths.python || (settings.ocrStartCommand?.trim() ? "使用自定义启动命令" : "未找到 runtime/python.exe（可配置共享运行时目录）"));
    add("端口", paths.port > 0 && paths.port < 65536, String(paths.port));
    const health = await getOcrHealth(settings, engine);
    add("服务状态", health.ok, health.ok
        ? `已运行${health.version ? `（${health.version}）` : ""}${health.engine ? ` · ${health.engine}` : ""}`
        : (health.error || "未运行"));
    if (health.ok) {
        add("模型状态", health.modelReady !== false, health.modelReady === false ? "模型未就绪" : "模型已就绪");
        add("引擎能力", checkHealthSupportsEngine(health, engine), `该服务 ${def.capabilities.formula ? "支持公式" : ""}${def.capabilities.text ? " / 支持文本" : ""}`);
        if (health.missing?.length) {
            add("模型文件", false, `缺少：${health.missing.join("、")}`);
        }
    }
    const ok = checks.every(item => item.ok || item.label === "启用状态");
    return {
        engine,
        ok: ok && config.enabled,
        checks,
        python: paths.python,
        script: paths.script,
        port: paths.port,
        health,
        error: health.ok ? "" : health.error,
    };
}

export async function checkOcrEnvironment(settings: Settings): Promise<OcrEnvironmentCheck> {
    const engines = serviceGroups(settings).flatMap(group => group.engines);
    const results: OcrEngineEnvironmentCheck[] = [];
    for (const engine of engines) {
        results.push(await checkOcrEngineEnvironment(settings, engine));
    }
    const checks: OcrCheckItem[] = results.flatMap(result =>
        result.checks.map(item => ({...item, label: `${OCR_ENGINE_DEFS[result.engine].name} · ${item.label}`})),
    );
    return {ok: results.length > 0 && results.every(result => result.ok), checks, engines: results};
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function waitForHealth(settings: Settings, engine: OcrEngineId, timeoutMs: number): Promise<OcrHealth> {
    const started = Date.now();
    let last: OcrHealth = {ok: false, error: "OCR 服务连接超时"};
    while (Date.now() - started < timeoutMs) {
        await sleep(600);
        last = await getOcrHealth(settings, engine, 5000);
        if (last.ok) {
            return last;
        }
    }
    return last;
}

/**
 * Make sure the service that hosts `engine` is running.
 * Returns `{ok, started}`; `started` is true when this call spawned the process.
 */

function engineBundleError(settings: Settings, engine: OcrEngineId): string {
    const dir = engineConfig(settings, engine).dir.trim();
    if (!dir) {
        return "";
    }
    const bundle = detectOcrBundle(dir);
    if (!bundle.kind || bundle.kind === "unknown") {
        return `${OCR_ENGINE_DEFS[engine].name} 目录里没有可识别的服务（需要 service.py 或 pz_ocr_server.py）`;
    }
    if (!isBundleCompatible(bundle, engine)) {
        return `${OCR_ENGINE_DEFS[engine].name} 目录不匹配：该目录是「${bundle.label}」，不能用于 ${OCR_ENGINE_DEFS[engine].name}`;
    }
    return "";
}

export async function ensureOcrEngine(settings: Settings, engine: OcrEngineId): Promise<{ok: boolean; started: boolean; error?: string; pid?: number}> {
    const bundleError = engineBundleError(settings, engine);
    if (bundleError) {
        return {ok: false, started: false, error: bundleError};
    }
    const health = await getOcrHealth(settings, engine);
    if (health.ok) {
        return {ok: true, started: false, pid: health.pid};
    }
    const group = serviceGroupForEngine(settings, engine);
    if (!group) {
        return {ok: false, started: false, error: `${OCR_ENGINE_DEFS[engine].name} 未配置服务目录`};
    }
    if (!group.autoStart) {
        return {ok: false, started: false, error: "OCR 服务未运行，且未开启自动启动"};
    }
    const paths = resolveServicePaths(settings, engine);
    const cp = requireNode("child_process");
    if (!cp?.spawn) {
        return {ok: false, started: false, error: "当前环境没有 child_process，无法启动本地服务"};
    }
    let child: any;
    try {
        if (settings.ocrStartCommand?.trim()) {
            child = cp.spawn(settings.ocrStartCommand.trim(), {
                cwd: group.dir,
                shell: true,
                detached: true,
                windowsHide: true,
                stdio: "ignore",
            });
        } else {
            if (!paths.python) {
                return {ok: false, started: false, error: "未找到 Python 运行时（可配置共享运行时目录）"};
            }
            if (!paths.script) {
                return {ok: false, started: false, error: `未找到服务脚本（${OCR_ENGINE_DEFS[engine].scriptCandidates.join(" / ")}）`};
            }
            const logDir = ocrLogDir(settings);
            try {
                requireNode("fs")?.mkdirSync?.(logDir, {recursive: true});
            } catch {
                // logging is best-effort
            }
            child = cp.spawn(paths.python, [paths.script, String(paths.port)], {
                cwd: group.dir,
                detached: true,
                windowsHide: true,
                stdio: "ignore",
            });
        }
        child.unref?.();
    } catch (error: any) {
        return {ok: false, started: false, error: error?.message || String(error)};
    }
    const timeout = START_TIMEOUT_MS[engine] || 40_000;
    const result = await waitForHealth(settings, engine, timeout);
    if (result.ok) {
        return {ok: true, started: true, pid: result.pid};
    }
    return {ok: false, started: true, error: `OCR 服务启动超时：${ocrServiceUrl(settings, engine)}${result.error ? `（${result.error}）` : ""}`};
}

/** Legacy alias: ensure the primary engine for the current settings. */
export async function ensureOcrServer(settings: Settings): Promise<{ok: boolean; started: boolean; error?: string}> {
    const engines = enginesForMode(settings, "formula");
    if (!engines.length) {
        return {ok: false, started: false, error: "没有可用的 OCR 引擎，请先在设置 → OCR 启用一个引擎"};
    }
    return ensureOcrEngine(settings, engines[0]);
}

export async function stopOcrEngine(settings: Settings, engine: OcrEngineId): Promise<{ok: boolean; error?: string}> {
    const health = await getOcrHealth(settings, engine);
    if (!health.ok) {
        return {ok: true};
    }
    if (!health.pid) {
        return {ok: false, error: "服务没有报告 PID，无法自动停止；请手动关闭该服务窗口"};
    }
    const cp = requireNode("child_process");
    try {
        const isWindows = typeof process !== "undefined" && process.platform === "win32";
        if (isWindows) {
            cp.spawn("taskkill", ["/PID", String(health.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
        } else {
            process.kill(health.pid, "SIGTERM");
        }
    } catch (error: any) {
        return {ok: false, error: error?.message || String(error)};
    }
    for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(300);
        const current = await getOcrHealth(settings, engine, 2000);
        if (!current.ok) {
            return {ok: true};
        }
    }
    return {ok: false, error: "停止服务超时"};
}

export async function restartOcrEngine(settings: Settings, engine: OcrEngineId): Promise<{ok: boolean; error?: string}> {
    const stopped = await stopOcrEngine(settings, engine);
    if (!stopped.ok) {
        return stopped;
    }
    const started = await ensureOcrEngine(settings, engine);
    return {ok: started.ok, error: started.error};
}

function summarizeAttempts(attempts: OcrAttempt[]): string {
    return attempts.map(attempt => {
        const name = OCR_ENGINE_DEFS[attempt.engine].name;
        const reason = attempt.skipped || attempt.error || "失败";
        return `${name}：${reason}`;
    }).join("；");
}

/**
 * Recognize an image with automatic engine fallback.
 *
 * Tries the engines configured for `options.mode` in order; a service that is
 * not running is started on demand, and a failing engine falls through to the
 * next one. Throws `OcrHttpError` with a per-engine summary when all fail.
 */
export async function recognizeWithFallback(
    settings: Settings,
    blob: Blob,
    options: {mode?: "auto" | "formula" | "text"; source?: "pdf-region" | "clipboard"} = {},
): Promise<OcrFallbackResult> {
    const mode = options.mode || settings.ocrDefaultMode || "auto";
    const engines = enginesForMode(settings, mode);
    const attempts: OcrAttempt[] = [];
    if (!engines.length) {
        throw new OcrHttpError("没有可用的 OCR 引擎：请先在设置 → OCR 复制引擎包并选择服务目录");
    }
    for (const engine of engines) {
        const config = engineConfig(settings, engine);
        const bundleError = engineBundleError(settings, engine);
        if (bundleError) {
            attempts.push({engine, ok: false, skipped: bundleError});
            continue;
        }
        if (!config.dir.trim()) {
            attempts.push({engine, ok: false, skipped: "未配置服务目录"});
            continue;
        }
        const started = Date.now();
        const server = await ensureOcrEngine(settings, engine);
        if (!server.ok) {
            attempts.push({engine, ok: false, error: server.error || "服务不可用"});
            continue;
        }
        try {
            const result = await recognizeWithEngine(settings, engine, blob, {...options, mode});
            attempts.push({engine, ok: true, elapsedMs: Date.now() - started});
            return {result, engine, attempts};
        } catch (error: any) {
            attempts.push({engine, ok: false, error: error?.message || String(error)});
        }
    }
    throw new OcrHttpError(`OCR 识别失败 — ${summarizeAttempts(attempts)}`);
}
import {detectOcrBundle, isBundleCompatible} from "./bundles";
