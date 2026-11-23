import type {Annotation, ReadingStat, ReadingStatus} from "../types";

/** Below this many seconds a PDF counts as untouched, even if a page was opened. */
export const MIN_READING_SECONDS = 60;
export const DEFAULT_DONE_RATIO = 0.95;

export function createReadingStat(pages = 0, at = Date.now()): ReadingStat {
    return {
        pages: Math.max(0, Math.floor(pages)),
        dwell: {},
        visited: [],
        lastPage: 1,
        lastReadAt: at,
        totalSeconds: 0,
        days: {},
    };
}

/** Defensive normalization used by the state migration and by the tracker. */
export function normalizeReadingStat(raw: any): ReadingStat {
    const stat = createReadingStat(Number(raw?.pages) || 0, Number(raw?.lastReadAt) || Date.now());
    const dwell = raw?.dwell && typeof raw.dwell === "object" ? raw.dwell : {};
    for (const [page, seconds] of Object.entries<any>(dwell)) {
        const index = Number(page);
        const value = Number(seconds);
        if (!Number.isFinite(index) || index < 1 || !Number.isFinite(value) || value <= 0) continue;
        stat.dwell[String(Math.floor(index))] = Math.round(value);
    }
    const visited = Array.isArray(raw?.visited) ? raw.visited : Object.keys(stat.dwell);
    const pageNumbers: number[] = visited
        .map((page: any) => Math.floor(Number(page)))
        .filter((page: number) => Number.isFinite(page) && page >= 1);
    stat.visited = Array.from(new Set<number>(pageNumbers)).sort((a, b) => a - b);
    stat.lastPage = Math.max(1, Math.floor(Number(raw?.lastPage) || stat.visited[stat.visited.length - 1] || 1));
    stat.totalSeconds = Object.values(stat.dwell).reduce((sum, value) => sum + value, 0);
    const days = raw?.days && typeof raw.days === "object" ? raw.days : {};
    for (const [key, seconds] of Object.entries<any>(days)) {
        const value = Number(seconds);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Number.isFinite(value) || value <= 0) continue;
        stat.days[key] = Math.round(value);
    }
    if (raw?.manualStatus === "unread" || raw?.manualStatus === "reading" || raw?.manualStatus === "done") {
        stat.manualStatus = raw.manualStatus;
    }
    return stat;
}

/** Local calendar day key, e.g. 2026-11-22. */
export function dayKey(timestamp: number): string {
    const date = new Date(timestamp);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

export interface RecordReadingInput {
    page: number;
    pages?: number;
    seconds: number;
    at?: number;
}

/**
 * Apply one tracker tick. Returns a new object so the store can decide when to persist.
 */
export function recordReading(stat: ReadingStat, input: RecordReadingInput): ReadingStat {
    const seconds = Math.round(input.seconds);
    const page = Math.floor(input.page);
    if (!Number.isFinite(page) || page < 1 || !Number.isFinite(seconds) || seconds <= 0) {
        return stat;
    }
    const at = input.at ?? Date.now();
    const next: ReadingStat = {
        ...stat,
        dwell: {...stat.dwell},
        visited: stat.visited.includes(page) ? stat.visited : [...stat.visited, page].sort((a, b) => a - b),
        days: {...stat.days},
        pages: Math.max(stat.pages, Math.floor(Number(input.pages) || 0)),
        lastPage: page,
        lastReadAt: at,
        totalSeconds: stat.totalSeconds + seconds,
    };
    const key = String(page);
    next.dwell[key] = (next.dwell[key] || 0) + seconds;
    const day = dayKey(at);
    next.days[day] = (next.days[day] || 0) + seconds;
    return next;
}

/** Fraction of pages that were actually reached; 0 when the page count is unknown. */
export function progressOf(stat: ReadingStat | undefined): number {
    if (!stat || !stat.pages || stat.pages < 1) return 0;
    const touched = stat.visited.filter(page => page <= stat.pages).length;
    if (!touched) return 0;
    return Math.min(1, touched / stat.pages);
}

/** Highest page reached, useful for the "继续阅读" hint. */
export function furthestPage(stat: ReadingStat | undefined): number {
    if (!stat) return 1;
    return Math.max(1, stat.lastPage || 0, stat.visited[stat.visited.length - 1] || 0);
}

export interface StatusOptions {
    doneRatio?: number;
}

/**
 * Manual status wins. Otherwise: untouched -> unread, progress past the ratio -> done.
 */
export function statusOf(stat: ReadingStat | undefined, options: StatusOptions = {}): ReadingStatus {
    if (stat?.manualStatus) return stat.manualStatus;
    if (!stat || stat.totalSeconds < MIN_READING_SECONDS || !stat.visited.length) return "unread";
    const ratio = options.doneRatio && options.doneRatio > 0 && options.doneRatio <= 1
        ? options.doneRatio
        : DEFAULT_DONE_RATIO;
    return progressOf(stat) >= ratio ? "done" : "reading";
}

export const READING_STATUS_LABEL: Record<ReadingStatus, string> = {
    unread: "未读",
    reading: "在读",
    done: "已读",
};

/** How many annotations landed on each page. Index 0 is page 1. */
export function annotationDensity(annotations: Annotation[], pages: number): number[] {
    const total = Math.max(1, Math.floor(pages) || 1);
    const density = new Array<number>(total).fill(0);
    for (const annotation of annotations) {
        const page = Math.floor(Number(annotation.page));
        if (!Number.isFinite(page) || page < 1 || page > total) continue;
        density[page - 1] += 1;
    }
    return density;
}

export function formatDuration(seconds: number): string {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    if (value < 60) return `${value} 秒`;
    if (value < 3600) return `${Math.round(value / 60)} 分钟`;
    const hours = Math.floor(value / 3600);
    const minutes = Math.round((value % 3600) / 60);
    return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
    if (!timestamp) return "";
    const delta = now - timestamp;
    if (delta < 60_000) return "刚刚";
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
    if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
    const date = new Date(timestamp);
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** Total seconds per day across every PDF, newest day first. */
export function dailyTotals(stats: Array<ReadingStat | undefined>): Array<{day: string; seconds: number}> {
    const totals: Record<string, number> = {};
    for (const stat of stats) {
        if (!stat) continue;
        for (const [day, seconds] of Object.entries(stat.days || {})) {
            totals[day] = (totals[day] || 0) + seconds;
        }
    }
    return Object.entries(totals)
        .map(([day, seconds]) => ({day, seconds}))
        .sort((a, b) => b.day.localeCompare(a.day));
}
