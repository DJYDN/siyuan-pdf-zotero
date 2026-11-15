import type {OcrEngineId, Settings} from "../types";
import {
    engineConfig,
    needsLegacyUnimernetOptions,
    OCR_ENGINE_DEFS,
    serviceGroupForEngine,
    type OcrServiceGroup,
} from "./engines";

export interface OcrItem {
    type: "formula" | "text" | "mixed";
    latex: string;
    text: string;
    confidence: number;
    bbox?: {x: number; y: number; w: number; h: number};
}

export interface OcrResult {
    ok: boolean;
    kind: "formula" | "text" | "mixed";
    markdown: string;
    items: OcrItem[];
    elapsedMs?: number;
    engine?: string;
    /** Number of decoded tokens (Texo only). */
    tokens?: number;
    /** How decoding stopped: eos | limit | repeat (Texo only). */
    finish?: string;
    /** True when the engine hit its token limit or a safety guard. */
    truncated?: boolean;
    /** Optional engine notice, e.g. "Texo only supports formulas". */
    notice?: string;
}

export interface OcrHealth {
    ok: boolean;
    version?: string;
    engine?: string;
    modelReady?: boolean;
    capabilities?: {formula?: boolean; text?: boolean; mixed?: boolean};
    error?: string;
    pid?: number;
    missing?: string[];
}

export class OcrHttpError extends Error {
    constructor(message: string, readonly status = 0, readonly engine?: OcrEngineId) {
        super(message);
        this.name = "OcrHttpError";
    }
}

export function ocrBaseUrlForPort(port: number): string {
    return `http://127.0.0.1:${Number(port) || OCR_ENGINE_DEFS.pix2text.defaultPort}`;
}

/** Base URL of the service that hosts `engine` (engines sharing a directory share a port). */
export function ocrServiceUrl(settings: Settings, engine?: OcrEngineId): string {
    const id = engine || "pix2text";
    const group = serviceGroupForEngine(settings, id);
    const port = group?.port ?? engineConfig(settings, id).port ?? OCR_ENGINE_DEFS[id].defaultPort;
    return ocrBaseUrlForPort(port);
}

/** Legacy helper kept for callers that only know the old single-service settings. */
export function ocrBaseUrl(settings: Settings): string {
    return ocrServiceUrl(settings, "pix2text");
}

export async function getOcrHealth(settings: Settings, engine: OcrEngineId = "pix2text", timeoutMs = 4000): Promise<OcrHealth> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
    try {
        const response = await fetch(`${ocrServiceUrl(settings, engine)}/health`, {signal: controller.signal});
        const data = await response.json().catch((): any => ({}));
        return {
            ok: response.ok && data?.ok !== false,
            version: String(data?.version || ""),
            engine: String(data?.engine || ""),
            modelReady: data?.modelReady !== false,
            capabilities: data?.capabilities && typeof data.capabilities === "object" ? data.capabilities : undefined,
            error: response.ok ? String(data?.error || "") : `HTTP ${response.status}`,
            pid: Number.isFinite(Number(data?.pid)) ? Number(data.pid) : undefined,
            missing: Array.isArray(data?.missing) ? data.missing.map((item: any) => String(item)) : undefined,
        };
    } catch (error: any) {
        return {ok: false, error: error?.name === "AbortError" ? "OCR 服务连接超时" : (error?.message || String(error))};
    } finally {
        window.clearTimeout(timer);
    }
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error("读取 OCR 图片失败"));
        reader.readAsDataURL(blob);
    });
}

function requestOptions(settings: Settings, engine: OcrEngineId, group?: OcrServiceGroup): Record<string, unknown> {
    const options: Record<string, unknown> = {
        engine,
        device: settings.ocrDevice || "cpu",
        enableTable: Boolean(settings.ocrEnableTable),
        enableSpellChecker: settings.ocrEnableSpellChecker !== false,
        mfdModel: settings.ocrMfdModel || "mfd-1.5",
        mfrModel: settings.ocrMfrModel || "mfr-1.5",
        mfdStaticShape: settings.ocrMfdStaticShape || "",
        mfrContext: settings.ocrMfrContext || "",
        languages: settings.ocrLanguages?.length ? settings.ocrLanguages : ["zh", "en"],
    };
    if (engine === "unimernet" || needsLegacyUnimernetOptions(settings, group)) {
        options.unimernetPath = settings.unimernetPath || "";
        options.unimernetConfigPath = settings.unimernetConfigPath || "";
        options.unimernetDevice = settings.unimernetDevice || "auto";
    }
    return options;
}

export async function recognizeWithEngine(
    settings: Settings,
    engine: OcrEngineId,
    blob: Blob,
    options: {mode?: "auto" | "formula" | "text"; source?: "pdf-region" | "clipboard"} = {},
): Promise<OcrResult> {
    const imageBase64 = await blobToBase64(blob);
    const group = serviceGroupForEngine(settings, engine);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), Math.max(1000, Number(settings.ocrTimeoutMs) || 120_000));
    try {
        const response = await fetch(`${ocrServiceUrl(settings, engine)}/ocr`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            signal: controller.signal,
            body: JSON.stringify({
                imageBase64,
                mode: options.mode || settings.ocrDefaultMode || "auto",
                source: options.source || "pdf-region",
                languages: settings.ocrLanguages?.length ? settings.ocrLanguages : ["zh", "en"],
                formulaFormat: settings.ocrFormulaFormat || "inline",
                options: requestOptions(settings, engine, group),
            }),
        });
        const data = await response.json().catch((): any => ({}));
        if (!response.ok || data?.ok === false) {
            throw new OcrHttpError(String(data?.error || data?.message || `OCR HTTP ${response.status}`), response.status, engine);
        }
        const items: OcrItem[] = Array.isArray(data?.items) ? data.items.map((item: any) => ({
            type: item?.type === "text" ? "text" : "formula",
            latex: String(item?.latex || ""),
            text: String(item?.text || ""),
            confidence: Number(item?.confidence ?? item?.score ?? 0),
            bbox: item?.bbox && typeof item.bbox === "object" ? item.bbox : undefined,
        })) : [];
        return {
            ok: true,
            kind: data?.kind === "text" || data?.kind === "mixed" ? data.kind : "formula",
            markdown: String(data?.markdown || ""),
            items,
            elapsedMs: Number(data?.elapsedMs || 0),
            engine: String(data?.engine || engine),
            tokens: Number.isFinite(Number(data?.tokens)) ? Number(data.tokens) : undefined,
            finish: typeof data?.finish === "string" ? data.finish : undefined,
            truncated: Boolean(data?.truncated),
            notice: typeof data?.notice === "string" ? data.notice : undefined,
        };
    } catch (error: any) {
        if (error instanceof OcrHttpError) throw error;
        throw new OcrHttpError(error?.name === "AbortError" ? "OCR 识别超时" : (error?.message || String(error)), 0, engine);
    } finally {
        window.clearTimeout(timer);
    }
}

/**
 * Single-engine recognition using the default routing for the current mode.
 * Prefer `recognizeWithFallback` (in `ocr/service.ts`) inside the plugin.
 */
export async function recognizeImage(
    settings: Settings,
    blob: Blob,
    options: {mode?: "auto" | "formula" | "text"; source?: "pdf-region" | "clipboard"} = {},
): Promise<OcrResult> {
    const mode = options.mode || settings.ocrDefaultMode || "auto";
    const {enginesForMode} = await import("./engines");
    const engines = enginesForMode(settings, mode);
    if (!engines.length) {
        throw new OcrHttpError("没有可用的 OCR 引擎，请先在设置 → OCR 启用一个引擎并选择服务目录");
    }
    return recognizeWithEngine(settings, engines[0], blob, {...options, mode});
}

export function ocrItemsToMarkdown(result: OcrResult, formulaFormat: "inline" | "display"): string {
    if (result.markdown.trim()) return result.markdown.trim();
    return result.items.map(item => {
        if (item.type === "text") return item.text;
        const latex = (item.latex || item.text).trim();
        return formulaFormat === "display" ? `$$${latex}$$` : `$${latex}$`;
    }).filter(Boolean).join("\n\n");
}
