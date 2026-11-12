import type {Plugin} from "siyuan";
import type {PluginHost} from "../host";
import {
    checkBlockExist,
    createDocWithMd,
    deleteBlock,
    getBlockAttrs,
    getBlockDom,
    getBlockKramdown,
    prependMarkdown,
    querySql,
    setBlockAttrs,
} from "../api";
import {generateArticleMeta, type GeneratedArticleMeta} from "./provider";

const STATE_KEY = "automation-state";
const SCAN_INTERVAL_MS = 15_000;
const STABLE_MS = 7_000;
const RETRY_MS = 10 * 60_000;
const SUMMARY_MARKER = "custom-ai-summary";
const INDEX_MARKER = "custom-ai-index";

interface AutomationDocState {
    title: string;
    updated: string;
    wordCount: number;
    summaryBlockId: string;
    category1: string;
    category2: string;
    category3: string;
    keywords: string[];
    model: string;
    summarizedAt: number;
    skipped?: boolean;
}

interface AutomationState {
    version: 1;
    notebookId: string;
    indexDocId: string;
    hiddenColumns: number[];
    docs: Record<string, AutomationDocState>;
}

interface DocRow {
    id: string;
    content: string;
    created: string;
    updated: string;
}

interface PendingDoc {
    updated: string;
    firstSeenAt: number;
}

function emptyState(notebookId: string): AutomationState {
    return {version: 1, notebookId, indexDocId: "", hiddenColumns: [], docs: {}};
}

const COLUMN_LABELS = ["序号", "标题", "一级分类", "二级分类", "三级分类", "关键词/标签", "创建时间", "更新时间", "字数", "打开"];

function filterMarkdown(hiddenColumns: number[]): string {
    const hidden = new Set(hiddenColumns);
    const links = COLUMN_LABELS.map((label, index) => {
        const column = index + 1;
        const mark = hidden.has(column) ? "☐" : "☑";
        return `[${mark} ${label}](siyuan://plugins/siyuan-pdf-zotero/automation-column?id=${column})`;
    });
    return `列筛选：${links.join(" ")}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function sqlString(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function escapeCell(value: unknown): string {
    return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function formatTime(value: string): string {
    const raw = String(value || "");
    if (/^\d{14}$/.test(raw)) {
        return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`;
    }
    return raw;
}

function plainText(kramdown: string): string {
    return String(kramdown || "")
        .replace(/^\s*---\s*$/gm, "")
        .replace(/^\s*\{:\s*id="[^"]*"[^}]*\}\s*$/gm, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/[`*_~>#|]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function countWords(text: string): number {
    const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const words = (text.replace(/[\u3400-\u9fff]/g, " ").match(/[A-Za-z0-9]+/g) || []).length;
    return cjk + words;
}

function calloutMarkdown(meta: GeneratedArticleMeta): string {
    const lines = [meta.summary, ""];
    for (const bullet of meta.bullets) {
        lines.push(`- ${bullet}`);
    }
    if (meta.keywords.length) {
        lines.push("", `关键词：${meta.keywords.join("、")}`);
    }
    return `> [!AI] 🤖 AI 摘要\n>\n${lines.map(line => line ? `> ${line}` : ">").join("\n")}`;
}

function tableMarkdown(rows: Array<[string, AutomationDocState]>, docs: DocRow[], indexDocId: string): string {
    const header = [
        "序号", "标题", "一级分类", "二级分类", "三级分类", "关键词/标签",
        "创建时间", "更新时间", "字数", "打开",
    ];
    const lines = [
        `| ${header.join(" | ")} |`,
        `| ${header.map(() => "---").join(" | ")} |`,
    ];
    const byId = new Map(rows);
    let number = 1;
    for (const doc of docs) {
        if (doc.id === indexDocId) continue;
        const state = byId.get(doc.id);
        const title = doc.content || "未命名";
        lines.push("| " + [
            String(number++),
            escapeCell(title),
            escapeCell(state?.category1 || "—"),
            escapeCell(state?.category2 || "—"),
            escapeCell(state?.category3 || "—"),
            escapeCell(state?.keywords?.join("、") || "—"),
            escapeCell(formatTime(doc.created)),
            escapeCell(formatTime(doc.updated)),
            escapeCell(state?.wordCount || "—"),
            `[打开](siyuan://blocks/${doc.id})`,
        ].join(" | ") + " |");
    }
    return lines.join("\n");
}

export class NotebookAutomation {
    private state: AutomationState;
    private timer = 0;
    private running = false;
    private pending = new Map<string, PendingDoc>();
    private failures = new Map<string, number>();

    constructor(
        private readonly host: PluginHost,
        private readonly plugin: Plugin,
    ) {
        const notebookId = host.store.state.settings.automationNotebookId || "";
        this.state = emptyState(notebookId);
    }

    start(): void {
        this.stop();
        const settings = this.host.store.state.settings;
        if (!settings.automationEnabled || !settings.automationNotebookId.trim()) {
            return;
        }
        void this.loadState().then(async () => {
            await this.removeModelFooters();
            await this.syncExistingTags();
            this.timer = window.setInterval(() => { void this.scan(); }, SCAN_INTERVAL_MS);
            void this.scan();
        });
    }

    stop(): void {
        if (this.timer) {
            window.clearInterval(this.timer);
            this.timer = 0;
        }
    }

    private log(event: string, data?: Record<string, unknown>): void {
        if (this.host.store.state.settings.automationDebug) {
            console.info(`[pdf-zotero][automation] ${event}`, data || {});
        }
    }

    private async loadState(): Promise<void> {
        const notebookId = this.host.store.state.settings.automationNotebookId.trim();
        let raw: any = null;
        try {
            raw = await this.plugin.loadData(STATE_KEY);
        } catch {
            raw = null;
        }
        if (raw && typeof raw === "object" && raw.notebookId === notebookId) {
            this.state = {
                version: 1,
                notebookId,
                indexDocId: String(raw.indexDocId || ""),
                hiddenColumns: Array.isArray(raw.hiddenColumns) ? raw.hiddenColumns.map(Number).filter(Number.isFinite) : [],
                docs: raw.docs && typeof raw.docs === "object" ? raw.docs : {},
            };
        } else {
            this.state = emptyState(notebookId);
        }
    }

    /** One-time compatibility cleanup for summaries generated before v0.3.2. */
    private async removeModelFooters(): Promise<void> {
        try {
            const summaries = await querySql<{block_id: string}>(
                "select block_id from attributes where name='custom-ai-summary' and value='true'",
            );
            for (const summary of summaries) {
                const footer = await querySql<{id: string}>(
                    `select id from blocks where parent_id=${sqlString(summary.block_id)} and type='p' and markdown like '模型：%' limit 1`,
                );
                const id = footer[0]?.id;
                if (id) await deleteBlock(id).catch((): void => {});
            }
        } catch (error) {
            this.log("footer-cleanup-failed", {error: String(error)});
        }
    }

    private async syncExistingTags(): Promise<void> {
        for (const [docId, docState] of Object.entries(this.state.docs)) {
            if (!docState.keywords?.length) continue;
            await this.syncDocTags(docId, docState.keywords, docState.keywords).catch((): void => {});
        }
    }

    private async syncDocTags(docId: string, keywords: string[], previousAiTags: string[] = []): Promise<void> {
        if (!keywords.length) return;
        const attrs = await getBlockAttrs(docId);
        const current = String(attrs.tags || "")
            .split(",")
            .map(item => item.trim())
            .filter(Boolean);
        const previous = new Set(previousAiTags.map(item => item.trim()).filter(Boolean));
        const merged: string[] = [];
        for (const tag of current) {
            if (!previous.has(tag) && !merged.includes(tag)) merged.push(tag);
        }
        for (const tag of keywords) {
            const value = tag.trim();
            if (value && !merged.includes(value)) merged.push(value);
        }
        await setBlockAttrs(docId, {tags: merged.join(",")});
    }

    private async saveState(): Promise<void> {
        try {
            await this.plugin.saveData(STATE_KEY, this.state);
        } catch (error) {
            console.warn("[pdf-zotero][automation] save state failed", error);
        }
    }

    private async scan(): Promise<void> {
        if (this.running) return;
        const settings = this.host.store.state.settings;
        if (!settings.automationEnabled) return;
        this.running = true;
        try {
            const notebookId = settings.automationNotebookId.trim();
            if (!notebookId) return;
            if (this.state.notebookId !== notebookId) {
                this.state = emptyState(notebookId);
                this.pending.clear();
            }
            const docs = await this.listDocs(notebookId);
            if (!docs.length) return;
            const indexDocId = await this.ensureIndexDoc(notebookId, docs);
            await this.saveState();
            const currentIds = new Set(docs.map(doc => doc.id));
            let changed = false;
            for (const id of Object.keys(this.state.docs)) {
                if (!currentIds.has(id)) {
                    delete this.state.docs[id];
                    changed = true;
                }
            }
            if (changed) {
                await this.saveState();
            }
            for (const doc of docs) {
                if (doc.id === indexDocId || doc.content === settings.automationIndexTitle) continue;
                if (this.state.docs[doc.id]) {
                    const existing = this.state.docs[doc.id];
                    if (existing.updated !== doc.updated) {
                        existing.updated = doc.updated;
                        existing.title = doc.content;
                        changed = true;
                    }
                    continue;
                }
                if (!settings.automationBackfill) {
                    this.state.docs[doc.id] = {
                        title: doc.content,
                        updated: doc.updated,
                        wordCount: 0,
                        summaryBlockId: "",
                        category1: "—",
                        category2: "—",
                        category3: "—",
                        keywords: [],
                        model: "",
                        summarizedAt: 0,
                        skipped: true,
                    };
                    changed = true;
                    continue;
                }
                const failedAt = this.failures.get(doc.id) || 0;
                if (failedAt && Date.now() - failedAt < RETRY_MS) continue;
                const pending = this.pending.get(doc.id);
                if (!pending || pending.updated !== doc.updated) {
                    this.pending.set(doc.id, {updated: doc.updated, firstSeenAt: Date.now()});
                    continue;
                }
                if (Date.now() - pending.firstSeenAt < STABLE_MS) continue;
                this.pending.delete(doc.id);
                changed = (await this.summarizeDoc(doc)) || changed;
            }
            if (changed) await this.saveState();
            await this.rebuildIndex(indexDocId, docs);
        } catch (error: any) {
            console.warn("[pdf-zotero][automation] scan failed", error?.message || error);
        } finally {
            this.running = false;
        }
    }

    private async listDocs(notebookId: string): Promise<DocRow[]> {
        return querySql<DocRow>(
            `select id, content, created, updated from blocks where box=${sqlString(notebookId)} and type='d' order by updated desc`,
        );
    }

    private async ensureIndexDoc(notebookId: string, docs: DocRow[]): Promise<string> {
        const settings = this.host.store.state.settings;
        const title = settings.automationIndexTitle.trim() || "📚 网页资源 · 文章索引";
        if (this.state.indexDocId && await checkBlockExist(this.state.indexDocId)) {
            return this.state.indexDocId;
        }
        const existing = docs.find(doc => doc.content === title);
        if (existing) {
            this.state.indexDocId = existing.id;
            await setBlockAttrs(existing.id, {[INDEX_MARKER]: "true"}).catch((): void => {});
            return existing.id;
        }
        const id = await createDocWithMd(notebookId, `/${title.replace(/[\\/:*?"<>|]/g, "_")}`, "");
        if (!id) throw new Error("创建索引文档失败");
        this.state.indexDocId = id;
        await setBlockAttrs(id, {[INDEX_MARKER]: "true"}).catch((): void => {});
        await sleep(300);
        return id;
    }

    private async summarizeDoc(doc: DocRow): Promise<boolean> {
        const settings = this.host.store.state.settings;
        try {
            const kramdown = await getBlockKramdown(doc.id);
            const text = plainText(kramdown);
            if (text.length < 80) {
                this.log("skip-short", {docId: doc.id, length: text.length});
                return false;
            }
            const existingSummary = await this.findSummaryBlock(doc.id);
            if (existingSummary) {
                this.state.docs[doc.id] = {
                    title: doc.content,
                    updated: doc.updated,
                    wordCount: countWords(text),
                    summaryBlockId: existingSummary,
                    category1: "—",
                    category2: "—",
                    category3: "—",
                    keywords: [],
                    model: "",
                    summarizedAt: Date.now(),
                };
                return true;
            }
            const existingPaths = Object.values(this.state.docs)
                .map(item => [item.category1, item.category2, item.category3].filter(Boolean).join(" / "))
                .filter(Boolean);
            const meta = await generateArticleMeta({
                title: doc.content,
                text,
                existingPaths,
                maxChars: Number(settings.automationMaxChars) || 450,
                modelId: settings.automationModelId,
            });
            await this.syncDocTags(
                doc.id,
                meta.keywords,
                this.state.docs[doc.id]?.keywords || [],
            ).catch((error): void => {
                this.log("tag-sync-failed", {docId: doc.id, error: String(error)});
            });
            const inserted = await prependMarkdown(doc.id, calloutMarkdown(meta));
            const summaryBlockId = inserted.ids[0] || "";
            if (summaryBlockId) {
                await setBlockAttrs(summaryBlockId, {
                    [SUMMARY_MARKER]: "true",
                    "custom-ai-model": meta.model,
                    "custom-ai-created": String(Date.now()),
                }).catch((): void => {});
            }
            this.state.docs[doc.id] = {
                title: doc.content,
                updated: doc.updated,
                wordCount: countWords(text),
                summaryBlockId,
                category1: meta.category1,
                category2: meta.category2,
                category3: meta.category3,
                keywords: meta.keywords,
                model: meta.model,
                summarizedAt: Date.now(),
            };
            this.log("summarized", {docId: doc.id, model: meta.model});
            return true;
        } catch (error: any) {
            this.failures.set(doc.id, Date.now());
            console.warn("[pdf-zotero][automation] summarize failed", doc.id, error?.message || error);
            return false;
        }
    }

    private async findSummaryBlock(docId: string): Promise<string> {
        try {
            const rows = await querySql<{block_id: string}>(
                `select block_id from attributes where name=${sqlString(SUMMARY_MARKER)} and value='true' and block_id in (select id from blocks where root_id=${sqlString(docId)}) limit 1`,
            );
            return rows[0]?.block_id || "";
        } catch {
            return "";
        }
    }

    async toggleIndexColumn(column: number): Promise<void> {
        if (!Number.isInteger(column) || column < 1 || column > COLUMN_LABELS.length) return;
        const hidden = new Set(this.state.hiddenColumns);
        if (hidden.has(column)) hidden.delete(column);
        else hidden.add(column);
        this.state.hiddenColumns = Array.from(hidden).sort((a, b) => a - b);
        await this.saveState();
        const settings = this.host.store.state.settings;
        if (!settings.automationNotebookId.trim() || !this.state.indexDocId) return;
        const docs = await this.listDocs(settings.automationNotebookId.trim());
        await this.rebuildIndex(this.state.indexDocId, docs);
    }

    private async rebuildIndex(indexDocId: string, docs: DocRow[]): Promise<void> {
        const rows = Object.entries(this.state.docs);
        const table = tableMarkdown(rows, docs, indexDocId);
        const filter = filterMarkdown(this.state.hiddenColumns);
        await sleep(150);
        try {
            const dom = await getBlockDom(indexDocId);
            const parsed = new DOMParser().parseFromString(dom, "text/html");
            for (const node of Array.from(parsed.body.children)) {
                const id = node.getAttribute("data-node-id");
                if (id) await deleteBlock(id).catch((): void => {});
            }
        } catch {
            // Empty/new index docs may not have a DOM yet; prepending still works.
        }
        const inserted = await prependMarkdown(indexDocId, `${filter}\n\n${table}`);
        await setBlockAttrs(indexDocId, {[INDEX_MARKER]: "true"}).catch((): void => {});
        let tableId = inserted.ids[inserted.ids.length - 1] || "";
        await sleep(150);
        try {
            const dom = await getBlockDom(indexDocId);
            const parsed = new DOMParser().parseFromString(dom, "text/html");
            tableId = parsed.querySelector<HTMLElement>('[data-type="NodeTable"]')?.getAttribute("data-node-id") || tableId;
        } catch {
            // keep the id returned by the insert transaction
        }
        if (!tableId) {
            const found = await querySql<{id: string}>(
                `select id from blocks where root_id=${sqlString(indexDocId)} and type='t' limit 1`,
            );
            tableId = found[0]?.id || "";
        }
        if (tableId) {
            await setBlockAttrs(tableId, {"custom-ai-hidden-cols": this.state.hiddenColumns.join(" ")}).catch((): void => {});
        }
        this.log("index-rebuilt", {docId: indexDocId, rows: docs.length, hiddenColumns: this.state.hiddenColumns});
    }
}
