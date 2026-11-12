export type PdfSourceKind = "local" | "zotero";

export interface ZoteroIdentity {
    libraryId: number;
    itemKey: string;
    attachmentKey: string;
    attachmentTitle?: string;
    itemTitle?: string;
}

export interface Book {
    id: string;
    title: string;
    authors: string[];
    year?: string;
    source: PdfSourceKind;
    zoteroKey?: string;
    createdAt: number;
    updatedAt: number;
}

export interface PdfAttachment {
    id: string;
    bookId: string;
    /** Absolute path to the original PDF. P0 never copies or writes the source file. */
    path: string;
    source: PdfSourceKind;
    /** SHA-256 of the PDF bytes, used to detect content changes. */
    fingerprint: string;
    fileName: string;
    size: number;
    mtimeMs: number;
    isPrimary: boolean;
    zotero?: ZoteroIdentity;
    lastOpenedAt?: number;
    /** Last reading position, restored when no explicit page/annotation is supplied. */
    lastPage?: number;
    /** 0..1 scroll position within the page, useful for long pages. */
    scrollRatio?: number;
}

/** Normalized page coordinates, 0..1 relative to the unscaled PDF page box. */
export interface NormalizedRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Annotation {
    id: string;
    attachmentId: string;
    page: number;
    rects: NormalizedRect[];
    text: string;
    color: string;
    /** Page geometry at capture time, for diagnostics and future re-anchoring. */
    pageWidth: number;
    pageHeight: number;
    rotation: number;
    /** Optional translation attached to this annotation. */
    translation?: string;
    createdAt: number;
    updatedAt: number;
}

export interface NoteLink {
    id: string;
    annotationId: string;
    siyuanBlockId: string;
    siyuanDocId: string;
    createdAt: number;
}

export interface ScreenshotRegion {
    id: string;
    attachmentId: string;
    page: number;
    /** Normalized top-left page coordinates. */
    rect: NormalizedRect;
    /** Hex fill color used in the PDF reader. */
    color: string;
    colorId: string;
    assetPath: string;
    noteBlockId: string;
    noteDocId: string;
    label: string;
    createdAt: number;
}

export interface ZoteroCollection {
    key: string;
    name: string;
    parent?: string;
}

export interface ZoteroCacheItem {
    key: string;
    title: string;
    creators: string[];
    year: string;
    itemType: string;
    doi?: string;
    abstract?: string;
    collections: string[];
    /** Full CSL-JSON item, used by the citation engine. */
    csl?: Record<string, any>;
}

export interface ZoteroCachedAttachment {
    parentItemKey: string;
    attachmentKey: string;
    attachmentTitle: string;
    filename: string;
    rawPath: string;
    contentType: string;
    enclosureHref?: string;
}

export interface ZoteroCache {
    libraryId: number;
    dataDir: string;
    updatedAt: number;
    lastError: string;
    items: ZoteroCacheItem[];
    collections: ZoteroCollection[];
    /** Cached PDF attachment locations for offline opening. */
    attachments: ZoteroCachedAttachment[];
}

export type CitationStyle = "gbt7714" | "apa" | "ieee";

export interface CitationItemRef {
    libraryId: number;
    itemKey: string;
    csl: Record<string, any>;
}

export interface CitationOptions {
    locator?: string;
    prefix?: string;
    suffix?: string;
    suppressAuthor?: boolean;
}

export interface CitationRecord {
    id: string;
    siyuanDocId: string;
    siyuanBlockId: string;
    items: CitationItemRef[];
    style: CitationStyle;
    options: CitationOptions;
    visibleHtml: string;
    createdAt: number;
    updatedAt: number;
}

export interface ReferencesBlock {
    docId: string;
    headingBlockId: string;
    listBlockId: string;
    /** All block ids created by the markdown list (container + items), for clean refresh. */
    listBlockIds?: string[];
    style: CitationStyle;
    updatedAt: number;
}

export type PreviewTrigger = "hover" | "alt";

export type LinkCopyFormat = "quote" | "link" | "embed" | "callout" | "quote-callout" | "custom";
export type DisplayTextFormat = "title-page" | "page" | "text" | "emoji" | "none" | "custom";

export interface Settings {
    zoteroDataDir: string;
    zoteroBaseUrl: string;
    zoteroLibraryId: number;
    directFsRead: boolean;
    /** Hover preview trigger: direct hover, or Alt+hover. */
    previewTrigger: PreviewTrigger;
    /** Visible excerpt template. Supports {text}, {page}, {title}; the href stays structured. */
    excerptTemplate: string;
    defaultCitationStyle: CitationStyle;
    /** PDF++-style copy format: link, embed, callout, quote-in-callout. */
    linkCopyFormat: LinkCopyFormat;
    /** PDF++-style display text: page, text, emoji, none, custom. */
    displayTextFormat: DisplayTextFormat;
    displayTextTemplate: string;
    linkCopyTemplate: string;
    /** PDF++ pencil toggle. Disabled by default because it changes the source PDF. */
    writePdfAnnotations: boolean;
    /** Selection translation. */
    translationEnabled: boolean;
    translationAuto: boolean;
    translationMinChars: number;
    translationTargetLang: string;
    translationShowOriginal: boolean;
    translationActiveServiceId: string;
    translationServices: TranslationServiceConfig[];
    /** Whole-document PDF translation through a local PDF2zh server. */
    pdf2zhBaseUrl: string;
    /** Optional portable server folder; used to auto-start PDF2zh. */
    pdf2zhServerPath: string;
    pdf2zhEngine: "pdf2zh" | "pdf2zh_next";
    pdf2zhService: string;
    pdf2zhTargetLang: string;
    pdf2zhOutputMode: "mono" | "dual";
    pdf2zhDualMode: "LR" | "TB";
    /** Whole-document translation provider. */
    wholeTranslationProvider: "pdf2zh" | "doc2x";
    /** Doc2X CLI, authenticated by the user's own Doc2X account. */
    doc2xCommand: string;
    doc2xAuthMode: "oauth" | "client";
    doc2xTargetLang: string;
    doc2xModel: string;
    doc2xOutputMode: "dualPdf" | "translatedPdf";
    doc2xTermId: string;
    doc2xFontColor: boolean;
    doc2xFontStrategy: "global-consistent" | "page-optimal";
    doc2xIgnoreTypes: string[];
    doc2xContextual: boolean;
    /** Empty means plugin data translations directory. */
    translationOutputDir: string;
    /** PDF Q&A. */
    qaTitle: string;
    qaModelId: string;
    qaContextPages: number;
    qaHistoryDays: number;
    qaKnowledgeMode: "auto" | "pdf";
    qaSessionListPlacement: "panel" | "drawer";
    qaMaxThreadsPerPdf: number;
    qaBlockRadius: number;
    qaBlockBorderColor: string;
    qaBlockBackground: string;
    qaTitleColor: string;
    qaQuestionColor: string;
    qaAnswerColor: string;
    qaFontFamily: string;
    qaQuestionFontSize: number;
    qaAnswerFontSize: number;
    qaPanelWidth: number;
    qaPanelHeight: number;
    /** Hidden notebook automation: summarize new docs and maintain an index table. */
    automationEnabled: boolean;
    automationNotebookId: string;
    automationIndexTitle: string;
    automationBackfill: boolean;
    /** Empty means use SiYuan's currently selected AI model. */
    automationModelId: string;
    automationMaxChars: number;
    automationDebug: boolean;
}

export type TranslationServiceType =
    | "siyuan-ai"
    | "openai"
    | "deepl"
    | "google"
    | "baidu"
    | "youdao"
    | "tencent"
    | "aliyun"
    | "azure"
    | "caiyun";

export interface TranslationServiceConfig {
    id: string;
    type: TranslationServiceType;
    name: string;
    enabled: boolean;
    baseURL: string;
    apiKey: string;
    model: string;
}

export interface TranslationOutput {
    id: string;
    path: string;
    fileName: string;
    provider: "doc2x" | "pdf2zh" | "unknown";
    mode: string;
    targetLang: string;
    sourceAttachmentId?: string;
    sourceTitle?: string;
    createdAt: number;
}

export interface QaAttachment {
    id: string;
    name: string;
    path: string;
    mime: string;
    size: number;
}

export interface QaMessage {
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt: number;
    sources: number[];
    attachments: QaAttachment[];
}

export interface QaThread {
    id: string;
    attachmentId: string;
    fingerprint: string;
    title: string;
    pinned?: boolean;
    createdAt: number;
    updatedAt: number;
    messages: QaMessage[];
}

export interface QaConversation {
    attachmentId: string;
    fingerprint?: string;
    updatedAt: number;
    messages: QaMessage[];
}

export interface ReaderSessionState {
    /** Whether at least one PDF reader tab was open when the workspace snapshot was saved. */
    open: boolean;
    activeAttachmentId: string;
    readerAttachmentIds: string[];
}

export interface PersistedState {
    version: number;
    books: Record<string, Book>;
    attachments: Record<string, PdfAttachment>;
    annotations: Record<string, Annotation>;
    noteLinks: Record<string, NoteLink>;
    screenshotRegions: Record<string, ScreenshotRegion>;
    recentAttachmentIds: string[];
    zotero: ZoteroCache;
    translationOutputs: Record<string, TranslationOutput>;
    qaConversations: Record<string, QaConversation>;
    qaThreads: Record<string, QaThread>;
    qaActiveThread: Record<string, string>;
    settings: Settings;
    citations: Record<string, CitationRecord>;
    references: Record<string, ReferencesBlock>;
    /** Last PDF opened; used for the recent list, not for automatic startup. */
    lastReaderAttachmentId: string;
    /** Exact open-PDF tabs at the last workspace snapshot. */
    readerSession: ReaderSessionState;
}

export interface OpenAnnotationPayload {
    attachmentId: string;
    page?: number;
    annotationId?: string;
}

export interface ReaderOpenData extends OpenAnnotationPayload {
    title?: string;
    /** PDF-space x1,y1,x2,y2 used for transient screenshot back-jump highlighting. */
    targetRect?: [number, number, number, number];
    targetColor?: string;
    targetRegionId?: string;
}

export interface SelectionAnchor {
    page: number;
    rects: NormalizedRect[];
    text: string;
    pageWidth: number;
    pageHeight: number;
    rotation: number;
}

export interface ZoteroItemRecord {
    key: string;
    version: number;
    data: Record<string, any>;
    meta?: Record<string, any>;
    links?: Record<string, any>;
}
