import {showMessage} from "siyuan";
import {newId} from "./storage";
import type {PluginHost} from "./host";
import type {Book, PdfAttachment, ZoteroCacheItem, ZoteroCachedAttachment, ZoteroItemRecord} from "./types";
import {loadAttachmentBytes, type PickedPdf} from "./pdf/source";
import {defaultTitleFromFileName} from "./pdf/source";
import {detectZoteroDataDir, fileExists, readFileStat, requireNode, resolveZoteroAttachmentPath} from "./runtime";
import {ZoteroClient, type ZoteroPdfAttachment} from "./zotero/client";
import {readOfflineLibrary} from "./zotero/offline";
import {zoteroItemToCsl} from "./citation/mapper";

function yearFromDate(value: string): string {
    const match = String(value || "").match(/\b(1[6-9]|20)\d{2}\b/);
    return match ? match[0] : "";
}

function creatorsFromItem(data: Record<string, any>): string[] {
    if (!Array.isArray(data.creators)) {
        return [];
    }
    return data.creators.map((creator: any) =>
        creator?.name || [creator?.lastName, creator?.firstName].filter(Boolean).join(" "),
    ).filter(Boolean);
}

export function toCacheItem(item: ZoteroItemRecord, libraryId = 0): ZoteroCacheItem {
    const data = item.data || {};
    return {
        key: item.key,
        title: String(data.title || data.name || "(无标题)"),
        creators: creatorsFromItem(data),
        year: yearFromDate(String(data.date || data.parsedDate || "")),
        itemType: String(data.itemType || ""),
        doi: data.DOI ? String(data.DOI) : undefined,
        abstract: data.abstractNote ? String(data.abstractNote) : undefined,
        collections: Array.isArray(data.collections) ? data.collections.map(String) : [],
        csl: zoteroItemToCsl(data, libraryId) || undefined,
    };
}

export function toCachedAttachment(item: ZoteroItemRecord): ZoteroCachedAttachment | null {
    const data = item.data || {};
    if (data.itemType !== "attachment") return null;
    const contentType = String(data.contentType || "");
    const rawPath = String(data.path || "");
    const filename = String(data.filename || rawPath.replace(/^storage:/, "") || `${item.key}.pdf`);
    if (contentType !== "application/pdf" && !/\.pdf$/i.test(filename)) return null;
    return {
        parentItemKey: String(data.parentItem || ""),
        attachmentKey: item.key,
        attachmentTitle: String(data.title || filename),
        filename,
        rawPath,
        contentType: contentType || "application/pdf",
        enclosureHref: item.links?.enclosure?.href,
    };
}

export class PdfZoteroService {
    constructor(private readonly host: PluginHost) {
    }

    async importPicked(picked: PickedPdf): Promise<PdfAttachment> {
        const existing = picked.path ? this.host.store.findAttachmentByPath(picked.path) : undefined;
        if (existing) {
            existing.fileName = picked.fileName || existing.fileName;
            existing.path = picked.path;
            existing.fingerprint = picked.fingerprint;
            existing.size = picked.size;
            existing.mtimeMs = picked.mtimeMs;
            await this.host.store.save();
            this.host.refreshDock();
            return existing;
        }
        const book: Book = {
            id: newId("book"),
            title: defaultTitleFromFileName(picked.fileName),
            authors: [],
            source: "local",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        const attachment: PdfAttachment = {
            id: newId("att"),
            bookId: book.id,
            path: picked.path,
            source: "local",
            fingerprint: picked.fingerprint,
            fileName: picked.fileName,
            size: picked.size,
            mtimeMs: picked.mtimeMs,
            isPrimary: true,
        };
        this.host.store.upsertBook(book);
        this.host.store.upsertAttachment(attachment);
        await this.host.store.save();
        this.host.refreshDock();
        return attachment;
    }

    async importPath(filePath: string): Promise<PdfAttachment> {
        if (!fileExists(filePath)) {
            throw new Error(`文件不存在：${filePath}`);
        }
        if (!/\.pdf$/i.test(filePath)) {
            throw new Error("只支持 .pdf 文件");
        }
        const stat = await readFileStat(filePath);
        const loaded = await loadAttachmentBytes({
            id: "probe",
            bookId: "probe",
            path: filePath,
            source: "local",
            fingerprint: "",
            fileName: filePath.split(/[\\/]/).pop() || "document.pdf",
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            isPrimary: true,
        });
        const fileName = filePath.split(/[\\/]/).pop() || "document.pdf";
        return this.importPicked({
            file: null as unknown as File,
            path: filePath,
            fileName,
            bytes: loaded.bytes,
            size: loaded.size,
            mtimeMs: loaded.mtimeMs,
            fingerprint: loaded.fingerprint,
        });
    }

    private zoteroDataDir(): string {
        return this.host.store.state.settings.zoteroDataDir || detectZoteroDataDir();
    }

    private cachedZoteroAttachments(itemKey: string): ZoteroPdfAttachment[] {
        const dataDir = this.zoteroDataDir();
        return (this.host.store.state.zotero.attachments || [])
            .filter(item => item.parentItemKey === itemKey)
            .map(item => ({
                attachmentKey: item.attachmentKey,
                attachmentTitle: item.attachmentTitle,
                filename: item.filename,
                path: resolveZoteroAttachmentPath({
                    dataDir,
                    attachmentKey: item.attachmentKey,
                    path: item.rawPath,
                    filename: item.filename,
                    enclosureHref: item.enclosureHref,
                }),
                rawPath: item.rawPath,
                contentType: item.contentType,
            }));
    }

    async listZoteroPdfAttachments(itemKey: string): Promise<ZoteroPdfAttachment[]> {
        const cached = this.cachedZoteroAttachments(itemKey).filter(item => Boolean(item.path && fileExists(item.path)));
        if (cached.length) {
            return cached;
        }
        const settings = this.host.store.state.settings;
        const dataDir = this.zoteroDataDir();
        const client = new ZoteroClient(settings.zoteroBaseUrl, settings.zoteroLibraryId || 0);
        const attachments = await client.listPdfAttachments(itemKey, dataDir);
        if (attachments.length) {
            const existing = this.host.store.state.zotero.attachments || [];
            const keys = new Set(existing.map(item => `${item.parentItemKey}:${item.attachmentKey}`));
            const added: ZoteroCachedAttachment[] = attachments
                .filter(item => !keys.has(`${itemKey}:${item.attachmentKey}`))
                .map(item => ({
                    parentItemKey: itemKey,
                    attachmentKey: item.attachmentKey,
                    attachmentTitle: item.attachmentTitle,
                    filename: item.filename,
                    rawPath: item.rawPath || item.path,
                    contentType: item.contentType,
                }));
            if (added.length) {
                this.host.store.state.zotero.attachments = [...existing, ...added];
                await this.host.store.save();
            }
        }
        return attachments;
    }

    async importZoteroItem(itemKey: string, attachmentKey?: string): Promise<PdfAttachment | null> {
        const settings = this.host.store.state.settings;
        const cached = this.host.store.state.zotero.items.find(item => item.key === itemKey);
        let attachments: ZoteroPdfAttachment[];
        try {
            attachments = await this.listZoteroPdfAttachments(itemKey);
        } catch (error: any) {
            showMessage(`读取 Zotero 附件失败：${error?.message || String(error)}`, 7000, "error");
            return null;
        }
        if (!attachments.length) {
            showMessage("该 Zotero 条目没有 PDF 附件（只支持 PDF）", 5000, "error");
            return null;
        }
        const pdf = (attachmentKey && attachments.find(item => item.attachmentKey === attachmentKey)) || attachments[0];
        if (!pdf.path || !fileExists(pdf.path)) {
            showMessage(`PDF 附件路径不可访问：${pdf.path || "(空)"}。请检查 Zotero 数据目录设置。`, 7000, "error");
            return null;
        }
        const existing = this.host.store.findAttachmentByZotero(pdf.attachmentKey);
        if (existing) {
            if (existing.path !== pdf.path) {
                existing.path = pdf.path;
            }
            await this.host.store.save();
            this.host.refreshDock();
            return existing;
        }
        const loaded = await loadAttachmentBytes({
            id: "probe",
            bookId: "probe",
            path: pdf.path,
            source: "zotero",
            fingerprint: "",
            fileName: pdf.filename,
            size: 0,
            mtimeMs: 0,
            isPrimary: true,
        });
        const book: Book = {
            id: newId("book"),
            title: cached?.title || pdf.attachmentTitle || defaultTitleFromFileName(pdf.filename),
            authors: cached?.creators || [],
            year: cached?.year,
            source: "zotero",
            zoteroKey: itemKey,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        const attachment: PdfAttachment = {
            id: newId("att"),
            bookId: book.id,
            path: pdf.path,
            source: "zotero",
            fingerprint: loaded.fingerprint,
            fileName: pdf.filename,
            size: loaded.size,
            mtimeMs: loaded.mtimeMs,
            isPrimary: true,
            zotero: {
                libraryId: settings.zoteroLibraryId || 0,
                itemKey,
                attachmentKey: pdf.attachmentKey,
                attachmentTitle: pdf.attachmentTitle,
                itemTitle: book.title,
            },
        };
        this.host.store.upsertBook(book);
        this.host.store.upsertAttachment(attachment);
        await this.host.store.save();
        this.host.refreshDock();
        return attachment;
    }

    async relinkAttachment(attachmentId: string, newPath: string): Promise<PdfAttachment> {
        const attachment = this.host.store.getAttachment(attachmentId);
        if (!attachment) {
            throw new Error("附件记录不存在");
        }
        if (!fileExists(newPath)) {
            throw new Error(`文件不存在：${newPath}`);
        }
        const loaded = await loadAttachmentBytes({
            ...attachment,
            path: newPath,
        });
        attachment.path = newPath;
        attachment.fileName = newPath.split(/[\\/]/).pop() || attachment.fileName;
        attachment.fingerprint = loaded.fingerprint;
        attachment.size = loaded.size;
        attachment.mtimeMs = loaded.mtimeMs;
        const book = this.host.store.getBook(attachment.bookId);
        if (book) {
            book.updatedAt = Date.now();
        }
        await this.host.store.save();
        this.host.refreshDock();
        return attachment;
    }

    /**
     * Offline-only attachment metadata backfill. Reads zotero.sqlite read-only;
     * it never writes and is used when the Zotero Local API is unavailable.
     * This makes PDFs opened once in the plugin available even after Zotero is
     * closed, without requiring another app launch.
     */
    async hydrateOfflineAttachments(): Promise<number> {
        const settings = this.host.store.state.settings;
        const dataDir = settings.zoteroDataDir || detectZoteroDataDir();
        if (!dataDir) return 0;
        const path = requireNode("path");
        const dbPath = path?.join?.(dataDir, "zotero.sqlite");
        if (!dbPath || !fileExists(dbPath)) return 0;
        const sqlite = requireNode("node:sqlite");
        if (!sqlite?.DatabaseSync) {
            this.host.logDebug("zotero.offline.backfill.no-sqlite", {dbPath}, "warn");
            return 0;
        }
        this.host.logDebug("zotero.offline.backfill.started", {dbPath});
        let db: any = null;
        try {
            db = new sqlite.DatabaseSync(dbPath, {readOnly: true});
            const rows = db.prepare(`
                SELECT i.key AS attachmentKey, p.key AS parentItemKey, ia.path AS rawPath, ia.contentType AS contentType
                FROM itemAttachments ia
                JOIN items i ON i.itemID = ia.itemID
                JOIN items p ON p.itemID = ia.parentItemID
                WHERE ia.contentType = 'application/pdf' OR lower(ia.path) LIKE '%.pdf'
            `).all() as Array<Record<string, any>>;
            const itemKeys = new Set(this.host.store.state.zotero.items.map(item => item.key));
            const existing = this.host.store.state.zotero.attachments || [];
            const known = new Set(existing.map(item => `${item.parentItemKey}:${item.attachmentKey}`));
            const added: ZoteroCachedAttachment[] = [];
            for (const row of rows) {
                const parentItemKey = String(row.parentItemKey || "");
                const attachmentKey = String(row.attachmentKey || "");
                const rawPath = String(row.rawPath || "");
                if (!parentItemKey || !attachmentKey || !rawPath || !itemKeys.has(parentItemKey) || known.has(`${parentItemKey}:${attachmentKey}`)) {
                    continue;
                }
                const filename = rawPath.startsWith("storage:")
                    ? rawPath.slice("storage:".length)
                    : rawPath.split(/[\\/]/).pop() || `${attachmentKey}.pdf`;
                added.push({
                    parentItemKey,
                    attachmentKey,
                    attachmentTitle: filename,
                    filename,
                    rawPath,
                    contentType: String(row.contentType || "application/pdf"),
                });
                known.add(`${parentItemKey}:${attachmentKey}`);
            }
            if (added.length) {
                this.host.store.state.zotero.attachments = [...existing, ...added];
                await this.host.store.save();
                this.host.refreshDock();
            }
            this.host.logDebug("zotero.offline.backfill.done", {rows: rows.length, added: added.length});
            return added.length;
        } catch (error: any) {
            this.host.logDebug("zotero.offline.backfill.failed", {message: error?.message || String(error)}, "warn");
            console.warn("[pdf-zotero] offline attachment backfill failed", error);
            return 0;
        } finally {
            try {
                db?.close?.();
            } catch {
                // ignore close errors
            }
        }
    }

    async refreshZotero(silent = false): Promise<void> {
        const settings = this.host.store.state.settings;
        const detected = settings.zoteroDataDir || detectZoteroDataDir();
        if (detected && detected !== settings.zoteroDataDir) {
            this.host.store.updateSettings({zoteroDataDir: detected});
        }
        const client = new ZoteroClient(settings.zoteroBaseUrl, settings.zoteroLibraryId || 0);
        const ping = await client.ping();
        if (!ping.ok) {
            const offlineEnabled = settings.zoteroOfflineSqlite !== false;
            const offline = offlineEnabled && detected ? readOfflineLibrary(detected, settings.zoteroLibraryId || 0) : null;
            if (offline && offline.items.length) {
                // Merge offline attachment paths with anything already cached (plugin-linked PDFs).
                const existingAttachments = this.host.store.state.zotero.attachments || [];
                const known = new Set(offline.attachments.map(item => `${item.parentItemKey}:${item.attachmentKey}`));
                const attachments = [...offline.attachments, ...existingAttachments.filter(item => !known.has(`${item.parentItemKey}:${item.attachmentKey}`))];
                this.host.store.setZoteroCache({
                    libraryId: settings.zoteroLibraryId || 0,
                    dataDir: detected,
                    updatedAt: Date.now(),
                    lastError: `离线模式：已从 zotero.sqlite 读取 ${offline.items.length} 条文献（Zotero 未运行）`,
                    items: offline.items,
                    collections: offline.collections,
                    attachments,
                });
                await this.host.store.save();
                this.host.refreshDock();
                this.host.logDebug("zotero.offline.full", {items: offline.items.length, attachments: attachments.length});
                if (!silent) {
                    showMessage(`Zotero 未运行，已离线读取 ${offline.items.length} 条文献`, 4000);
                }
                return;
            }
            await this.hydrateOfflineAttachments();
            this.host.store.setZoteroCache({
                libraryId: settings.zoteroLibraryId || 0,
                dataDir: detected,
                updatedAt: this.host.store.state.zotero.updatedAt,
                lastError: ping.error || `HTTP ${ping.status}`,
                items: this.host.store.state.zotero.items,
                collections: this.host.store.state.zotero.collections || [],
                attachments: this.host.store.state.zotero.attachments || [],
            });
            await this.host.store.save();
            this.host.refreshDock();
            if (!silent) {
                showMessage(`Zotero Local API 不可用：${ping.error || `HTTP ${ping.status}`}`, 7000, "error");
            }
            return;
        }
        try {
            const [records, collections, attachmentRecords] = await Promise.all([
                client.listTopItems(),
                client.listCollections().catch((): any[] => []),
                client.listAllAttachments().catch((): any[] => []),
            ]);
            const libraryId = settings.zoteroLibraryId || 0;
            const items = records
                .filter(record => record?.data && !["attachment", "note", "annotation"].includes(record.data.itemType))
                .map(record => toCacheItem(record, libraryId));
            const cachedAttachments = attachmentRecords
                .map(record => toCachedAttachment(record))
                .filter((item): item is ZoteroCachedAttachment => Boolean(item?.parentItemKey));
            this.host.store.setZoteroCache({
                libraryId,
                dataDir: detected,
                updatedAt: Date.now(),
                lastError: "",
                items,
                collections: collections.map(record => ({
                    key: record.key,
                    name: String(record.data?.name || record.key),
                    parent: record.data?.parentCollection || undefined,
                })),
                attachments: cachedAttachments.length
                    ? cachedAttachments
                    : (this.host.store.state.zotero.attachments || []),
            });
            await this.host.store.save();
            this.host.refreshDock();
            if (!silent) {
                showMessage(`已从 Zotero 读取 ${items.length} 条文献`);
            }
        } catch (error: any) {
            this.host.store.setZoteroCache({
                libraryId: settings.zoteroLibraryId || 0,
                dataDir: detected,
                updatedAt: this.host.store.state.zotero.updatedAt,
                lastError: error?.message || String(error),
                items: this.host.store.state.zotero.items,
                collections: this.host.store.state.zotero.collections || [],
                attachments: this.host.store.state.zotero.attachments || [],
            });
            await this.host.store.save();
            this.host.refreshDock();
            if (!silent) {
                showMessage(`Zotero 读取失败：${error?.message || String(error)}`, 7000, "error");
            }
        }
    }
}
