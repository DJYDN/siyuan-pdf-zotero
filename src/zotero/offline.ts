import {fileExists, requireNode} from "../runtime";
import type {ZoteroCacheItem, ZoteroCachedAttachment, ZoteroCollection} from "../types";

/**
 * Offline Zotero reader.
 *
 * Zotero's Local API requires the desktop app to be running. When it is not, we
 * can still read `zotero.sqlite` and `fulltext.sqlite` read-only through Node's
 * built-in sqlite module (Electron/Node 22+). This never writes to either DB.
 */

export interface OfflineLibrary {
    items: ZoteroCacheItem[];
    collections: ZoteroCollection[];
    attachments: ZoteroCachedAttachment[];
    rawCount: number;
}

export interface OfflineFulltextHit {
    key: string;
    title: string;
    itemType: string;
    year: string;
    creators: string[];
    attachmentKey?: string;
}

function sqliteApi(): any {
    try {
        const sqlite = requireNode("node:sqlite");
        return sqlite?.DatabaseSync ? sqlite : null;
    } catch {
        return null;
    }
}

export function offlineSqliteStatus(dataDir: string): {available: boolean; reason: string} {
    if (!dataDir) return {available: false, reason: "未设置 Zotero 数据目录"};
    const path = requireNode("path");
    if (!path?.join) return {available: false, reason: "当前运行环境没有 Node 文件能力"};
    const dbPath = path.join(dataDir, "zotero.sqlite");
    if (!fileExists(dbPath)) return {available: false, reason: "zotero.sqlite 不存在"};
    if (!sqliteApi()) return {available: false, reason: "当前运行环境不支持 node:sqlite（请打开 Zotero 使用 Local API）"};
    return {available: true, reason: ""};
}

function openDb(dataDir: string, fileName: string): any {
    const path = requireNode("path");
    const sqlite = sqliteApi();
    if (!path?.join || !sqlite) return null;
    try {
        return new sqlite.DatabaseSync(path.join(dataDir, fileName), {readOnly: true});
    } catch {
        return null;
    }
}

const CSL_TYPES: Record<string, string> = {
    journalArticle: "article-journal",
    conferencePaper: "paper-conference",
    book: "book",
    bookSection: "chapter",
    thesis: "thesis",
    report: "report",
    webpage: "webpage",
    preprint: "article",
    manuscript: "manuscript",
};

function cslFromFields(key: string, itemType: string, fields: Record<string, string>, creators: Array<{first: string; last: string; type: string}>) {
    const year = /(\d{4})/.exec(fields.date || "")?.[1] || "";
    const author = creators
        .filter(item => item.type === "author" || !item.type)
        .map(item => item.first ? {family: item.last, given: item.first} : {literal: item.last});
    const csl: Record<string, any> = {
        id: key,
        type: CSL_TYPES[itemType] || "article",
        title: fields.title || "",
    };
    if (author.length) csl.author = author;
    if (year) csl.issued = {"date-parts": [[Number(year)]]};
    if (fields.DOI) csl.DOI = fields.DOI;
    if (fields.abstractNote) csl.abstract = fields.abstractNote;
    if (fields.url) csl.URL = fields.url;
    if (fields.publicationTitle) csl["container-title"] = fields.publicationTitle;
    if (fields.bookTitle) csl["container-title"] = fields.bookTitle;
    if (fields.volume) csl.volume = fields.volume;
    if (fields.issue) csl.issue = fields.issue;
    if (fields.pages) csl.page = fields.pages;
    if (fields.publisher) csl.publisher = fields.publisher;
    if (fields.language) csl.language = fields.language;
    return csl;
}

export function readOfflineLibrary(dataDir: string, libraryId = 0): OfflineLibrary | null {
    const db = openDb(dataDir, "zotero.sqlite");
    if (!db) return null;
    try {
        const fieldRows = db.prepare(`
            SELECT d.itemID AS itemID, f.fieldName AS fieldName, v.value AS value
            FROM itemData d
            JOIN fields f ON f.fieldID = d.fieldID
            JOIN itemDataValues v ON v.valueID = d.valueID
        `).all() as Array<Record<string, any>>;
        const fieldsByItem = new Map<number, Record<string, string>>();
        for (const row of fieldRows) {
            const itemID = Number(row.itemID);
            if (!fieldsByItem.has(itemID)) fieldsByItem.set(itemID, {});
            fieldsByItem.get(itemID)![String(row.fieldName)] = String(row.value ?? "");
        }

        const creatorRows = db.prepare(`
            SELECT ic.itemID AS itemID, c.firstName AS firstName, c.lastName AS lastName,
                   c.fieldMode AS fieldMode, ct.creatorType AS creatorType
            FROM itemCreators ic
            JOIN creators c ON c.creatorID = ic.creatorID
            LEFT JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
            ORDER BY ic.itemID, ic.orderIndex
        `).all() as Array<Record<string, any>>;
        const creatorsByItem = new Map<number, Array<{first: string; last: string; type: string}>>();
        for (const row of creatorRows) {
            const itemID = Number(row.itemID);
            const last = String(row.lastName ?? "");
            const first = String(row.firstName ?? "");
            const name = last || first;
            if (!name) continue;
            if (!creatorsByItem.has(itemID)) creatorsByItem.set(itemID, []);
            creatorsByItem.get(itemID)!.push({first, last: name, type: String(row.creatorType ?? "")});
        }

        const collectionRows = db.prepare(`
            SELECT c.collectionID AS collectionID, c.key AS key, c.collectionName AS name,
                   p.key AS parentKey
            FROM collections c
            LEFT JOIN collections p ON p.collectionID = c.parentCollectionID
        `).all() as Array<Record<string, any>>;
        const collections: ZoteroCollection[] = collectionRows.map(row => ({
            key: String(row.key || ""),
            name: String(row.name || ""),
            parent: row.parentKey ? String(row.parentKey) : undefined,
        }));
        const collectionKeyById = new Map<number, string>(collectionRows.map(row => [Number(row.collectionID), String(row.key || "")]));
        const itemCollections = new Map<number, string[]>();
        for (const row of db.prepare("SELECT collectionID, itemID FROM collectionItems").all() as Array<Record<string, any>>) {
            const itemID = Number(row.itemID);
            const key = collectionKeyById.get(Number(row.collectionID));
            if (!key) continue;
            if (!itemCollections.has(itemID)) itemCollections.set(itemID, []);
            itemCollections.get(itemID)!.push(key);
        }

        const items: ZoteroCacheItem[] = [];
        const itemIDs: number[] = [];
        const itemRows = db.prepare(`
            SELECT i.itemID AS itemID, i.key AS key, t.typeName AS itemType
            FROM items i
            JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
            WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems)
              AND t.typeName NOT IN ('attachment', 'note', 'annotation')
            ORDER BY i.itemID
        `).all() as Array<Record<string, any>>;
        for (const row of itemRows) {
            const itemID = Number(row.itemID);
            const key = String(row.key || "");
            const itemType = String(row.itemType || "");
            if (!key) continue;
            const fields = fieldsByItem.get(itemID) || {};
            const creators = creatorsByItem.get(itemID) || [];
            const creatorNames = creators.map(item => item.first ? `${item.last}, ${item.first}` : item.last);
            const year = /(\d{4})/.exec(fields.date || "")?.[1] || "";
            items.push({
                key,
                title: fields.title || fields.name || "(无标题)",
                creators: creatorNames,
                year,
                itemType,
                doi: fields.DOI,
                abstract: fields.abstractNote,
                collections: itemCollections.get(itemID) || [],
                csl: cslFromFields(key, itemType, fields, creators),
            });
            itemIDs.push(itemID);
        }

        const attachments: ZoteroCachedAttachment[] = [];
        const attachmentRows = db.prepare(`
            SELECT i.key AS attachmentKey, p.key AS parentItemKey, ia.path AS rawPath,
                   ia.contentType AS contentType, ia.itemID AS attachmentItemID
            FROM itemAttachments ia
            JOIN items i ON i.itemID = ia.itemID
            JOIN items p ON p.itemID = ia.parentItemID
            WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems)
              AND (ia.contentType = 'application/pdf' OR lower(ia.path) LIKE '%.pdf')
        `).all() as Array<Record<string, any>>;
        for (const row of attachmentRows) {
            const rawPath = String(row.rawPath || "");
            if (!rawPath) continue;
            const filename = rawPath.startsWith("storage:")
                ? rawPath.slice("storage:".length)
                : rawPath.split(/[\\/]/).pop() || `${row.attachmentKey}.pdf`;
            attachments.push({
                parentItemKey: String(row.parentItemKey || ""),
                attachmentKey: String(row.attachmentKey || ""),
                attachmentTitle: filename,
                filename,
                rawPath,
                contentType: String(row.contentType || "application/pdf"),
            });
        }
        db.close();
        return {items, collections, attachments, rawCount: items.length};
    } catch (error) {
        try { db.close(); } catch { /* ignore */ }
        console.warn("[pdf-zotero] offline SQLite read failed", error);
        return null;
    }
}

function ftsQuery(text: string): string {
    const tokens = String(text || "").split(/\s+/).map(item => item.replace(/["'*()]/g, "").trim()).filter(Boolean);
    return tokens.map(token => `"${token}"*`).join(" AND ");
}

/** Search the Zotero fulltext index offline; returns matched parent items (no snippets). */
export function searchOfflineFulltext(dataDir: string, query: string, limit = 200): OfflineFulltextHit[] {
    const text = String(query || "").trim();
    if (!text) return [];
    const zoteroDb = openDb(dataDir, "zotero.sqlite");
    const fulltextDb = openDb(dataDir, "fulltext.sqlite");
    if (!zoteroDb || !fulltextDb) {
        try { zoteroDb?.close?.(); } catch { /* ignore */ }
        try { fulltextDb?.close?.(); } catch { /* ignore */ }
        return [];
    }
    try {
        const fts = ftsQuery(text);
        let rows: Array<Record<string, any>> = [];
        try {
            rows = fulltextDb.prepare("SELECT rowid FROM fulltextContent WHERE fulltextContent MATCH ? LIMIT ?").all(fts, limit) as Array<Record<string, any>>;
        } catch {
            try {
                rows = fulltextDb.prepare("SELECT rowid FROM fulltextContentCJK WHERE fulltextContentCJK MATCH ? LIMIT ?").all(fts, limit) as Array<Record<string, any>>;
            } catch {
                rows = [];
            }
        }
        const parentByAttachment = new Map<number, number>();
        const keyByItemID = new Map<number, string>();
        for (const row of zoteroDb.prepare("SELECT itemID, key FROM items").all() as Array<Record<string, any>>) {
            keyByItemID.set(Number(row.itemID), String(row.key || ""));
        }
        for (const row of zoteroDb.prepare("SELECT itemID, parentItemID FROM itemAttachments").all() as Array<Record<string, any>>) {
            parentByAttachment.set(Number(row.itemID), Number(row.parentItemID));
        }
        const titleByKey = new Map<string, {title: string; type: string; year: string; creators: string[]}>();
        const fieldRows = zoteroDb.prepare(`
            SELECT i.key AS key, t.typeName AS itemType, f.fieldName AS fieldName, v.value AS value
            FROM items i
            JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
            JOIN itemData d ON d.itemID = i.itemID
            JOIN fields f ON f.fieldID = d.fieldID
            JOIN itemDataValues v ON v.valueID = d.valueID
            WHERE f.fieldName IN ('title', 'date')
        `).all() as Array<Record<string, any>>;
        for (const row of fieldRows) {
            const key = String(row.key || "");
            if (!key) continue;
            const current = titleByKey.get(key) || {title: "", type: String(row.itemType || ""), year: "", creators: []};
            if (row.fieldName === "title") current.title = String(row.value || "");
            if (row.fieldName === "date") current.year = /(\d{4})/.exec(String(row.value || ""))?.[1] || "";
            titleByKey.set(key, current);
        }
        const seen = new Set<string>();
        const hits: OfflineFulltextHit[] = [];
        for (const row of rows) {
            const attachmentItemID = Number(row.rowid);
            const parentItemID = parentByAttachment.get(attachmentItemID) || attachmentItemID;
            const key = keyByItemID.get(parentItemID) || "";
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const meta = titleByKey.get(key);
            hits.push({
                key,
                title: meta?.title || "(无标题)",
                itemType: meta?.type || "journalArticle",
                year: meta?.year || "",
                creators: [],
                attachmentKey: keyByItemID.get(attachmentItemID) || "",
            });
            if (hits.length >= limit) break;
        }
        return hits;
    } catch (error) {
        console.warn("[pdf-zotero] offline fulltext search failed", error);
        return [];
    } finally {
        try { zoteroDb.close(); } catch { /* ignore */ }
        try { fulltextDb.close(); } catch { /* ignore */ }
    }
}
