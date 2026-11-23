import {fileExists, requireNode} from "../runtime";
import type {OcrEngineId, Settings} from "../types";
import {
    enabledEngineIds,
    engineConfig,
    enginesForMode,
    formulaEngineOrder,
    OCR_ENGINE_DEFS,
    OCR_ENGINE_IDS,
    serviceGroupForEngine,
    serviceGroups,
    type OcrServiceGroup,
} from "./engines";
import {
    getOcrHealth,
    ocrServiceUrl,
    recognizeWithEngine,
    warmupOcrEngine,
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

function resolveScriptInDir(dir: string, candidates: string[]): string {
    const path = requireNode("path");
    if (!path?.join) {
        return "";
    }
    for (const script of candidates) {
        const candidate = path.join(dir, script);
        if (fileExists(candidate)) {
            return candidate;
        }
    }
    return "";
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
    const config = engineConfig(settings, engine);
    const group = serviceGroupForEngine(settings, engine);
    if (!group) {
        // Disabled engines are not part of any service group, but the settings page must
        // still be able to inspect their directory/script/runtime before enabling them.
        const dir = config.dir.trim();
        if (!dir) {
            return {dir: "", python: "", script: "", port: config.port};
        }
        const python = pythonCandidates(settings, dir).find(fileExists) || "";
        const script = resolveScriptInDir(dir, OCR_ENGINE_DEFS[engine].scriptCandidates)
            || (engine !== "texo" ? resolveScriptInDir(dir, ["pz_ocr_server.py"]) : "");
        return {dir, python, script, port: config.port};
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
    const configured = (OCR_ENGINE_IDS as OcrEngineId[]).filter((id: OcrEngineId) => {
        const config = engineConfig(settings, id);
        return config.enabled || Boolean(config.dir.trim());
    });
    const engines = configured.length ? configured : serviceGroups(settings).flatMap(group => group.engines);
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

async function waitForService(settings: Settings, engine: OcrEngineId, timeoutMs: number): Promise<OcrHealth> {
    const started = Date.now();
    let last: OcrHealth = {ok: false, error: "OCR 服务连接超时"};
    while (Date.now() - started < timeoutMs) {
        await sleep(2000);
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

type EnsureOcrResult = {ok: boolean; started: boolean; error?: string; pid?: number};
const ensureInflight = new Map<OcrEngineId, Promise<EnsureOcrResult>>();

async function ensureOcrEngineOnce(settings: Settings, engine: OcrEngineId): Promise<EnsureOcrResult> {
    const bundleError = engineBundleError(settings, engine);
    if (bundleError) {
        return {ok: false, started: false, error: bundleError};
    }
    let started = false;
    let health = await getOcrHealth(settings, engine);
    if (!health.ok) {
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
            started = true;
        } catch (error: any) {
            return {ok: false, started: false, error: error?.message || String(error)};
        }
        const timeout = START_TIMEOUT_MS[engine] || 40_000;
        health = await waitForService(settings, engine, timeout);
        if (!health.ok) {
            return {ok: false, started: true, error: `OCR 服务启动超时：${ocrServiceUrl(settings, engine)}${health.error ? `（${health.error}）` : ""}`};
        }
    }
    // Service is alive. Older packages report no modelReady/loading fields; treat them as ready.
    if (health.modelReady !== false && !health.loading) {
        return {ok: true, started, pid: health.pid};
    }
    // Model is still loading: ask the service to finish loading once (single heavy operation).
    const timeout = START_TIMEOUT_MS[engine] || 40_000;
    const warmed = await warmupOcrEngine(settings, engine, timeout);
    if (warmed.ok) {
        return {ok: true, started, pid: warmed.pid || health.pid};
    }
    // Backward compatibility: pre-0.9.63 packages have no /warmup endpoint; the OCR call itself loads the model.
    if (/HTTP 404/.test(warmed.error || "")) {
        return {ok: true, started, pid: health.pid};
    }
    return {ok: false, started, error: warmed.error || "OCR 模型加载失败"};
}

/** Single-flight: concurrent OCR / prewarm / detection calls share one startup. */
export function ensureOcrEngine(settings: Settings, engine: OcrEngineId): Promise<EnsureOcrResult> {
    const existing = ensureInflight.get(engine);
    if (existing) {
        return existing;
    }
    const promise = ensureOcrEngineOnce(settings, engine).finally(() => {
        if (ensureInflight.get(engine) === promise) {
            ensureInflight.delete(engine);
        }
    });
    ensureInflight.set(engine, promise);
    return promise;
}

/** Preferred engines to warm on startup: first formula engine + the text engine. */
export function ocrPrewarmTargets(settings: Settings): OcrEngineId[] {
    const enabled = enabledEngineIds(settings);
    const targets: OcrEngineId[] = [];
    const formula = formulaEngineOrder(settings).find(id => enabled.includes(id));
    if (formula) {
        targets.push(formula);
    }
    const textPreferred = enabled.includes(settings.ocrTextEngine as OcrEngineId)
        ? settings.ocrTextEngine as OcrEngineId
        : enabled.find(id => OCR_ENGINE_DEFS[id].capabilities.text);
    if (textPreferred && !targets.includes(textPreferred)) {
        targets.push(textPreferred);
    }
    return targets;
}

export async function prewarmOcr(settings: Settings): Promise<Array<{engine: OcrEngineId; ok: boolean; error?: string}>> {
    const targets = ocrPrewarmTargets(settings);
    const results = await Promise.all(targets.map(async engine => {
        const result = await ensureOcrEngine(settings, engine);
        return {engine, ok: result.ok, error: result.error};
    }));
    return results;
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
        if (engines.indexOf(engine) > 0) {
            const health = await getOcrHealth(settings, engine);
            if (!health.ok || health.modelReady === false) {
                attempts.push({engine, ok: false, skipped: "未预热，已跳过（不自动冷启动备用引擎）"});
                continue;
            }
        } else {
            const server = await ensureOcrEngine(settings, engine);
            if (!server.ok) {
                attempts.push({engine, ok: false, error: server.error || "服务不可用"});
                continue;
            }
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
