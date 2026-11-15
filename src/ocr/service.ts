import {fileExists, requireNode} from "../runtime";
import type {Settings} from "../types";
import {getOcrHealth, ocrBaseUrl} from "./client";

export interface OcrEnvironmentCheck {
    ok: boolean;
    checks: Array<{label: string; ok: boolean; detail: string}>;
    python?: string;
    script?: string;
    health?: {ok: boolean; version?: string; modelReady?: boolean; error?: string};
}

export interface OcrServerPaths {
    root: string;
    python: string;
    script: string;
    models: string;
}

function resolvePaths(settings: Settings): OcrServerPaths {
    const path = requireNode("path");
    const root = String(settings.ocrServerPath || "").trim();
    const candidates = root
        ? [
            path.join(root, "runtime", "python.exe"),
            path.join(root, "build", "runtime", "python.exe"),
            path.join(root, "python.exe"),
        ]
        : [];
    return {
        root,
        python: candidates.find(candidate => fileExists(candidate)) || "",
        script: root ? path.join(root, "pz_ocr_server.py") : "",
        models: root ? path.join(root, "models") : "",
    };
}

export function ocrLogDir(settings: Settings): string {
    const path = requireNode("path");
    const root = String(settings.ocrServerPath || "").trim();
    return root ? path.join(root, "logs") : "";
}

export async function checkOcrEnvironment(settings: Settings): Promise<OcrEnvironmentCheck> {
    const checks: OcrEnvironmentCheck["checks"] = [];
    const paths = resolvePaths(settings);
    const add = (label: string, ok: boolean, detail: string) => checks.push({label, ok, detail});
    add("服务目录", Boolean(paths.root && fileExists(paths.root)), paths.root || "未选择 OCR 服务目录");
    const startable = Boolean(paths.python || settings.ocrStartCommand?.trim());
    add("Python 运行时", startable, paths.python || (settings.ocrStartCommand?.trim() ? "使用自定义启动命令" : "未找到 runtime/python.exe"));
    add("服务脚本", Boolean(paths.script && fileExists(paths.script)), paths.script || "未找到 pz_ocr_server.py");
    if (settings.ocrEngine === "unimernet") {
        const root = String(settings.unimernetPath || "").trim();
        add("UniMERNet 目录", Boolean(root && fileExists(root)), root || "未选择 UniMERNet 解压目录");
    }
    const health = await getOcrHealth(settings);
    add("服务状态", health.ok, health.ok ? `已运行${health.version ? `（${health.version}）` : ""}` : (health.error || "未运行"));
    if (health.ok) {
        add("模型状态", health.modelReady !== false, health.modelReady === false ? "模型未就绪" : "模型已就绪");
    }
    return {ok: checks.every(item => item.ok), checks, python: paths.python, script: paths.script, health};
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

export async function ensureOcrServer(settings: Settings): Promise<{ok: boolean; started: boolean; error?: string}> {
    const health = await getOcrHealth(settings);
    if (health.ok) return {ok: true, started: false};
    const paths = resolvePaths(settings);
    if (!paths.root) return {ok: false, started: false, error: "未配置 OCR 服务目录"};
    if (!settings.ocrAutoStart) return {ok: false, started: false, error: "OCR 服务未运行，且未开启自动启动"};
    const cp = requireNode("child_process");
    const fs = requireNode("fs");
    if (!cp?.spawn) return {ok: false, started: false, error: "当前环境没有 child_process"};
    fs?.mkdirSync?.(ocrLogDir(settings), {recursive: true});
    let child: any;
    try {
        if (settings.ocrStartCommand?.trim()) {
            child = cp.spawn(settings.ocrStartCommand.trim(), {
                cwd: paths.root,
                shell: true,
                detached: true,
                windowsHide: true,
                stdio: "ignore",
            });
        } else {
            if (!paths.python) return {ok: false, started: false, error: "未找到 OCR Python 运行时"};
            if (!paths.script || !fileExists(paths.script)) return {ok: false, started: false, error: "未找到 pz_ocr_server.py"};
            child = cp.spawn(paths.python, [paths.script, String(Number(settings.ocrPort) || 8891)], {
                cwd: paths.root,
                detached: true,
                windowsHide: true,
                stdio: "ignore",
            });
        }
        child.unref?.();
    } catch (error: any) {
        return {ok: false, started: false, error: error?.message || String(error)};
    }
    for (let attempt = 0; attempt < 40; attempt++) {
        await sleep(500);
        const current = await getOcrHealth(settings);
        if (current.ok) return {ok: true, started: true};
    }
    return {ok: false, started: true, error: `OCR 服务启动超时：${ocrBaseUrl(settings)}`};
}
