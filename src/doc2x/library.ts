import {requireNode, siyuanDataDir} from "../runtime";

export type ParseRecordKind = "parse" | "translate";

export interface ParseRecord {
    id: string;
    kind: ParseRecordKind;
    /** Stable PDF fingerprint used to dedupe parses of the same source. */
    fingerprint: string;
    sourcePdfPath: string;
    sourceTitle?: string;
    sourceAttachmentId?: string;
    /** Parse/translation model actually used. */
    model?: string;
    targetLang?: string;
    translateMode?: string;
    createdAt: number;
    version: number;
    mdPath: string;
    rawPath?: string;
    imagesDir?: string;
    imagesCount?: number;
    parseId?: string;
    noteDocId?: string;
    noteBlockId?: string;
    sizeBytes?: number;
}

function pathApi(): any {
    return requireNode("path");
}

function fsApi(): any {
    return requireNode("fs");
}

export function parseLibraryDir(): string {
    const path = pathApi();
    const dataDir = siyuanDataDir();
    if (!path?.join || !dataDir) return "";
    return path.join(dataDir, "storage", "petal", "siyuan-pdf-zotero", "doc2x-parses");
}

function indexPath(dir: string): string {
    return pathApi().join(dir, "index.json");
}

export function loadParseLibrary(): ParseRecord[] {
    const fs = fsApi();
    const dir = parseLibraryDir();
    if (!fs || !dir) return [];
    try {
        const file = indexPath(dir);
        if (!fs.existsSync(file)) return [];
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(parsed) ? parsed.filter((item: any) => item && item.id && item.mdPath) : [];
    } catch {
        return [];
    }
}

export function saveParseLibrary(records: ParseRecord[]): void {
    const fs = fsApi();
    const dir = parseLibraryDir();
    if (!fs || !dir) return;
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(indexPath(dir), JSON.stringify(records, null, 2), "utf8");
}

export function findParseRecord(fingerprint: string, kind: ParseRecordKind = "parse", records = loadParseLibrary()): ParseRecord | undefined {
    return records
        .filter(item => item.kind === kind && item.fingerprint === fingerprint)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function nextParseVersion(fingerprint: string, records = loadParseLibrary()): number {
    const versions = records.filter(item => item.kind === "parse" && item.fingerprint === fingerprint).map(item => item.version || 1);
    return versions.length ? Math.max(...versions) + 1 : 1;
}

export function createRecordWorkspace(fingerprint: string, version: number, kind: ParseRecordKind): {id: string; dir: string} {
    const path = pathApi();
    const fs = fsApi();
    const safe = String(fingerprint || "pdf").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "pdf";
    const id = `${kind}-${safe}-${Date.now()}`;
    const dir = path.join(parseLibraryDir(), id);
    fs.mkdirSync(dir, {recursive: true});
    return {id, dir};
}

export function dirSizeBytes(dir: string): number {
    const fs = fsApi();
    const path = pathApi();
    if (!fs || !path || !dir || !fs.existsSync(dir)) return 0;
    let total = 0;
    const walk = (current: string) => {
        let entries: any[] = [];
        try {
            entries = fs.readdirSync(current, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            try {
                if (entry.isDirectory()) walk(full);
                else total += Number(fs.statSync(full).size || 0);
            } catch {
                // ignore unreadable files
            }
        }
    };
    walk(dir);
    return total;
}

export function refreshRecordSize(record: ParseRecord): ParseRecord {
    const path = pathApi();
    return {...record, sizeBytes: path ? dirSizeBytes(path.dirname(record.mdPath)) : record.sizeBytes};
}

export function removeParseRecord(id: string, deleteFiles = true): void {
    const fs = fsApi();
    const path = pathApi();
    const records = loadParseLibrary();
    const target = records.find(item => item.id === id);
    if (!target) return;
    if (deleteFiles && fs && path) {
        try {
            fs.rmSync(path.dirname(target.mdPath), {recursive: true, force: true});
        } catch {
            // keep going; index entry is still removed
        }
    }
    saveParseLibrary(records.filter(item => item.id !== id));
}

export function updateParseRecord(id: string, patch: Partial<ParseRecord>): ParseRecord | undefined {
    const records = loadParseLibrary();
    const index = records.findIndex(item => item.id === id);
    if (index < 0) return undefined;
    records[index] = {...records[index], ...patch};
    saveParseLibrary(records);
    return records[index];
}

/** Keep the newest `limit` records and trim total on-disk size below `maxBytes`. */
export function enforceParseLimits(limit: number, maxBytes: number): {removed: number; freedBytes: number} {
    const records = loadParseLibrary().sort((a, b) => b.createdAt - a.createdAt);
    let removed = 0;
    let freedBytes = 0;
    const trash: ParseRecord[] = [];
    records.forEach((record, index) => {
        const staleIndex = index >= Math.max(1, limit);
        const tooBig = maxBytes > 0 && records
            .slice(0, index + 1)
            .reduce((sum, item) => sum + (item.sizeBytes || 0), 0) > maxBytes;
        if (staleIndex || tooBig) {
            trash.push(record);
            freedBytes += record.sizeBytes || 0;
        }
    });
    for (const record of trash) {
        removeParseRecord(record.id, true);
        removed += 1;
    }
    return {removed, freedBytes};
}

export function addParseRecord(record: ParseRecord): ParseRecord {
    const records = loadParseLibrary();
    records.push(record);
    saveParseLibrary(records);
    return record;
}

export function clearParseLibrary(): number {
    const records = loadParseLibrary();
    for (const record of records) {
        removeParseRecord(record.id, true);
    }
    return records.length;
}

export function readParseMarkdown(record: ParseRecord, raw = false): string {
    const fs = fsApi();
    const path = pathApi();
    if (!fs || !path) return "";
    const file = raw && record.rawPath ? record.rawPath : record.mdPath;
    try {
        return fs.existsSync(file) ? String(fs.readFileSync(file, "utf8")) : "";
    } catch {
        return "";
    }
}

export function writeParseMarkdown(record: ParseRecord, markdown: string, raw = false): void {
    const fs = fsApi();
    if (!fs) return;
    const file = raw && record.rawPath ? record.rawPath : record.mdPath;
    fs.writeFileSync(file, markdown, "utf8");
}

export function parseImagesDir(record: ParseRecord): string {
    const path = pathApi();
    return record.imagesDir || (path ? path.dirname(record.mdPath) : "");
}

export function countImages(dir: string): number {
    const fs = fsApi();
    const path = pathApi();
    if (!fs || !path || !dir || !fs.existsSync(dir)) return 0;
    let count = 0;
    const walk = (current: string) => {
        let entries: any[] = [];
        try {
            entries = fs.readdirSync(current, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(entry.name)) count += 1;
        }
    };
    walk(dir);
    return count;
}
