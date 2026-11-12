import type {ZoteroItemRecord} from "../types";
import {requireNode, resolveZoteroAttachmentPath} from "../runtime";

export interface ZoteroPingResult {
    ok: boolean;
    status: number;
    version?: string;
    error?: string;
}

export interface ZoteroPdfAttachment {
    attachmentKey: string;
    attachmentTitle: string;
    filename: string;
    path: string;
    rawPath?: string;
    contentType: string;
}

interface HttpResult {
    status: number;
    headers: Record<string, string>;
    body: string;
    json?: any;
}

function httpGetJson(url: string, timeoutMs = 8000): Promise<HttpResult> {
    const http = requireNode("http");
    if (!http?.get) {
        return Promise.reject(new Error("当前运行环境没有 Node HTTP 能力"));
    }
    return new Promise((resolve, reject) => {
        const req = http.get(url, {headers: {"Accept": "application/json"}}, (res: any) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                let json: any;
                try {
                    json = JSON.parse(body);
                } catch {
                    // leave undefined
                }
                resolve({status: res.statusCode || 0, headers: res.headers || {}, body, json});
            });
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Zotero Local API 请求超时（${timeoutMs}ms）`));
        });
        req.on("error", (err: Error) => reject(err));
    });
}

export class ZoteroClient {
    readonly baseUrl: string;
    readonly libraryId: number;

    constructor(baseUrl = "http://127.0.0.1:23119", libraryId = 0) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.libraryId = libraryId;
    }

    forLibrary(libraryId: number): ZoteroClient {
        return new ZoteroClient(this.baseUrl, libraryId);
    }

    private api(path: string, params: Record<string, string | number> = {}): string {
        const url = new URL(`${this.baseUrl}/api/users/${this.libraryId}${path}`);
        url.searchParams.set("format", "json");
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, String(value));
        }
        return url.href;
    }

    async ping(): Promise<ZoteroPingResult> {
        try {
            const res = await httpGetJson(this.api("/items", {limit: 1}), 5000);
            if (res.status >= 200 && res.status < 300) {
                return {ok: true, status: res.status, version: res.headers["last-modified-version"]};
            }
            return {ok: false, status: res.status, error: `HTTP ${res.status}: ${res.body.slice(0, 300)}`};
        } catch (e: any) {
            return {ok: false, status: 0, error: e?.message || String(e)};
        }
    }

    async listTopItems(limit = 5000): Promise<ZoteroItemRecord[]> {
        const records: ZoteroItemRecord[] = [];
        const pageSize = 100;
        for (let start = 0; start < limit; start += pageSize) {
            const batchSize = Math.min(pageSize, limit - start);
            const res = await httpGetJson(this.api("/items/top", {limit: batchSize, start, sort: "dateModified", direction: "desc"}));
            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Zotero Local API HTTP ${res.status}: ${res.body.slice(0, 300)}`);
            }
            if (!Array.isArray(res.json)) {
                throw new Error("Zotero Local API 返回了非数组数据");
            }
            records.push(...res.json as ZoteroItemRecord[]);
            if (res.json.length < batchSize) break;
        }
        return records;
    }

    async listCollections(limit = 5000): Promise<ZoteroItemRecord[]> {
        const records: ZoteroItemRecord[] = [];
        const pageSize = 100;
        for (let start = 0; start < limit; start += pageSize) {
            const batchSize = Math.min(pageSize, limit - start);
            const res = await httpGetJson(this.api("/collections", {limit: batchSize, start}));
            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Zotero collections HTTP ${res.status}: ${res.body.slice(0, 300)}`);
            }
            if (!Array.isArray(res.json)) break;
            records.push(...res.json as ZoteroItemRecord[]);
            if (res.json.length < batchSize) break;
        }
        return records;
    }

    async listAllAttachments(limit = 20000): Promise<ZoteroItemRecord[]> {
        const records: ZoteroItemRecord[] = [];
        const pageSize = 100;
        for (let start = 0; start < limit; start += pageSize) {
            const batchSize = Math.min(pageSize, limit - start);
            const res = await httpGetJson(this.api("/items", {
                itemType: "attachment",
                limit: batchSize,
                start,
            }));
            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Zotero attachments HTTP ${res.status}: ${res.body.slice(0, 300)}`);
            }
            if (!Array.isArray(res.json)) break;
            records.push(...res.json as ZoteroItemRecord[]);
            if (res.json.length < batchSize) break;
        }
        return records;
    }

    async listChildren(itemKey: string): Promise<ZoteroItemRecord[]> {
        const res = await httpGetJson(this.api(`/items/${encodeURIComponent(itemKey)}/children`, {limit: 100}));
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Zotero children HTTP ${res.status}: ${res.body.slice(0, 300)}`);
        }
        return Array.isArray(res.json) ? res.json as ZoteroItemRecord[] : [];
    }

    async listPdfAttachments(itemKey: string, dataDir: string): Promise<ZoteroPdfAttachment[]> {
        const children = await this.listChildren(itemKey);
        return children
            .filter((child): child is ZoteroItemRecord => Boolean(child?.data))
            .filter(child => child.data.itemType === "attachment")
            .filter(child => {
                const contentType = String(child.data.contentType || "");
                const name = String(child.data.filename || child.data.path || "");
                return contentType === "application/pdf" || /\.pdf$/i.test(name);
            })
            .map(child => {
                const data = child.data;
                const rawPath = String(data.path || "");
                const filename = String(data.filename || rawPath.replace(/^storage:/, "") || `${child.key}.pdf`);
                const path = resolveZoteroAttachmentPath({
                    dataDir,
                    attachmentKey: child.key,
                    path: rawPath,
                    filename,
                    enclosureHref: child.links?.enclosure?.href,
                });
                return {
                    attachmentKey: child.key,
                    attachmentTitle: String(data.title || filename),
                    filename,
                    path,
                    rawPath,
                    contentType: String(data.contentType || "application/pdf"),
                };
            });
    }
}
