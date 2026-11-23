import type {ItemMeta, PdfAttachment, ReadingStat, ReadingStatus} from "../types";
import type {Store} from "../storage";
import {annotationDensity, progressOf, statusOf} from "./stats";

/** Rating/remark key: the Zotero parent item key, or the attachment id for local PDFs. */
export function metaKeyForAttachment(attachment: PdfAttachment | undefined): string {
    if (!attachment) return "";
    return attachment.zotero?.itemKey || attachment.id;
}

/** The attachment that represents a Zotero item, if the user has opened it. */
export function attachmentForZoteroItem(store: Store, itemKey: string): PdfAttachment | undefined {
    return Object.values(store.state.attachments)
        .find(attachment => attachment.zotero?.itemKey === itemKey);
}

export function statForZoteroItem(store: Store, itemKey: string): ReadingStat | undefined {
    const attachment = attachmentForZoteroItem(store, itemKey);
    return attachment ? store.state.reading[attachment.id] : undefined;
}

export function statusForStat(store: Store, stat: ReadingStat | undefined): ReadingStatus {
    return statusOf(stat, {doneRatio: store.state.settings.readingDoneRatio});
}

export function completedRatio(store: Store): number {
    return store.state.settings.readingDoneRatio || 0.95;
}

export function progressForStat(stat: ReadingStat | undefined): number {
    return progressOf(stat);
}

export function densityForAttachment(store: Store, attachmentId: string): {density: number[]; pages: number} {
    const attachment = store.getAttachment(attachmentId);
    const pages = attachment ? (store.state.reading[attachment.id]?.pages || 0) : 0;
    const annotations = store.annotationsForAttachment(attachmentId);
    return {density: annotationDensity(annotations, pages), pages};
}

export function metaForItem(store: Store, key: string): ItemMeta | undefined {
    return store.itemMeta(key);
}
