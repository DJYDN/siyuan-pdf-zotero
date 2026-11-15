import {
    fileExists,
    getPathForFile,
    joinPath,
    readFileBytes,
    readFileStat,
    sha256Hex,
} from "../runtime";
import type {PdfAttachment} from "../types";

export interface PickedPdf {
    file: File;
    path: string;
    fileName: string;
    bytes: Uint8Array;
    size: number;
    mtimeMs: number;
    fingerprint: string;
}

export async function pickPdfFile(): Promise<PickedPdf | null> {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/pdf,.pdf";
        input.style.position = "fixed";
        input.style.left = "-10000px";
        document.body.append(input);
        let settled = false;
        const finish = (value: PickedPdf | null) => {
            if (settled) {
                return;
            }
            settled = true;
            input.remove();
            resolve(value);
        };
        input.addEventListener("change", async () => {
            const file = input.files?.[0];
            if (!file) {
                finish(null);
                return;
            }
            try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const path = getPathForFile(file);
                let size = file.size;
                let mtimeMs = 0;
                if (path && fileExists(path)) {
                    const stat = await readFileStat(path);
                    size = stat.size || size;
                    mtimeMs = stat.mtimeMs;
                }
                finish({
                    file,
                    path,
                    fileName: file.name,
                    bytes,
                    size,
                    mtimeMs,
                    fingerprint: sha256Hex(bytes),
                });
            } catch (e) {
                console.error("[pdf-zotero] read picked PDF failed", e);
                finish(null);
            }
        });
        input.addEventListener("cancel", () => finish(null));
        input.click();
    });
}

export interface LoadedPdfBytes {
    bytes: Uint8Array;
    fingerprint: string;
    size: number;
    mtimeMs: number;
    changed: boolean;
}

async function readKernelFile(path: string): Promise<Uint8Array | null> {
    try {
        const token = String((window as any).siyuan?.config?.api?.token || "");
        const normalized = path.replaceAll("\\", "/");
        const workspacePath = normalized.match(/\/data\/(.+)$/);
        const candidates = Array.from(new Set([normalized, ...(workspacePath ? [`/data/${workspacePath[1]}`] : [])]));
        for (const candidate of candidates) {
            const response = await fetch("/api/file/getFile", {
                method: "POST",
                headers: {"Content-Type": "application/json", ...(token ? {Authorization: `Token ${token}`} : {})},
                body: JSON.stringify({path: candidate}),
            });
            if (!response.ok) continue;
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-") return bytes;
        }
        return null;
    } catch {
        return null;
    }
}

export async function loadAttachmentBytes(attachment: PdfAttachment): Promise<LoadedPdfBytes> {
    if (!attachment.path) {
        throw new Error("该 PDF 没有可访问的本地路径，请重新选择原文件");
    }
    if (!fileExists(attachment.path)) {
        const fallbackBytes = await readKernelFile(attachment.path);
        if (!fallbackBytes) {
            throw new Error(`PDF 文件不存在或不可访问：${attachment.path}`);
        }
        if (fallbackBytes.length < 5 || String.fromCharCode(...fallbackBytes.slice(0, 5)) !== "%PDF-") {
            throw new Error("文件不是有效的 PDF（缺少 %PDF- 头）");
        }
        const fingerprint = sha256Hex(fallbackBytes);
        return {
            bytes: fallbackBytes,
            fingerprint,
            size: fallbackBytes.length,
            mtimeMs: 0,
            changed: Boolean(attachment.fingerprint && attachment.fingerprint !== fingerprint),
        };
    }
    const stat = await readFileStat(attachment.path);
    const bytes = await readFileBytes(attachment.path);
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
        throw new Error("文件不是有效的 PDF（缺少 %PDF- 头）");
    }
    const fingerprint = sha256Hex(bytes);
    return {
        bytes,
        fingerprint,
        size: stat.size || bytes.length,
        mtimeMs: stat.mtimeMs,
        changed: Boolean(attachment.fingerprint && attachment.fingerprint !== fingerprint),
    };
}

export function defaultTitleFromFileName(fileName: string): string {
    return fileName.replace(/\.pdf$/i, "").trim() || fileName;
}

export function samePath(a: string, b: string): boolean {
    return joinPath(a).replaceAll("\\", "/").toLowerCase() === joinPath(b).replaceAll("\\", "/").toLowerCase();
}
