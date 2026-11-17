import {fileExists, requireNode} from "../runtime";
import {normalizeDirKey} from "./engines";
import type {OcrEngineId} from "../types";

export type OcrBundleKind = "texo" | "unimernet" | "pix2text" | "legacy" | "unknown";

export interface OcrBundleInfo {
    kind: OcrBundleKind;
    dir: string;
    /** Port declared by the bundle's config.json (fallback to engine default). */
    port?: number;
    script: string;
    label: string;
    /** Engine ids that this bundle can actually serve. */
    compatible: OcrEngineId[];
}

const KIND_LABELS: Record<OcrBundleKind, string> = {
    texo: "Texo 公式引擎包",
    unimernet: "UniMERNet 公式引擎包",
    pix2text: "Pix2Text 引擎包",
    legacy: "旧版共用服务（Pix2Text + UniMERNet）",
    unknown: "未识别的目录",
};

const KIND_COMPATIBLE: Record<OcrBundleKind, OcrEngineId[]> = {
    texo: ["texo"],
    unimernet: ["unimernet"],
    pix2text: ["pix2text"],
    legacy: ["pix2text", "unimernet"],
    unknown: [],
};

function fsApi(): any {
    return requireNode("fs");
}

function pathApi(): any {
    return requireNode("path");
}

export function isDirectory(dir: string): boolean {
    const fs = fsApi();
    try {
        return Boolean(dir) && Boolean(fs?.existsSync?.(dir)) && Boolean(fs?.statSync?.(dir).isDirectory?.());
    } catch {
        return false;
    }
}

function readConfig(dir: string): Record<string, any> {
    const fs = fsApi();
    const path = pathApi();
    if (!fs || !path) return {};
    try {
        const file = path.join(dir, "config.json");
        if (!fs.existsSync(file)) return {};
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return {};
    }
}

export function readBundlePort(dir: string): number | undefined {
    const raw = Number.parseInt(String(readConfig(dir).port ?? ""), 10);
    return Number.isFinite(raw) && raw > 0 && raw < 65536 ? raw : undefined;
}

function has(dir: string, relative: string): boolean {
    const fs = fsApi();
    const path = pathApi();
    if (!fs?.existsSync || !path?.join) return false;
    try {
        return Boolean(fs.existsSync(path.join(dir, relative)));
    } catch {
        return false;
    }
}

export function detectOcrBundle(dir: string): OcrBundleInfo {
    const trimmed = String(dir || "").trim();
    if (!trimmed || !isDirectory(trimmed)) {
        return {kind: "unknown", dir: trimmed, script: "", label: KIND_LABELS.unknown, compatible: []};
    }
    const port = readBundlePort(trimmed);
    const config = readConfig(trimmed);
    const modelDir = String(config.modelDir || "").toLowerCase();
    let kind: OcrBundleKind = "unknown";
    let script = "";
    if (has(trimmed, "service.py")) {
        script = "service.py";
        if (has(trimmed, "texo_engine.py") || has(trimmed, "models/onnx") || modelDir.includes("onnx")) {
            kind = "texo";
        } else if (has(trimmed, "models/unimernet_base") || modelDir.includes("unimernet")) {
            kind = "unimernet";
        } else if (has(trimmed, "userprofile") || modelDir.includes("userprofile")) {
            kind = "pix2text";
        } else {
            kind = "unknown";
        }
    } else if (has(trimmed, "pz_ocr_server.py")) {
        kind = "legacy";
        script = "pz_ocr_server.py";
    }
    return {kind, dir: trimmed, port, script, label: KIND_LABELS[kind], compatible: KIND_COMPATIBLE[kind]};
}

export function isBundleCompatible(bundle: OcrBundleInfo, engine: OcrEngineId): boolean {
    return bundle.compatible.includes(engine);
}

export function detectPdf2zhServer(dir: string): boolean {
    const trimmed = String(dir || "").trim();
    if (!trimmed || !isDirectory(trimmed)) return false;
    return has(trimmed, "pz_server.py");
}

export interface DiscoveredBundles {
    ocr: Partial<Record<OcrBundleKind, string>>;
    pdf2zh: string[];
}

/** Shallow scan of the given roots (and their direct children) for known service bundles. */
export function discoverBundles(roots: string[], maxDirs = 400): DiscoveredBundles {
    const fs = fsApi();
    const path = pathApi();
    const result: DiscoveredBundles = {ocr: {}, pdf2zh: []};
    if (!fs || !path) return result;
    const queue: Array<{dir: string; depth: number}> = [];
    const seen = new Set<string>();
    for (const root of roots) {
        const trimmed = String(root || "").trim();
        if (!trimmed || !isDirectory(trimmed)) continue;
        queue.push({dir: trimmed, depth: 0});
        try {
            for (const entry of fs.readdirSync(trimmed, {withFileTypes: true})) {
                if (entry.isDirectory?.()) queue.push({dir: path.join(trimmed, entry.name), depth: 1});
            }
        } catch {
            // unreadable root
        }
    }
    let visited = 0;
    while (queue.length && visited < maxDirs) {
        const {dir, depth} = queue.shift()!;
        const key = normalizeDirKey(dir);
        if (seen.has(key)) continue;
        seen.add(key);
        visited += 1;
        const bundle = detectOcrBundle(dir);
        if (bundle.kind !== "unknown" && !result.ocr[bundle.kind]) {
            result.ocr[bundle.kind] = dir;
        }
        if (detectPdf2zhServer(dir) && !result.pdf2zh.includes(dir)) {
            result.pdf2zh.push(dir);
        }
        if (depth >= 2) continue;
        try {
            for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
                if (!entry.isDirectory?.()) continue;
                const name = String(entry.name || "");
                if (name === "node_modules" || name === ".git" || name === "runtime" || name === "userprofile") continue;
                queue.push({dir: path.join(dir, name), depth: depth + 1});
            }
        } catch {
            // skip unreadable
        }
    }
    return result;
}

const LOG_FILES = ["portable-err.log", "server-error.log", "start-error.log", "error.log"];

/** Tail of the most relevant service log, used to explain start failures in the settings UI. */
export function readBundleLogTail(dir: string, maxLines = 10): string {
    const fs = fsApi();
    const path = pathApi();
    if (!fs || !path || !dir) return "";
    const files: string[] = [];
    for (const name of LOG_FILES) {
        const file = path.join(dir, name);
        if (fileExists(file)) files.push(file);
    }
    try {
        const logsDir = path.join(dir, "logs");
        if (fs.existsSync(logsDir)) {
            for (const entry of fs.readdirSync(logsDir)) {
                if (/\.log$/i.test(entry)) files.push(path.join(logsDir, entry));
            }
        }
    } catch {
        // no logs directory
    }
    for (const file of files) {
        try {
            const text = String(fs.readFileSync(file, "utf8"));
            const lines = text.split(/\r?\n/).filter(line => line.trim());
            if (lines.length) {
                return lines.slice(-maxLines).join("\n");
            }
        } catch {
            // try next file
        }
    }
    return "";
}
