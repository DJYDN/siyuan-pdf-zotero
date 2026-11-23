import type {PersistedState} from "../types";

export function normalizeDoi(value: string | undefined): string {
    return String(value || "")
        .toLowerCase()
        .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
        .replace(/^doi:\s*/, "")
        .trim();
}

export function normalizeTitle(value: string | undefined): string {
    return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export interface LocalTarget {
    kind: "zotero" | "attachment";
    id: string;
}

/**
 * Prefer a locally available PDF over opening the DOI landing page.
 *
 * Matching order:
 *  1. Zotero item with the same DOI (or full title) that has a cached PDF attachment;
 *  2. an already-imported attachment whose book title matches.
 */
export function findLocalTarget(state: PersistedState, paper: {doi?: string; title: string}): LocalTarget | null {
    const doi = normalizeDoi(paper.doi);
    const title = normalizeTitle(paper.title);
    const longEnoughTitle = title.length >= 12;
    const matches = (candidateDoi?: string, candidateTitle?: string): boolean => {
        if (doi && candidateDoi && normalizeDoi(candidateDoi) === doi) return true;
        if (longEnoughTitle && candidateTitle && normalizeTitle(candidateTitle) === title) return true;
        return false;
    };

    for (const item of state.zotero.items || []) {
        const csl = (item.csl || {}) as Record<string, any>;
        if (!matches(item.doi || csl.DOI, item.title || csl.title)) continue;
        const hasPdf = (state.zotero.attachments || []).some(attachment => attachment.parentItemKey === item.key);
        if (hasPdf) return {kind: "zotero", id: item.key};
    }

    for (const attachment of Object.values(state.attachments)) {
        const book = state.books[attachment.bookId];
        if (book && matches(undefined, book.title)) return {kind: "attachment", id: attachment.id};
    }
    return null;
}
