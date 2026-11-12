import type {PdfDocument} from "./pdfjs";
import type {NormalizedRect} from "../types";

export interface OutlineEntry {
    title: string;
    page: number;
    depth: number;
}

export async function loadOutline(pdf: PdfDocument): Promise<OutlineEntry[]> {
    let outline: any[] | null = null;
    try {
        outline = await pdf.getOutline();
    } catch {
        return [];
    }
    if (!outline?.length) {
        return [];
    }
    const result: OutlineEntry[] = [];
    const walk = async (items: any[], depth: number) => {
        for (const item of items) {
            const page = await resolveDestinationPage(pdf, item.dest);
            if (page) {
                result.push({title: String(item.title || "(无标题)"), page, depth});
            }
            if (item.items?.length) {
                await walk(item.items, depth + 1);
            }
        }
    };
    await walk(outline, 0);
    return result;
}

/** Resolve a PDF destination (array / name / ref) to a 1-based page number. */
export async function resolveDestinationPage(pdf: PdfDocument, dest: any): Promise<number | null> {
    if (!dest) {
        return null;
    }
    let value = dest;
    if (typeof value === "string") {
        try {
            value = await pdf.getDestination(value);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(value) || !value.length) {
        return null;
    }
    const ref = value[0];
    try {
        const index = await pdf.getPageIndex(ref);
        return index + 1;
    } catch {
        // Some destinations are explicit page numbers/offsets.
        if (typeof ref === "number" && ref >= 0 && ref < pdf.numPages) {
            return Math.floor(ref) + 1;
        }
        return null;
    }
}

export interface PdfLinkBox {
    rect: NormalizedRect;
    page?: number;
    url?: string;
    title: string;
}

export async function getLinkBoxes(
    pdf: PdfDocument,
    page: any,
    pageNumber: number,
    viewport: any,
): Promise<PdfLinkBox[]> {
    let annotations: any[] = [];
    try {
        annotations = await page.getAnnotations({intent: "display"});
    } catch {
        return [];
    }
    const result: PdfLinkBox[] = [];
    for (const annotation of annotations) {
        if (annotation?.subtype !== "Link" || !Array.isArray(annotation.rect)) {
            continue;
        }
        let pageTarget: number | null = null;
        if (annotation.dest) {
            pageTarget = await resolveDestinationPage(pdf, annotation.dest);
        }
        const url = annotation.url || annotation.unsafeUrl || "";
        if (!pageTarget && !url) {
            continue;
        }
        // PageViewport exposes convertToViewportPoint, not convertToViewportRectangle.
        const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
        const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const right = Math.max(x1, x2);
        const bottom = Math.max(y1, y2);
        const rect = {
            x: left / viewport.width,
            y: top / viewport.height,
            w: (right - left) / viewport.width,
            h: (bottom - top) / viewport.height,
        };
        if (rect.w <= 0 || rect.h <= 0) {
            continue;
        }
        result.push({
            rect,
            page: pageTarget || undefined,
            url: url || undefined,
            title: pageTarget ? `跳转到第 ${pageTarget} 页` : String(url),
        });
    }
    return result;
}
