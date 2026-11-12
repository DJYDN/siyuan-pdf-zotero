import * as pdfjsLib from "pdfjs-dist";
import {DEFAULT_ZOOM, PDFJS_ASSETS, PLUGIN_NAME} from "../constants";
import {pluginAssetUrl} from "../runtime";
import type {Annotation, NormalizedRect} from "../types";
import {rectStyle} from "../anchor";

export type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;

let workerConfigured = false;

/**
 * Electron throttles/suspends requestAnimationFrame when the window is occluded
 * or was created without a visible surface. PDF.js drives page.render() from rAF,
 * so rendering would otherwise stop forever at render-start. Use timers while the
 * document is not focused; normal foreground rendering keeps native rAF.
 */
function installRafFallback(): void {
    const target = window as any;
    if (target.__pzRafFallback) {
        return;
    }
    target.__pzRafFallback = true;
    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
        if (document.visibilityState === "visible" && document.hasFocus()) {
            return nativeRaf(callback);
        }
        return window.setTimeout(() => callback(performance.now()), 16);
    };
}

installRafFallback();

function ensureWorker(): void {
    if (workerConfigured) {
        return;
    }
    // The fake worker still imports workerSrc, so always set it.
    pdfjsLib.GlobalWorkerOptions.workerSrc = pluginAssetUrl(PDFJS_ASSETS.worker);
    workerConfigured = true;
}

export interface OpenedPdfDocument {
    pdf: PdfDocument;
    /** Destroys the loading task and terminates its PDF.js worker. */
    destroy: () => Promise<void>;
}

export async function openPdfDocument(bytes: Uint8Array): Promise<OpenedPdfDocument> {
    ensureWorker();
    const loadingTask = pdfjsLib.getDocument({
        data: bytes,
        cMapUrl: pluginAssetUrl(PDFJS_ASSETS.cmaps),
        cMapPacked: true,
        standardFontDataUrl: pluginAssetUrl(PDFJS_ASSETS.standardFonts),
        wasmUrl: pluginAssetUrl(PDFJS_ASSETS.wasm),
        iccUrl: pluginAssetUrl(PDFJS_ASSETS.iccs),
        useWorkerFetch: false,
    });
    const pdf = await loadingTask.promise;
    return {
        pdf,
        destroy: async () => {
            try {
                await loadingTask.destroy();
            } catch {
                // worker may already be gone
            }
        },
    };
}

export interface RenderedPageInfo {
    element: HTMLElement;
    pageNumber: number;
    width: number;
    height: number;
    rotation: number;
    viewport: any;
}

export interface RenderOptions {
    scale?: number;
    onPage?: (info: RenderedPageInfo) => void;
    onStage?: (stage: string) => void;
    signal?: AbortSignal;
}

export async function renderPage(pdf: PdfDocument, pageNumber: number, options: RenderOptions = {}): Promise<RenderedPageInfo> {
    const scale = options.scale || DEFAULT_ZOOM;
    options.onStage?.(`page-${pageNumber}-getPage-start`);
    const page = await pdf.getPage(pageNumber);
    options.onStage?.(`page-${pageNumber}-getPage-done`);
    const viewport = page.getViewport({scale});
    const rotation = page.rotate || 0;
    // Electron may report DPR=1 even when the app/UI is scaled. A modest
    // supersampling floor keeps small two-column journal text crisp without
    // changing CSS layout or PDF coordinates.
    const dpr = Math.min(2.5, Math.max(1.75, window.devicePixelRatio || 1));

    const pageElement = document.createElement("div");
    pageElement.className = "pz-page";
    pageElement.dataset.page = String(pageNumber);
    pageElement.dataset.rotation = String(rotation);
    pageElement.style.width = `${viewport.width}px`;
    pageElement.style.height = `${viewport.height}px`;
    pageElement.style.setProperty("--total-scale-factor", String(scale));
    pageElement.style.setProperty("--scale-round-x", "1px");
    pageElement.style.setProperty("--scale-round-y", "1px");

    const canvas = document.createElement("canvas");
    canvas.className = "pz-canvas";
    canvas.width = Math.ceil(viewport.width * dpr);
    canvas.height = Math.ceil(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    pageElement.append(canvas);

    const context = canvas.getContext("2d", {alpha: false});
    if (!context) {
        throw new Error("Canvas 2D context unavailable");
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    pageElement.dataset.outputScale = dpr.toFixed(2);
    pageElement.dataset.renderedZoom = scale.toFixed(4);
    pageElement.dataset.layoutScale = scale.toFixed(4);
    pageElement.dataset.baseWidth = (viewport.width / scale).toFixed(4);
    pageElement.dataset.baseHeight = (viewport.height / scale).toFixed(4);
    options.onStage?.(`page-${pageNumber}-render-start`);
    await page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    }).promise;
    options.onStage?.(`page-${pageNumber}-render-done`);

    const textLayerElement = document.createElement("div");
    textLayerElement.className = "textLayer pz-text-layer";
    textLayerElement.style.width = `${viewport.width}px`;
    textLayerElement.style.height = `${viewport.height}px`;
    pageElement.append(textLayerElement);
    options.onStage?.(`page-${pageNumber}-text-start`);
    const textContent = await page.getTextContent();
    options.onStage?.(`page-${pageNumber}-text-done`);
    const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayerElement,
        viewport,
    });
    await textLayer.render();
    options.onStage?.(`page-${pageNumber}-text-layer-done`);

    const overlay = document.createElement("div");
    overlay.className = "pz-overlay";
    pageElement.append(overlay);

    const searchLayer = document.createElement("div");
    searchLayer.className = "pz-search-layer";
    pageElement.append(searchLayer);

    const linksLayer = document.createElement("div");
    linksLayer.className = "pz-links";
    pageElement.append(linksLayer);

    const label = document.createElement("div");
    label.className = "pz-page-label";
    label.textContent = String(pageNumber);
    pageElement.append(label);

    const info = {
        element: pageElement,
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        rotation,
        viewport,
    };
    options.onPage?.(info);
    return info;
}

export function paintPageAnnotations(page: RenderedPageInfo, annotations: Annotation[]): void {
    const overlay = page.element.querySelector<HTMLElement>(".pz-overlay");
    if (!overlay) {
        return;
    }
    overlay.innerHTML = "";
    for (const annotation of annotations) {
        for (const rect of annotation.rects) {
            const el = document.createElement("div");
            el.className = "pz-highlight";
            const s = rectStyle(rect, page.width, page.height);
            el.style.left = s.left;
            el.style.top = s.top;
            el.style.width = s.width;
            el.style.height = s.height;
            el.style.backgroundColor = colorToRgba(annotation.color, 0.28);
            el.dataset.annotationId = annotation.id;
            overlay.append(el);
        }
    }
}

export function annotationAtPoint(page: RenderedPageInfo, annotations: Annotation[], x: number, y: number): Annotation | undefined {
    const nx = x / page.width;
    const ny = y / page.height;
    // Later annotations paint on top; return the last match.
    for (let i = annotations.length - 1; i >= 0; i--) {
        const annotation = annotations[i];
        if (annotation.rects.some((rect: NormalizedRect) =>
            nx >= rect.x && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h)) {
            return annotation;
        }
    }
    return undefined;
}

export function colorToRgba(hex: string, alpha: number): string {
    if (hex === "transparent") {
        return "transparent";
    }
    const value = hex.replace("#", "");
    const full = value.length === 3 ? value.split("").map(c => c + c).join("") : value;
    const num = Number.parseInt(full, 16);
    if (!Number.isFinite(num)) {
        return `rgba(255,216,77,${alpha})`;
    }
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r},${g},${b},${alpha})`;
}

export {pdfjsLib, PLUGIN_NAME};
