import {newId} from "../storage";
import type {Store} from "../storage";
import type {OcrHistoryEntry, OcrHistoryEntry as OcrEntry} from "../types";

export type {OcrHistoryEntry};

export function ocrHistoryEntries(store: Store): OcrHistoryEntry[] {
    return [...(store.state.ocrHistory || [])].sort((a, b) => b.createdAt - a.createdAt);
}

export async function addOcrHistory(
    store: Store,
    entry: Omit<OcrHistoryEntry, "id" | "createdAt" | "favorite">,
): Promise<OcrHistoryEntry> {
    const record: OcrHistoryEntry = {
        ...entry,
        id: newId("ocr"),
        createdAt: Date.now(),
        favorite: false,
    };
    store.state.ocrHistory = [record, ...(store.state.ocrHistory || [])];
    await pruneOcrHistory(store);
    await store.save();
    return record;
}

export async function pruneOcrHistory(store: Store): Promise<void> {
    const limit = Math.max(1, Number(store.state.settings.ocrHistoryLimit) || 50);
    const entries = store.state.ocrHistory || [];
    const favorites = entries.filter(entry => entry.favorite);
    const regular = entries.filter(entry => !entry.favorite).sort((a, b) => b.createdAt - a.createdAt);
    const keep = new Set([...favorites, ...regular.slice(0, Math.max(0, limit - favorites.length))].map(entry => entry.id));
    store.state.ocrHistory = entries.filter(entry => keep.has(entry.id));
}

export async function toggleOcrFavorite(store: Store, id: string): Promise<void> {
    const entry = (store.state.ocrHistory || []).find(item => item.id === id);
    if (!entry) return;
    entry.favorite = !entry.favorite;
    await store.save();
}

export async function removeOcrHistory(store: Store, id: string): Promise<void> {
    store.state.ocrHistory = (store.state.ocrHistory || []).filter(item => item.id !== id);
    await store.save();
}

export async function clearOcrHistory(store: Store, keepFavorites = true): Promise<void> {
    store.state.ocrHistory = keepFavorites
        ? (store.state.ocrHistory || []).filter(item => item.favorite)
        : [];
    await store.save();
}

/** Update a history record after the user edits the OCR preview. */
export async function updateOcrHistory(store: Store, id: string, patch: Partial<OcrEntry>): Promise<void> {
    const entry = (store.state.ocrHistory || []).find(item => item.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    await store.save();
}
