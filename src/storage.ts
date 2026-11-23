import type {Plugin} from "siyuan";
import {MATRIX_MIGRATION_BACKUP_KEY, MATRIX_SCHEMA_VERSION, STATE_VERSION, STORAGE_KEY} from "./constants";
import {defaultTranslationServices} from "./translation/defaults";
import {migrateMatrixProject} from "./matrix/model";
import {normalizeGallerySettings} from "./matrix/gallery";
import {normalizeReadingStat} from "./reading/stats";
import {normalizeEngineMap} from "./ocr/engines";
import type {
    Annotation,
    Book,
    ItemMeta,
    JournalEntry,
    NoteLink,
    PdfAttachment,
    PersistedState,
    ReadingStat,
    Settings,
    QaMessage,
    QaThread,
    ScreenshotRegion,
    TranslationOutput,
    ZoteroCache,
} from "./types";

const now = () => Date.now();

function migrateQaThreads(raw: any): Record<string, QaThread> {
    if (raw.qaThreads && typeof raw.qaThreads === "object") {
        return raw.qaThreads;
    }
    const threads: Record<string, QaThread> = {};
    const conversations = raw.qaConversations && typeof raw.qaConversations === "object" ? raw.qaConversations : {};
    for (const [attachmentId, value] of Object.entries<any>(conversations)) {
        const messages: QaMessage[] = Array.isArray(value?.messages) ? value.messages : [];
        if (!messages.length) continue;
        const firstQuestion = messages.find(message => message.role === "user")?.text || "PDF 对话";
        const id = `qa-thread-${attachmentId}`;
        threads[id] = {
            id,
            attachmentId,
            fingerprint: String(value?.fingerprint || raw.attachments?.[attachmentId]?.fingerprint || ""),
            title: firstQuestion.replace(/\s+/g, " ").slice(0, 40) || "PDF 对话",
            createdAt: Number(messages[0]?.createdAt) || now(),
            updatedAt: Number(value?.updatedAt) || now(),
            messages,
        };
    }
    return threads;
}

function migrateReading(raw: any): Record<string, ReadingStat> {
    const reading: Record<string, ReadingStat> = {};
    if (!raw || typeof raw !== "object") return reading;
    for (const [attachmentId, value] of Object.entries<any>(raw)) {
        if (!attachmentId) continue;
        reading[attachmentId] = normalizeReadingStat(value);
    }
    return reading;
}

function migrateCoverCrop(raw: any): Record<string, number> | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const crop: Record<string, number> = {};
    for (const [key, value] of Object.entries<any>(raw)) {
        const number = Number(value);
        if (!key || !Number.isFinite(number)) continue;
        crop[key] = Math.min(100, Math.max(0, number));
    }
    return Object.keys(crop).length ? crop : undefined;
}

function migrateItemMeta(raw: any): Record<string, ItemMeta> {
    const meta: Record<string, ItemMeta> = {};
    if (!raw || typeof raw !== "object") return meta;
    for (const [key, value] of Object.entries<any>(raw)) {
        if (!key || !value || typeof value !== "object") continue;
        const rating = Number(value.rating);
        const remark = typeof value.remark === "string" ? value.remark : "";
        if (!Number.isFinite(rating) && !remark) continue;
        meta[key] = {
            ...(Number.isFinite(rating) && rating > 0 ? {rating: Math.min(5, Math.max(1, Math.round(rating)))} : {}),
            ...(remark ? {remark} : {}),
            updatedAt: Number(value.updatedAt) || Date.now(),
        };
    }
    return meta;
}

export function newId(prefix: string): string {
    const cryptoObj = globalThis.crypto as Crypto | undefined;
    const uuid = cryptoObj?.randomUUID ? cryptoObj.randomUUID() : `${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${uuid}`;
}

export function defaultState(): PersistedState {
    return {
        version: STATE_VERSION,
        books: {},
        attachments: {},
        annotations: {},
        noteLinks: {},
        screenshotRegions: {},
        recentAttachmentIds: [],
        translationOutputs: {},
        ocrHistory: [],
        matrixProjects: [],
        matrixActiveProjectId: "",
        noteTemplates: [],
        templateNotes: {},
        pinnedZoteroKeys: [],
        qaConversations: {},
        qaThreads: {},
        qaActiveThread: {},
        zotero: {
            libraryId: 0,
            dataDir: "",
            updatedAt: 0,
            lastError: "",
            items: [],
            collections: [],
            attachments: [],
        },
        settings: {
            zoteroDataDir: "",
            zoteroBaseUrl: "http://127.0.0.1:23119",
            zoteroLibraryId: 0,
            zoteroOfflineSqlite: true,
            directFsRead: true,
            previewTrigger: "hover",
            excerptTemplate: "{text}",
            defaultCitationStyle: "gbt7714",
            linkCopyFormat: "link",
            displayTextFormat: "text",
            displayTextTemplate: "{{file}}, p.{{page}}",
            linkCopyTemplate: "{{linkWithDisplay}}",
            writePdfAnnotations: false,
            automationEnabled: false,
            automationNotebookId: "20261106222046-58z8mvd",
            automationIndexTitle: "📚 网页资源 · 文章索引",
            automationBackfill: true,
            automationModelId: "",
            automationMaxChars: 450,
            automationDebug: false,
            readingTrackEnabled: true,
            readingIdleSeconds: 120,
            readingDoneRatio: 0.95,
            journalApiKey: "",
            journalFields: "sci,sciif,eii",
            journalMap: "SCIIF=IF, SCI=, EI检索=EI",
            openAlexApiKey: "",
            translationEnabled: true,
            translationAuto: true,
            translationMinChars: 2,
            translationTargetLang: "zh-CN",
            translationDefaultTargetLang: "zh-CN",
            translationShowOriginal: true,
            translationActiveServiceId: "translation-bing",
            translationServices: defaultTranslationServices(),
            pdf2zhBaseUrl: "http://127.0.0.1:8890",
            pdf2zhServerPath: "",
            pdf2zhEngine: "pdf2zh",
            pdf2zhService: "bing",
        pdf2zhSourceLang: "en",
            pdf2zhTargetLang: "zh-CN",
            pdf2zhOutputMode: "dual",
            pdf2zhDualMode: "LR",
            wholeTranslationProvider: "doc2x",
            doc2xCommand: "doc2x",
            doc2xAuthMode: "oauth",
            doc2xConfigured: true,
            doc2xTargetLang: "zh",
            doc2xModel: "",
            doc2xOutputMode: "dualPdf",
            doc2xTranslateType: "pdf",
            doc2xParseImageModel: "doc2x",
            doc2xVisionModel: "",
            doc2xParseHistoryLimit: 50,
            doc2xParseHistoryMaxMB: 2048,
            doc2xTermId: "",
            doc2xFontColor: false,
            doc2xFontStrategy: "global-consistent",
            doc2xIgnoreTypes: [],
            doc2xContextual: false,
            translationOutputDir: "",
            ocrServerPath: "",
            ocrPort: 8891,
            ocrAutoStart: true,
            ocrStartCommand: "",
            ocrLanguages: ["zh", "en"],
            ocrDefaultMode: "auto",
            ocrFormulaFormat: "inline",
            ocrDefaultAction: "insert",
            ocrHistoryLimit: 50,
            ocrPreview: true,
            ocrPrewarm: true,
            ocrMaxImageEdge: 2200,
            ocrDevice: "cpu",
            ocrEnableTable: false,
            ocrEnableSpellChecker: true,
            ocrMfdModel: "mfd-1.5",
            ocrMfrModel: "mfr-1.5",
            ocrMfdStaticShape: "",
            ocrMfrContext: "",
            ocrTimeoutMs: 120000,
            ocrEngine: "pix2text",
            unimernetPath: "",
            unimernetConfigPath: "",
            unimernetDevice: "auto",
            ocrEngines: {
                pix2text: {enabled: true, dir: "", port: 8891, autoStart: true},
                unimernet: {enabled: false, dir: "", port: 8892, autoStart: true},
                texo: {enabled: false, dir: "", port: 8893, autoStart: true},
            },
            ocrSharedRuntimeDir: "",
            ocrFormulaOrder: ["texo", "unimernet", "pix2text"],
            ocrTextEngine: "pix2text",
            ocrPreviewRenderer: "katex",
            ocrAutoCopy: false,
            ocrAutoCopyFormat: "latex",
            noteTemplateActiveId: "",
            noteTemplateNotebookId: "",
            noteTemplateFolder: "",
            noteTitlePattern: "{{year}}-{{firstAuthor}}-{{shortTitle}}",
            qaTitle: "PDF 问答",
            qaModelId: "",
            qaContextPages: 2,
            qaHistoryDays: 15,
            qaKnowledgeMode: "auto",
            qaSessionListPlacement: "panel",
            qaMaxThreadsPerPdf: 50,
            qaBlockRadius: 8,
            qaBlockBorderColor: "#d7dcef",
            qaBlockBackground: "#f7f8fd",
            qaTitleColor: "#4f63d2",
            qaQuestionColor: "#2563eb",
            qaAnswerColor: "#15803d",
            qaFontFamily: "",
            qaQuestionFontSize: 13,
            qaAnswerFontSize: 14,
            qaPanelWidth: 360,
            qaPanelHeight: 560,
        },
        citations: {},
        references: {},
        lastReaderAttachmentId: "",
        readerSession: {
            open: false,
            activeAttachmentId: "",
            readerAttachmentIds: [],
        },
        reading: {},
        itemMeta: {},
        journalCache: {},
    };
}

/**
 * Structured plugin-private state. Every mutation is persisted through the public
 * Plugin.saveData() API; the original PDF and Zotero SQLite are never written.
 */
const BACKUP_KEYS = ["state-backup-1", "state-backup-2"];

export class Store {
    state: PersistedState = defaultState();
    recoveredFromBackup = "";
    lastBackupAt = 0;
    private saving: Promise<unknown> = Promise.resolve();

    constructor(private readonly plugin: Plugin) {
    }

    async load(): Promise<void> {
        let raw: any;
        try {
            raw = await this.plugin.loadData(STORAGE_KEY);
        } catch (e) {
            console.warn("[pdf-zotero] loadData failed", e);
        }
        let parsed: PersistedState | null = null;
        try {
            const rawForMatrix = raw && typeof raw === "object" ? raw : null;
            const needsMatrixMigration = rawForMatrix && Array.isArray(rawForMatrix.matrixProjects)
                && rawForMatrix.matrixProjects.some((project: any) => Number(project?.schemaVersion || 0) < MATRIX_SCHEMA_VERSION);
            if (needsMatrixMigration) {
                await this.plugin.saveData(MATRIX_MIGRATION_BACKUP_KEY, rawForMatrix);
            }
            parsed = this.parseState(raw);
        } catch (error) {
            console.warn("[pdf-zotero] matrix migration failed", error);
        }
        if (parsed) {
            this.state = parsed;
            await this.writeBackup(raw);
            return;
        }
        for (const key of [...BACKUP_KEYS, MATRIX_MIGRATION_BACKUP_KEY]) {
            try {
                const backup = await this.plugin.loadData(key);
                const recovered = this.parseState(backup);
                if (recovered) {
                    this.state = recovered;
                    this.recoveredFromBackup = key;
                    console.warn(`[pdf-zotero] recovered state from ${key}`);
                    await this.plugin.saveData(STORAGE_KEY, this.state);
                    return;
                }
            } catch {
                // try next backup
            }
        }
    }

    private parseState(raw: any): PersistedState | null {
        if (raw && typeof raw === "object" && raw.version) {
            return this.migrate(raw);
        }
        if (typeof raw === "string" && raw.trim().startsWith("{")) {
            try {
                return this.migrate(JSON.parse(raw));
            } catch {
                return null;
            }
        }
        return null;
    }

    async writeBackup(raw: any = this.state): Promise<void> {
        try {
            const previous = await this.plugin.loadData(BACKUP_KEYS[0]).catch((): any => null);
            if (previous) {
                await this.plugin.saveData(BACKUP_KEYS[1], previous);
            }
            await this.plugin.saveData(BACKUP_KEYS[0], raw);
            this.lastBackupAt = Date.now();
        } catch (e) {
            console.warn("[pdf-zotero] backup failed", e);
        }
    }

    async backupNow(): Promise<void> {
        await this.writeBackup(this.state);
    }

    /**
     * Drop local books that no attachment references any more.
     *
     * Each E2E run imports a fresh fixture copy, and the cleanup removes that
     * attachment, which used to leave the sibling book record behind forever.
     * Zotero-sourced books are kept so cached metadata survives file moves.
     */
    async pruneOrphanBooks(): Promise<number> {
        const used = new Set(Object.values(this.state.attachments).map(attachment => attachment.bookId));
        const orphans = Object.entries(this.state.books)
            .filter(([id, book]) => !used.has(id) && book.source === "local")
            .map(([id]) => id);
        for (const id of orphans) {
            delete this.state.books[id];
        }
        return orphans.length;
    }

    private migrate(raw: Partial<PersistedState>): PersistedState {
        const base = defaultState();
        const settings = {...base.settings, ...(raw.settings || {})};
        // v4: single shared OCR service -> per-engine sidecars. Preserve the old
        // layout by pointing Pix2Text/UniMERNet at the same legacy service directory.
        const rawSettings = (raw.settings && typeof raw.settings === "object" ? raw.settings : {}) as Record<string, any>;
        const persistedEngines = rawSettings.ocrEngines && typeof rawSettings.ocrEngines === "object" ? rawSettings.ocrEngines : null;
        settings.ocrEngines = normalizeEngineMap(persistedEngines, settings);
        if (!Array.isArray(settings.ocrFormulaOrder) || !settings.ocrFormulaOrder.length) {
            settings.ocrFormulaOrder = ["texo", "unimernet", "pix2text"];
        }
        if (!Array.isArray(settings.translationServices) || !settings.translationServices.length) {
            settings.translationServices = defaultTranslationServices();
        }
        // Shared translation target language; older snapshots only had per-engine values.
        if (!settings.translationDefaultTargetLang) {
            settings.translationDefaultTargetLang = settings.translationTargetLang || "zh-CN";
        }
        for (const service of settings.translationServices) {
            if (service.type === "bing" && /cn\.bing\.com/i.test(service.baseURL || "")) {
                service.baseURL = "https://www.bing.com/translator";
            }
        }
        for (const fallbackService of defaultTranslationServices()) {
            if (!settings.translationServices.some(item => item.type === fallbackService.type)) {
                settings.translationServices.push({...fallbackService});
            }
        }
        // v3 replaces the generic "PDF page screenshot" title with a compact,
        // source-identifying caption so equal page numbers remain distinguishable.
        if (Number(raw.version || 0) < 3) {
            settings.displayTextFormat = "text";
        }
        return {
            ...base,
            ...raw,
            version: STATE_VERSION,
            books: raw.books || {},
            attachments: raw.attachments || {},
            annotations: raw.annotations || {},
            noteLinks: raw.noteLinks || {},
            screenshotRegions: raw.screenshotRegions || {},
            recentAttachmentIds: Array.isArray(raw.recentAttachmentIds) ? raw.recentAttachmentIds : [],
            translationOutputs: raw.translationOutputs && typeof raw.translationOutputs === "object" ? raw.translationOutputs : {},
            ocrHistory: Array.isArray(raw.ocrHistory) ? raw.ocrHistory : [],
            matrixProjects: (Array.isArray(raw.matrixProjects) ? raw.matrixProjects : []).map(item => migrateMatrixProject(item).project),
            matrixActiveProjectId: typeof raw.matrixActiveProjectId === "string" ? raw.matrixActiveProjectId : "",
            noteTemplates: Array.isArray(raw.noteTemplates) ? raw.noteTemplates : [],
            templateNotes: raw.templateNotes && typeof raw.templateNotes === "object" ? raw.templateNotes : {},
            pinnedZoteroKeys: Array.isArray(raw.pinnedZoteroKeys) ? raw.pinnedZoteroKeys : [],
            qaConversations: raw.qaConversations && typeof raw.qaConversations === "object" ? raw.qaConversations : {},
            qaThreads: migrateQaThreads(raw),
            qaActiveThread: raw.qaActiveThread && typeof raw.qaActiveThread === "object" ? raw.qaActiveThread : {},
            zotero: {
                ...base.zotero,
                ...(raw.zotero || {}),
                collections: raw.zotero?.collections || [],
                attachments: Array.isArray(raw.zotero?.attachments) ? raw.zotero.attachments : [],
            },
            settings,
            citations: raw.citations || {},
            references: raw.references || {},
            lastReaderAttachmentId: raw.lastReaderAttachmentId || "",
            readerSession: {
                open: Boolean(raw.readerSession?.open),
                activeAttachmentId: String(raw.readerSession?.activeAttachmentId || ""),
                readerAttachmentIds: Array.isArray(raw.readerSession?.readerAttachmentIds)
                    ? raw.readerSession.readerAttachmentIds.filter((id): id is string => typeof id === "string" && Boolean(id))
                    : [],
            },
            reading: migrateReading(raw.reading),
            itemMeta: migrateItemMeta(raw.itemMeta),
            journalCache: raw.journalCache && typeof raw.journalCache === "object" ? raw.journalCache : {},
            gallery: raw.gallery && typeof raw.gallery === "object" ? normalizeGallerySettings(raw.gallery) : undefined,
            coverCrop: migrateCoverCrop(raw.coverCrop),
        };
    }

    async save(): Promise<void> {
        // Serialize writes so a fast sequence of selections cannot persist an older snapshot last.
        this.saving = this.saving.then(async () => {
            try {
                // The serialized copy is taken at write time, inside the queue, so a save
                // requested before arriving changes cannot persist a pre-arrival snapshot.
                const snapshot = JSON.parse(JSON.stringify(this.state));
                const result: any = await this.plugin.saveData(STORAGE_KEY, snapshot);
                if (result && typeof result.code === "number" && result.code !== 0) {
                    console.error("[pdf-zotero] saveData returned error", result);
                }
            } catch (e) {
                console.error("[pdf-zotero] saveData failed", e);
            }
        });
        await this.saving;
    }

    getBook(id: string): Book | undefined {
        return this.state.books[id];
    }

    getAttachment(id: string): PdfAttachment | undefined {
        return this.state.attachments[id];
    }

    getAnnotation(id: string): Annotation | undefined {
        return this.state.annotations[id];
    }

    annotationsForAttachment(attachmentId: string): Annotation[] {
        return Object.values(this.state.annotations)
            .filter(a => a.attachmentId === attachmentId)
            .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    }

    readingStat(attachmentId: string): ReadingStat | undefined {
        return this.state.reading[attachmentId];
    }

    /** Create the record on first open so an untouched PDF still shows "未读". */
    ensureReadingStat(attachmentId: string, pages: number): ReadingStat {
        const existing = this.state.reading[attachmentId];
        if (existing) {
            if (pages > 0 && existing.pages !== pages) existing.pages = Math.floor(pages);
            return existing;
        }
        const created = normalizeReadingStat({pages, lastPage: this.state.attachments[attachmentId]?.lastPage || 1});
        this.state.reading[attachmentId] = created;
        return created;
    }

    setReadingStat(attachmentId: string, stat: ReadingStat): void {
        this.state.reading[attachmentId] = stat;
    }

    /** Rating/remark are keyed by Zotero item key, falling back to the attachment id. */
    itemMeta(key: string): ItemMeta | undefined {
        return key ? this.state.itemMeta[key] : undefined;
    }

    setItemRating(key: string, rating: number): void {
        if (!key) return;
        const meta = {...(this.state.itemMeta[key] || {updatedAt: 0})};
        if (rating > 0) meta.rating = Math.min(5, Math.max(1, Math.round(rating)));
        else delete meta.rating;
        meta.updatedAt = Date.now();
        if (!meta.rating && !meta.remark) delete this.state.itemMeta[key];
        else this.state.itemMeta[key] = meta;
    }

    setItemRemark(key: string, remark: string): void {
        if (!key) return;
        const text = remark.trim();
        const meta = {...(this.state.itemMeta[key] || {updatedAt: 0})};
        if (text) meta.remark = text;
        else delete meta.remark;
        meta.updatedAt = Date.now();
        if (!meta.rating && !meta.remark) delete this.state.itemMeta[key];
        else this.state.itemMeta[key] = meta;
    }

    journalEntry(name: string): JournalEntry | undefined {
        return name ? this.state.journalCache[name] : undefined;
    }

    setJournalEntry(name: string, fields: Record<string, string>): void {
        if (!name) return;
        this.state.journalCache[name] = {fields, at: Date.now()};
    }

    noteLinksForAnnotation(annotationId: string): NoteLink[] {
        return Object.values(this.state.noteLinks).filter(n => n.annotationId === annotationId);
    }

    screenshotRegionsForAttachment(attachmentId: string): ScreenshotRegion[] {
        return Object.values(this.state.screenshotRegions)
            .filter(region => region.attachmentId === attachmentId)
            .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    }

    addScreenshotRegion(region: ScreenshotRegion): void {
        this.state.screenshotRegions[region.id] = region;
    }

    updateScreenshotRegion(id: string, patch: Partial<ScreenshotRegion>): ScreenshotRegion | undefined {
        const current = this.state.screenshotRegions[id];
        if (!current) return undefined;
        const next = {...current, ...patch, id};
        this.state.screenshotRegions[id] = next;
        return next;
    }

    removeScreenshotRegion(id: string): ScreenshotRegion | undefined {
        const region = this.state.screenshotRegions[id];
        if (region) {
            delete this.state.screenshotRegions[id];
        }
        return region;
    }

    upsertBook(book: Book): void {
        this.state.books[book.id] = book;
    }

    upsertAttachment(attachment: PdfAttachment): void {
        this.state.attachments[attachment.id] = attachment;
    }

    addAnnotation(annotation: Annotation): void {
        this.state.annotations[annotation.id] = annotation;
    }

    updateAnnotation(id: string, patch: Partial<Annotation>): Annotation | undefined {
        const current = this.state.annotations[id];
        if (!current) {
            return undefined;
        }
        const next = {...current, ...patch, id, updatedAt: now()};
        this.state.annotations[id] = next;
        return next;
    }

    removeAnnotation(id: string): {annotation?: Annotation; noteLinks: NoteLink[]} {
        const annotation = this.state.annotations[id];
        const noteLinks = this.noteLinksForAnnotation(id);
        delete this.state.annotations[id];
        for (const link of noteLinks) {
            delete this.state.noteLinks[link.id];
        }
        return {annotation, noteLinks};
    }

    removeNoteLink(id: string): NoteLink | undefined {
        const link = this.state.noteLinks[id];
        if (link) {
            delete this.state.noteLinks[id];
        }
        return link;
    }

    addNoteLink(annotationId: string, siyuanBlockId: string, siyuanDocId: string): NoteLink {
        const link: NoteLink = {
            id: newId("nl"),
            annotationId,
            siyuanBlockId,
            siyuanDocId,
            createdAt: now(),
        };
        this.state.noteLinks[link.id] = link;
        return link;
    }

    touchRecent(attachmentId: string): void {
        this.state.recentAttachmentIds = [
            attachmentId,
            ...this.state.recentAttachmentIds.filter(id => id !== attachmentId),
        ].slice(0, 30);
        const attachment = this.state.attachments[attachmentId];
        if (attachment) {
            attachment.lastOpenedAt = now();
        }
    }

    recentAttachments(): PdfAttachment[] {
        return this.state.recentAttachmentIds
            .map(id => this.state.attachments[id])
            .filter((a): a is PdfAttachment => Boolean(a))
            .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
                || (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
    }

    toggleAttachmentPin(attachmentId: string): void {
        const attachment = this.state.attachments[attachmentId];
        if (attachment) {
            attachment.pinned = !attachment.pinned;
        }
    }

    isZoteroItemPinned(itemKey: string): boolean {
        return this.state.pinnedZoteroKeys.includes(itemKey);
    }

    toggleZoteroItemPin(itemKey: string): void {
        if (this.state.pinnedZoteroKeys.includes(itemKey)) {
            this.state.pinnedZoteroKeys = this.state.pinnedZoteroKeys.filter(key => key !== itemKey);
        } else {
            this.state.pinnedZoteroKeys = [...this.state.pinnedZoteroKeys, itemKey];
        }
    }

    addTranslationOutput(output: Omit<TranslationOutput, "id"> & {id?: string}): TranslationOutput {
        const existing = Object.values(this.state.translationOutputs).find(item =>
            item.path.replaceAll("\\", "/").toLowerCase() === output.path.replaceAll("\\", "/").toLowerCase());
        const record: TranslationOutput = {
            ...output,
            id: existing?.id || output.id || newId("translation"),
        };
        this.state.translationOutputs[record.id] = record;
        return record;
    }

    translationOutputs(): TranslationOutput[] {
        return Object.values(this.state.translationOutputs).sort((a, b) => b.createdAt - a.createdAt);
    }

    removeTranslationOutput(id: string): void {
        delete this.state.translationOutputs[id];
    }

    qaThreadsFor(attachmentId: string): QaThread[] {
        const fingerprint = this.state.attachments[attachmentId]?.fingerprint || "";
        let threads = Object.values(this.state.qaThreads).filter(thread => thread.attachmentId === attachmentId);
        if (!threads.length && fingerprint) {
            // Re-import or relink changes attachmentId; rebind by PDF fingerprint.
            for (const thread of Object.values(this.state.qaThreads)) {
                if (thread.fingerprint === fingerprint) thread.attachmentId = attachmentId;
            }
            threads = Object.values(this.state.qaThreads).filter(thread => thread.attachmentId === attachmentId);
        }
        for (const thread of threads) {
            if (!thread.fingerprint && fingerprint) thread.fingerprint = fingerprint;
        }
        return threads.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
    }

    toggleQaThreadPin(threadId: string): void {
        const thread = this.state.qaThreads[threadId];
        if (thread) {
            thread.pinned = !thread.pinned;
            thread.updatedAt = now();
        }
    }

    qaActiveThread(attachmentId: string): QaThread {
        const threads = this.qaThreadsFor(attachmentId);
        const activeId = this.state.qaActiveThread[attachmentId];
        const active = threads.find(thread => thread.id === activeId);
        if (active) return active;
        const fallback = threads[0] || this.qaCreateThread(attachmentId);
        this.state.qaActiveThread[attachmentId] = fallback.id;
        return fallback;
    }

    qaCreateThread(attachmentId: string, title = "新对话"): QaThread {
        const fingerprint = this.state.attachments[attachmentId]?.fingerprint || "";
        const maxThreads = Math.max(1, this.state.settings.qaMaxThreadsPerPdf || 50);
        const existing = this.qaThreadsFor(attachmentId);
        if (existing.length >= maxThreads) {
            const remove = existing.slice(maxThreads - 1);
            for (const thread of remove) delete this.state.qaThreads[thread.id];
        }
        const thread: QaThread = {
            id: newId("qa-thread"),
            attachmentId,
            fingerprint,
            title: title.trim() || "新对话",
            createdAt: now(),
            updatedAt: now(),
            messages: [],
        };
        this.state.qaThreads[thread.id] = thread;
        this.state.qaActiveThread[attachmentId] = thread.id;
        return thread;
    }

    setActiveQaThread(attachmentId: string, threadId: string): void {
        if (this.state.qaThreads[threadId]) {
            this.state.qaActiveThread[attachmentId] = threadId;
        }
    }

    qaThread(threadId: string): QaThread | undefined {
        return this.state.qaThreads[threadId];
    }

    addQaMessage(threadId: string, message: QaMessage): QaThread | undefined {
        const thread = this.state.qaThreads[threadId];
        if (!thread) return undefined;
        thread.messages.push(message);
        thread.updatedAt = now();
        if (thread.messages.length > 400) {
            thread.messages = thread.messages.slice(-400);
        }
        if (message.role === "user" && (!thread.title || thread.title === "新对话")) {
            thread.title = message.text.replace(/\s+/g, " ").trim().slice(0, 40) || "PDF 对话";
        }
        return thread;
    }

    renameQaThread(threadId: string, title: string): void {
        const thread = this.state.qaThreads[threadId];
        if (thread) {
            thread.title = title.replace(/\s+/g, " ").trim().slice(0, 80) || "PDF 对话";
            thread.updatedAt = now();
        }
    }

    deleteQaThread(threadId: string): void {
        const thread = this.state.qaThreads[threadId];
        if (!thread) return;
        delete this.state.qaThreads[threadId];
        const attachmentId = thread.attachmentId;
        if (this.state.qaActiveThread[attachmentId] === threadId) {
            const next = this.qaThreadsFor(attachmentId)[0];
            if (next) this.state.qaActiveThread[attachmentId] = next.id;
            else delete this.state.qaActiveThread[attachmentId];
        }
    }

    clearQaThread(threadId: string): void {
        const thread = this.state.qaThreads[threadId];
        if (!thread) return;
        thread.messages = [];
        thread.updatedAt = now();
    }

    pruneQaThreads(days = 15, maxPerPdf = 50): number {
        const cutoff = now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
        let removed = 0;
        for (const [id, thread] of Object.entries(this.state.qaThreads)) {
            if ((thread.updatedAt || 0) < cutoff) {
                delete this.state.qaThreads[id];
                removed++;
            }
        }
        const byAttachment = new Map<string, QaThread[]>();
        for (const thread of Object.values(this.state.qaThreads)) {
            const list = byAttachment.get(thread.attachmentId) || [];
            list.push(thread);
            byAttachment.set(thread.attachmentId, list);
        }
        for (const [attachmentId, threads] of byAttachment) {
            threads.sort((a, b) => b.updatedAt - a.updatedAt);
            for (const thread of threads.slice(Math.max(1, maxPerPdf))) {
                delete this.state.qaThreads[thread.id];
                removed++;
            }
            const activeId = this.state.qaActiveThread[attachmentId];
            if (!activeId || !this.state.qaThreads[activeId]) {
                const next = threads.find(thread => this.state.qaThreads[thread.id]);
                if (next) this.state.qaActiveThread[attachmentId] = next.id;
                else delete this.state.qaActiveThread[attachmentId];
            }
        }
        for (const [attachmentId, threadId] of Object.entries(this.state.qaActiveThread)) {
            if (!this.state.qaThreads[threadId]) delete this.state.qaActiveThread[attachmentId];
        }
        return removed;
    }

    setZoteroCache(cache: ZoteroCache): void {
        this.state.zotero = cache;
        this.state.settings.zoteroDataDir = cache.dataDir || this.state.settings.zoteroDataDir;
        this.state.settings.zoteroLibraryId = cache.libraryId;
    }

    updateSettings(patch: Partial<Settings>): void {
        this.state.settings = {...this.state.settings, ...patch};
    }

    findAttachmentByZotero(attachmentKey: string): PdfAttachment | undefined {
        return Object.values(this.state.attachments).find(a => a.zotero?.attachmentKey === attachmentKey);
    }

    findAttachmentByPath(path: string): PdfAttachment | undefined {
        const normalized = path.replaceAll("\\", "/").toLowerCase();
        return Object.values(this.state.attachments).find(a => a.path.replaceAll("\\", "/").toLowerCase() === normalized);
    }
}
