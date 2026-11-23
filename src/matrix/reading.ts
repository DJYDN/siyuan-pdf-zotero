import type {MatrixProject} from "../types";
import type {Store} from "../storage";
import {attachmentForZoteroItem, progressForStat, statusForStat} from "../reading";
import {formatJournalTags, normalizeJournalName} from "../reading/journal";
import {READING_STATUS_LABEL, formatDuration, relativeTime} from "../reading/stats";

/**
 * Fill the read-only reading columns from live plugin state.
 *
 * The values are derived, so they are recomputed on every render instead of
 * being persisted: a matrix opened a week later must show the current numbers.
 */
export function syncReadingValues(store: Store, project: MatrixProject): void {
    for (const row of project.rows) {
        const attachment = attachmentForZoteroItem(store, row.itemKey);
        const stat = attachment ? store.readingStat(attachment.id) : undefined;
        const progress = Math.round(progressForStat(stat) * 100);
        row.values.progress = stat && stat.totalSeconds ? `${progress}%` : "";
        row.values.dwell = stat && stat.totalSeconds ? formatDuration(stat.totalSeconds) : "";
        row.values.lastRead = stat?.lastReadAt ? relativeTime(stat.lastReadAt) : "";
        row.values.annotations = attachment ? String(store.annotationsForAttachment(attachment.id).length) : "0";
        row.values.readStatus = stat ? READING_STATUS_LABEL[statusForStat(store, stat)] : "未读";
        const venue = normalizeJournalName(String(row.values.venue || ""));
        const cached = venue ? store.journalEntry(venue) : undefined;
        row.values.journal = cached
            ? formatJournalTags(cached.fields, store.state.settings.journalMap, store.state.settings.journalFields)
            : "";
    }
}
