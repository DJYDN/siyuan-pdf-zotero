import {normalizeClientRect} from "../anchor";
import type {NormalizedRect} from "../types";

export interface SearchHit {
    page: number;
    rects: NormalizedRect[];
    text: string;
    index: number;
}

interface CharRef {
    node: Node;
    offset: number;
    ch: string;
}

function pageTextMap(pageElement: HTMLElement): {chars: CharRef[]; text: string} {
    const layer = pageElement.querySelector<HTMLElement>(".pz-text-layer") || pageElement;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    const chars: CharRef[] = [];
    let node: Node | null = walker.nextNode();
    while (node) {
        const value = node.nodeValue || "";
        for (let i = 0; i < value.length; i++) {
            chars.push({node, offset: i, ch: value[i]});
        }
        node = walker.nextNode();
    }
    return {chars, text: chars.map(item => item.ch).join("")};
}

function rangeForChars(chars: CharRef[], start: number, end: number): Range | null {
    const first = chars[start];
    const last = chars[end - 1];
    if (!first || !last) {
        return null;
    }
    try {
        const range = document.createRange();
        range.setStart(first.node, first.offset);
        range.setEnd(last.node, last.offset + 1);
        return range;
    } catch {
        return null;
    }
}

export function searchPage(
    pageElement: HTMLElement,
    pageNumber: number,
    query: string,
    maxHits = 80,
): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (needle.length < 1) {
        return [];
    }
    const {chars, text} = pageTextMap(pageElement);
    const haystack = text.toLowerCase();
    const pageRect = pageElement.getBoundingClientRect();
    const hits: SearchHit[] = [];
    let from = 0;
    while (hits.length < maxHits) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) {
            break;
        }
        const range = rangeForChars(chars, at, at + needle.length);
        if (!range) {
            break;
        }
        const rects: NormalizedRect[] = [];
        for (const clientRect of Array.from(range.getClientRects())) {
            const normalized = normalizeClientRect(clientRect, pageRect);
            if (normalized) {
                rects.push(normalized);
            }
        }
        if (rects.length) {
            hits.push({
                page: pageNumber,
                rects,
                text: text.slice(at, at + query.trim().length),
                index: at,
            });
        }
        from = at + Math.max(1, needle.length);
    }
    return hits;
}

export function searchPages(
    pages: Array<{element: HTMLElement; pageNumber: number}>,
    query: string,
    maxHits = 200,
): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const page of pages) {
        if (hits.length >= maxHits) {
            break;
        }
        hits.push(...searchPage(page.element, page.pageNumber, query, maxHits - hits.length));
    }
    return hits;
}
