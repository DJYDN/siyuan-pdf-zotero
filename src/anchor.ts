import {ANNOTATION_ROUTE, PLUGIN_NAME} from "./constants";
import type {NormalizedRect, SelectionAnchor} from "./types";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function normalizeClientRect(
    rect: {left: number; top: number; width: number; height: number},
    pageRect: {left: number; top: number; width: number; height: number},
): NormalizedRect | null {
    if (pageRect.width <= 0 || pageRect.height <= 0 || rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    const x = (rect.left - pageRect.left) / pageRect.width;
    const y = (rect.top - pageRect.top) / pageRect.height;
    const w = rect.width / pageRect.width;
    const h = rect.height / pageRect.height;
    if (w <= 0 || h <= 0) {
        return null;
    }
    const x1 = clamp(x, 0, 1);
    const y1 = clamp(y, 0, 1);
    const x2 = clamp(x + w, 0, 1);
    const y2 = clamp(y + h, 0, 1);
    if (x2 - x1 <= 0.0001 || y2 - y1 <= 0.0001) {
        return null;
    }
    return {x: x1, y: y1, w: x2 - x1, h: y2 - y1};
}

export function rectsFromSelection(
    range: Range,
    pageElement: HTMLElement,
    meta: {page: number; pageWidth: number; pageHeight: number; rotation: number},
): SelectionAnchor | null {
    const text = range.toString().replace(/\s+/g, " ").trim();
    if (!text) {
        return null;
    }
    const pageRect = pageElement.getBoundingClientRect();
    const rects: NormalizedRect[] = [];
    for (const clientRect of Array.from(range.getClientRects())) {
        // A range can cross page boundaries. A rect from another page must not
        // be normalized against this page or it becomes a random box.
        if (clientRect.bottom < pageRect.top || clientRect.top > pageRect.bottom
            || clientRect.right < pageRect.left || clientRect.left > pageRect.right) {
            continue;
        }
        const normalized = normalizeClientRect(clientRect, pageRect);
        if (normalized) {
            rects.push(normalized);
        }
    }
    if (!rects.length) return null;
    // PDF text layers frequently return several overlapping client rects for
    // one visual line (glyph spans, marked-content spans, ligatures). Painting
    // each one separately makes the same color look darker in overlap areas.
    const merged: NormalizedRect[] = [];
    for (const rect of rects.sort((a, b) => a.y - b.y || a.x - b.x)) {
        const existing = merged.find(item => {
            const overlap = Math.min(item.y + item.h, rect.y + rect.h) - Math.max(item.y, rect.y);
            const sameLine = overlap >= Math.min(item.h, rect.h) * 0.55;
            const horizontalGap = Math.max(rect.x - (item.x + item.w), item.x - (rect.x + rect.w), 0);
            return sameLine && horizontalGap <= 0.008;
        });
        if (!existing) {
            merged.push({...rect});
            continue;
        }
        const x2 = Math.max(existing.x + existing.w, rect.x + rect.w);
        const y2 = Math.max(existing.y + existing.h, rect.y + rect.h);
        existing.x = Math.min(existing.x, rect.x);
        existing.y = Math.min(existing.y, rect.y);
        existing.w = x2 - existing.x;
        existing.h = y2 - existing.y;
    }
    return {...meta, text, rects: merged};
}

export function annotationHref(annotationId: string, pluginName = PLUGIN_NAME): string {
    return `siyuan://plugins/${pluginName}/${ANNOTATION_ROUTE}?id=${encodeURIComponent(annotationId)}`;
}

export function pdfPageHref(
    attachmentId: string,
    page: number,
    rect?: {x: number; y: number; w: number; h: number},
    color = "yellow",
    pluginName = PLUGIN_NAME,
): string {
    const base = `siyuan://plugins/${pluginName}/pdf?id=${encodeURIComponent(attachmentId)}&page=${Math.max(1, Math.round(page))}`;
    if (!rect) {
        return base;
    }
    const values = [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h]
        .map(value => Number(value.toFixed(4)).toString())
        .join(",");
    return `${base}&rect=${values}&color=${encodeURIComponent(color)}`;
}

export interface ParsedPluginUrl {
    pluginName: string;
    route: string;
    id: string;
    page?: number;
    rect?: [number, number, number, number];
    color?: string;
    regionId?: string;
}

/** Parse the custom URL emitted by SiYuan's open-siyuan-url-plugin event. */
export function parsePluginUrl(raw: string, expectedPlugin = PLUGIN_NAME): ParsedPluginUrl | null {
    if (!raw || !raw.startsWith("siyuan://plugins/")) {
        return null;
    }
    try {
        const url = new URL(raw);
        const parts = url.pathname.split("/").filter(Boolean);
        // siyuan://plugins/<pluginName>/<route>  => host=plugins, path=/<pluginName>/<route>
        if (url.host !== "plugins" || parts.length < 2) {
            return null;
        }
        const pluginName = decodeURIComponent(parts[0]);
        if (pluginName !== expectedPlugin) {
            return null;
        }
        const page = Number.parseInt(url.searchParams.get("page") || "", 10);
        const rectValues = (url.searchParams.get("rect") || "").split(",").map(Number);
        const rect = rectValues.length === 4 && rectValues.every(Number.isFinite)
            ? rectValues as [number, number, number, number]
            : undefined;
        const color = url.searchParams.get("color") || "";
        const regionId = url.searchParams.get("region") || "";
        return {
            pluginName,
            route: decodeURIComponent(parts.slice(1).join("/")),
            id: url.searchParams.get("id") || "",
            ...(Number.isFinite(page) ? {page} : {}),
            ...(rect ? {rect} : {}),
            ...(color ? {color} : {}),
            ...(regionId ? {regionId} : {}),
        };
    } catch {
        return null;
    }
}

export function rectStyle(rect: NormalizedRect, width: number, height: number): {
    left: string;
    top: string;
    width: string;
    height: string;
} {
    return {
        left: `${rect.x * width}px`,
        top: `${rect.y * height}px`,
        width: `${rect.w * width}px`,
        height: `${rect.h * height}px`,
    };
}
