import type {Settings} from "../types";

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
}

export class OcrHttpError extends Error {
    constructor(message: string, readonly status = 0) {
        super(message);
        this.name = "OcrHttpError";
    }
}

export function ocrBaseUrl(settings: Settings): string {
    const port = Number(settings.ocrPort) || 8891;
    return `http://127.0.0.1:${port}`;
}

export async function getOcrHealth(settings: Settings): Promise<{ok: boolean; version?: string; modelReady?: boolean; error?: string}> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 4000);
    try {
        const response = await fetch(`${ocrBaseUrl(settings)}/health`, {signal: controller.signal});
        const data = await response.json().catch((): any => ({}));
        return {
            ok: response.ok && data?.ok !== false,
            version: String(data?.version || ""),
            modelReady: data?.modelReady !== false,
            error: response.ok ? String(data?.error || "") : `HTTP ${response.status}`,
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

export async function recognizeImage(
    settings: Settings,
    blob: Blob,
    options: {mode?: "auto" | "formula" | "text"; source?: "pdf-region" | "clipboard"} = {},
): Promise<OcrResult> {
    const imageBase64 = await blobToBase64(blob);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), Math.max(1000, Number(settings.ocrTimeoutMs) || 120_000));
    try {
        const response = await fetch(`${ocrBaseUrl(settings)}/ocr`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            signal: controller.signal,
            body: JSON.stringify({
                imageBase64,
                mode: options.mode || settings.ocrDefaultMode || "auto",
                source: options.source || "pdf-region",
                languages: settings.ocrLanguages?.length ? settings.ocrLanguages : ["zh", "en"],
                formulaFormat: settings.ocrFormulaFormat || "inline",
                options: {
                    engine: settings.ocrEngine || "pix2text",
                    unimernetPath: settings.unimernetPath || "",
                    unimernetConfigPath: settings.unimernetConfigPath || "",
                    unimernetDevice: settings.unimernetDevice || "auto",
                    device: settings.ocrDevice || "cpu",
                    enableTable: Boolean(settings.ocrEnableTable),
                    enableSpellChecker: settings.ocrEnableSpellChecker !== false,
                    mfdModel: settings.ocrMfdModel || "mfd-1.5",
                    mfrModel: settings.ocrMfrModel || "mfr-1.5",
                    mfdStaticShape: settings.ocrMfdStaticShape || "",
                    mfrContext: settings.ocrMfrContext || "",
                    languages: settings.ocrLanguages?.length ? settings.ocrLanguages : ["zh", "en"],
                },
            }),
        });
        const data = await response.json().catch((): any => ({}));
        if (!response.ok || data?.ok === false) {
            throw new OcrHttpError(String(data?.error || data?.message || `OCR HTTP ${response.status}`), response.status);
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
            engine: String(data?.engine || ""),
        };
    } catch (error: any) {
        if (error instanceof OcrHttpError) throw error;
        throw new OcrHttpError(error?.name === "AbortError" ? "OCR 识别超时" : (error?.message || String(error)));
    } finally {
        window.clearTimeout(timer);
    }
}

export function ocrItemsToMarkdown(result: OcrResult, formulaFormat: "inline" | "display"): string {
    if (result.markdown.trim()) return result.markdown.trim();
    return result.items.map(item => {
        if (item.type === "text") return item.text;
        const latex = (item.latex || item.text).trim();
        return formulaFormat === "display" ? `$$${latex}$$` : `$${latex}$`;
    }).filter(Boolean).join("\n\n");
}
