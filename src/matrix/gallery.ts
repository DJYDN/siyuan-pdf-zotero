import type {GalleryPrefs, MatrixColumn, MatrixProject, ReadingStatus} from "../types";

export type GalleryMode = "items" | "notes" | "annotations";
export type GalleryLayout = "vertical" | "horizontal";
export type GalleryGroupBy = "itemType" | "year" | "venue" | "rating" | "readStatus";
export type GalleryScope = "library" | "project";
export type GallerySettings = GalleryPrefs;

export const GALLERY_GROUP_OPTIONS: Array<{value: GalleryGroupBy; label: string; hint: string}> = [
    {value: "itemType", label: "条目类型", hint: "按期刊文章、会议论文等分列"},
    {value: "readStatus", label: "阅读进度", hint: "未读 / 在读 / 已读"},
    {value: "year", label: "发表年份", hint: "按发表年份分列"},
    {value: "venue", label: "期刊 / 出版物", hint: "同一期刊归到一列"},
    {value: "rating", label: "评分", hint: "按五星评级分列"},
];

const ITEM_TYPE_LABELS: Record<string, string> = {
    journalArticle: "期刊文章",
    conferencePaper: "会议论文",
    preprint: "预印本",
    thesis: "学位论文",
    bookSection: "图书章节",
    book: "图书",
    report: "报告",
    dataset: "数据集",
    webpage: "网页",
    magazineArticle: "杂志文章",
    newspaperArticle: "报纸文章",
    manuscript: "手稿",
    patent: "专利",
    computerProgram: "软件",
    artwork: "艺术品",
    document: "文档",
    encyclopediaArticle: "百科条目",
    film: "影片",
    hearing: "听证",
    interview: "访谈",
    letter: "信件",
    map: "地图",
    podcast: "播客",
    presentation: "演示",
    radioBroadcast: "广播",
    standard: "标准",
    statute: "法规",
    tvBroadcast: "电视节目",
    videoRecording: "视频",
};

export function itemTypeLabel(code: string): string {
    const key = String(code || "").trim();
    if (!key) return "其他";
    return ITEM_TYPE_LABELS[key] || key;
}

export const DEFAULT_GALLERY_SETTINGS: GallerySettings = {
    mode: "items",
    layout: "vertical",
    fields: ["journal", "readStatus"],
    sortColumn: "year",
    sortDirection: "desc",
    colorFilter: "",
    groupBy: "itemType",
    scope: "library",
    covers: true,
};

/** Merge persisted/legacy values with defaults; also used by the state migration. */
export function normalizeGallerySettings(raw: any): GallerySettings {
    const parsed = raw && typeof raw === "object" ? raw as Partial<GallerySettings> : {};
    const mode: GalleryMode = parsed.mode === "notes" || parsed.mode === "annotations" ? parsed.mode : "items";
    const groupBy = GALLERY_GROUP_OPTIONS.some(option => option.value === parsed.groupBy) ? parsed.groupBy as GalleryGroupBy : "itemType";
    return {
        mode,
        layout: parsed.layout === "horizontal" ? "horizontal" : "vertical",
        fields: Array.isArray(parsed.fields) ? parsed.fields.filter((item): item is string => typeof item === "string") : [...DEFAULT_GALLERY_SETTINGS.fields],
        sortColumn: typeof parsed.sortColumn === "string" ? parsed.sortColumn : DEFAULT_GALLERY_SETTINGS.sortColumn,
        sortDirection: parsed.sortDirection === "asc" ? "asc" : "desc",
        colorFilter: typeof parsed.colorFilter === "string" ? parsed.colorFilter : "",
        groupBy,
        scope: parsed.scope === "project" ? "project" : "library",
        covers: parsed.covers !== false,
    };
}

/** Resolve configured field ids to real columns, dropping stale ids. */
export function galleryFields(project: MatrixProject, settings: GallerySettings): MatrixColumn[] {
    const byId = new Map(project.columns.map(column => [column.id, column]));
    return settings.fields.map(id => byId.get(id)).filter((column): column is MatrixColumn => Boolean(column));
}

export const READING_STATUS_BY_LABEL: Record<string, ReadingStatus> = {
    未读: "unread",
    在读: "reading",
    已读: "done",
};

export function statusFromLabel(label: string): ReadingStatus | undefined {
    return READING_STATUS_BY_LABEL[String(label || "").trim()];
}

export function statusLabel(status: ReadingStatus | undefined): string {
    if (status === "done") return "已读";
    if (status === "reading") return "在读";
    if (status === "unread") return "未读";
    return "";
}
