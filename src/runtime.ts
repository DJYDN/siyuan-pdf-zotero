import {PLUGIN_NAME} from "./constants";

declare global {
    interface Window {
        require?: (module: string) => any;
        siyuan?: any;
    }
}

export function requireNode(moduleName: string): any | null {
    try {
        const injected = (globalThis as any).__pzNodeRequire;
        if (typeof injected === "function") {
            return injected(moduleName);
        }
        if (typeof window !== "undefined" && typeof window.require === "function") {
            return window.require(moduleName);
        }
        // eslint-disable-next-line no-eval
        return (0, eval)("require")(moduleName);
    } catch {
        return null;
    }
}

export function hasNodeFs(): boolean {
    const fs = requireNode("fs");
    return Boolean(fs && typeof fs.promises?.readFile === "function");
}

export function sha256Hex(bytes: Uint8Array): string {
    const crypto = requireNode("crypto");
    if (crypto?.createHash) {
        return crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    }
    // Fallback for browser-only mode: non-cryptographic but deterministic fingerprint.
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16)}-${bytes.length}`;
}

export async function readFileBytes(filePath: string): Promise<Uint8Array> {
    const fs = requireNode("fs");
    if (!fs?.promises?.readFile) {
        throw new Error("当前运行环境没有 Node 文件读取能力（window.require('fs') 不可用）");
    }
    const buffer = await fs.promises.readFile(filePath);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export async function readFileStat(filePath: string): Promise<{size: number; mtimeMs: number}> {
    const fs = requireNode("fs");
    if (!fs?.promises?.stat) {
        return {size: 0, mtimeMs: 0};
    }
    const stat = await fs.promises.stat(filePath);
    return {size: stat.size, mtimeMs: stat.mtimeMs};
}

export function fileExists(filePath: string): boolean {
    const fs = requireNode("fs");
    if (!fs?.existsSync) {
        return false;
    }
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

export function getPathForFile(file: File): string {
    try {
        const electron = requireNode("electron");
        if (electron?.webUtils?.getPathForFile) {
            return electron.webUtils.getPathForFile(file) || "";
        }
    } catch {
        // ignore
    }
    return (file as File & {path?: string}).path || "";
}

export function joinPath(...parts: string[]): string {
    const path = requireNode("path");
    if (path?.join) {
        return path.join(...parts);
    }
    return parts.filter(Boolean).join("/").replaceAll("\\", "/");
}

export function pluginAssetUrl(file: string): string {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return new URL(`/plugins/${encodeURIComponent(PLUGIN_NAME)}/${file}`, origin).href;
}

export function siyuanDataDir(): string {
    return String(window.siyuan?.config?.system?.dataDir || "");
}

/** Read Zotero's data directory from its public prefs file (read-only). */
export function detectZoteroDataDir(): string {
    try {
        const fs = requireNode("fs");
        const os = requireNode("os");
        const path = requireNode("path");
        if (!fs || !os || !path) {
            return "";
        }
        const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
        const zoteroRoot = path.join(appData, "Zotero", "Zotero");
        const profilesFile = path.join(zoteroRoot, "profiles.ini");
        const candidates: string[] = [];
        if (fs.existsSync(profilesFile)) {
            const ini = fs.readFileSync(profilesFile, "utf-8");
            const matches = [...ini.matchAll(/Path=(.+)/g)];
            for (const match of matches) {
                candidates.push(path.join(zoteroRoot, match[1].trim()));
            }
        }
        const profilesDir = path.join(zoteroRoot, "Profiles");
        if (fs.existsSync(profilesDir)) {
            for (const name of fs.readdirSync(profilesDir)) {
                candidates.push(path.join(profilesDir, name));
            }
        }
        for (const profile of candidates) {
            const prefs = path.join(profile, "prefs.js");
            if (!fs.existsSync(prefs)) {
                continue;
            }
            const text = fs.readFileSync(prefs, "utf-8");
            const useDataDir = /user_pref\("extensions\.zotero\.useDataDir",\s*true\)/.test(text);
            const m = text.match(/user_pref\("extensions\.zotero\.dataDir",\s*"((?:\\.|[^"])*)"\)/);
            if (m && (useDataDir || m[1])) {
                return JSON.parse(`"${m[1]}"`);
            }
        }
    } catch (e) {
        console.warn("[pdf-zotero] detect Zotero data dir failed", e);
    }
    return "";
}

export function resolveZoteroAttachmentPath(options: {
    dataDir: string;
    attachmentKey: string;
    path?: string;
    filename?: string;
    enclosureHref?: string;
}): string {
    const raw = (options.path || "").trim();
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
        return raw;
    }
    if (raw.startsWith("storage:")) {
        return joinPath(options.dataDir, "storage", options.attachmentKey, raw.slice("storage:".length));
    }
    if (raw.startsWith("file://")) {
        try {
            const url = new URL(raw);
            let p = decodeURIComponent(url.pathname);
            if (/^\/[a-zA-Z]:/.test(p)) {
                p = p.slice(1);
            }
            return p.replaceAll("/", "\\");
        } catch {
            return "";
        }
    }
    if (options.enclosureHref?.startsWith("file://")) {
        return resolveZoteroAttachmentPath({...options, path: options.enclosureHref});
    }
    const filename = options.filename || raw;
    if (filename) {
        return joinPath(options.dataDir, "storage", options.attachmentKey, filename);
    }
    return "";
}

export function toFileUrl(filePath: string): string {
    const normalized = filePath.replaceAll("\\", "/");
    return `file:///${encodeURI(normalized).replace(/#/g, "%23")}`;
}

export function openExternalUrl(url: string): boolean {
    if (!/^(https?:|mailto:)/i.test(url)) {
        return false;
    }
    try {
        const electron = requireNode("electron");
        if (electron?.shell?.openExternal) {
            void electron.shell.openExternal(url);
            return true;
        }
    } catch {
        // fall through
    }
    try {
        window.open(url, "_blank", "noopener,noreferrer");
        return true;
    } catch {
        return false;
    }
}
