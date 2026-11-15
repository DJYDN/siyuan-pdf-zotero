import {getActiveEditor, getAllEditor, showMessage} from "siyuan";
import {apiPost, appendMarkdown, getBlockDom, querySql, updateBlockDom, updateBlockMarkdown} from "./api";
import {formatCitationsAndBibliography} from "./citation/csl";
import {newId} from "./storage";
import {PLUGIN_NAME} from "./constants";
import type {CitationOptions, CitationRecord, CitationStyle, ReferencesBlock} from "./types";
import type {Store} from "./storage";

const CITATION_ROUTE = "citation";

export function citationHref(citationId: string): string {
    return `siyuan://plugins/${PLUGIN_NAME}/${CITATION_ROUTE}?id=${encodeURIComponent(citationId)}`;
}

export function parseCitationIdFromHref(href: string): string {
    const match = String(href || "").match(/\/citation\?id=([^&#"]+)/);
    return match ? decodeURIComponent(match[1]) : "";
}

export function citationIdsInMarkdown(markdown: string): string[] {
    const ids: string[] = [];
    const regex = /siyuan:\/\/plugins\/siyuan-pdf-zotero\/citation\?id=([^)"'\s]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(markdown))) {
        ids.push(decodeURIComponent(match[1]));
    }
    return ids;
}

function activeEditorForDoc(docId: string): any {
    return getAllEditor().find(editor => editor.protyle.block.rootID === docId) || getActiveEditor() || getAllEditor()[0];
}

export interface DocCitationBlock {
    blockId: string;
    markdown: string;
    citationIds: string[];
}

export async function getDocCitationBlocks(docId: string): Promise<DocCitationBlock[]> {
    const escapedDoc = docId.replaceAll("'", "''");
    const rows = await querySql<{id: string; markdown: string}>(`select id, sort, markdown from blocks where root_id = '${escapedDoc}' and markdown like '%siyuan://plugins/siyuan-pdf-zotero/citation?id=%' order by sort asc`);
    const blocks = rows.map(row => ({
        blockId: row.id,
        markdown: row.markdown || "",
        citationIds: citationIdsInMarkdown(row.markdown || ""),
    }));
    // The full-text index lags behind appendBlock/Protyle.insert, so fall back to a
    // kramdown scan for links the index has not caught up with yet.
    const seen = new Set(blocks.map(block => block.blockId));
    const escapedHash = `%${encodeURIComponent("siyuan://plugins")}%`;
    const candidates = await querySql<{id: string}>(`select id from blocks where root_id = '${escapedDoc}' and markdown like '${escapedHash}' order by sort asc`).catch((): any[] => []);
    for (const row of candidates) {
        if (seen.has(row.id)) {
            continue;
        }
        const kramdown = await apiPost<any>("/block/getBlockKramdown", {id: row.id})
            .then((data: any) => String(data?.kramdown || ""))
            .catch((): string => "");
        const ids = citationIdsInMarkdown(kramdown);
        if (ids.length) {
            blocks.push({blockId: row.id, markdown: kramdown, citationIds: ids});
            seen.add(row.id);
        }
    }
    return blocks;
}

export async function insertCitation(
    store: Store,
    itemKeys: string[],
    style: CitationStyle,
    options: CitationOptions = {},
): Promise<CitationRecord | null> {
    // Default target: the document the user is looking at. The sidebar keeps a
    // hidden editor instance whose activeElement is the body, so prefer the
    // visible editor when one exists and fall back to the focused one otherwise.
    const editors = getAllEditor();
    const editor = editors.find(item => item?.protyle?.wysiwyg?.element?.offsetParent)
        || getActiveEditor()
        || editors[0];
    if (!editor) {
        showMessage("请先打开一个思源文档，再插入引文");
        return null;
    }
    const docId = String(editor.protyle.block.rootID || "");
    if (!docId) {
        showMessage("无法确定当前文档 ID");
        return null;
    }
    const cacheItems = store.state.zotero.items;
    const items = itemKeys
        .map(key => cacheItems.find(item => item.key === key))
        .filter((item): item is NonNullable<typeof item> => Boolean(item?.csl));
    if (!items.length) {
        showMessage("缓存中没有可用的 Zotero 文献，请先刷新 Zotero", 5000, "error");
        return null;
    }
    const record: CitationRecord = {
        id: newId("cit"),
        siyuanDocId: docId,
        siyuanBlockId: "",
        items: items.map(item => ({
            libraryId: store.state.zotero.libraryId || 0,
            itemKey: item.key,
            csl: item.csl as Record<string, any>,
        })),
        style,
        options,
        visibleHtml: "[?]",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    const href = citationHref(record.id);
    // appendBlock is deterministic: Protyle.insert needs a focused editor, and the
    // window may not own focus when the command runs from the dock or a shortcut.
    const anchorBlockId = String(editor.protyle.block.id || "");
    const markdown = `[[?]](${href})`;
    let blockId = "";
    if (anchorBlockId) {
        const inserted = await apiPost<any>("/block/appendBlock", {
            parentID: anchorBlockId,
            dataType: "markdown",
            data: markdown,
        }).catch((): any => null);
        const ops = Array.isArray(inserted) ? inserted : [];
        for (const transaction of ops) {
            for (const op of transaction?.doOperations || []) {
                if (op?.action === "insert" && op?.id) {
                    blockId = String(op.id);
                    break;
                }
            }
            if (blockId) {
                break;
            }
        }
    }
    if (!blockId) {
        // Fallback for editors without a concrete block id (e.g. an empty document).
        editor.insert(`<span data-type="a" data-href="${href}" data-pz-citation="${record.id}">[?]</span>`, false, false);
        await new Promise(resolve => setTimeout(resolve, 260));
        const root = editor.protyle.wysiwyg?.element as HTMLElement | undefined;
        for (const element of Array.from(root?.querySelectorAll<HTMLElement>("[data-node-id]") || [])) {
            if (element.querySelector(`[data-href="${href}"]`)) {
                blockId = element.dataset.nodeId || "";
                break;
            }
        }
    }
    record.siyuanBlockId = blockId;
    store.state.citations[record.id] = record;
    await store.save();
    await refreshDocumentCitations(store, docId);
    return store.state.citations[record.id];
}

interface CitationRefreshResult {
    ok: boolean;
    citationCount: number;
    references: string[];
    style: CitationStyle;
    debug?: Record<string, any>;
}

function styleForRecords(records: CitationRecord[]): CitationStyle {
    return records[0]?.style || "gbt7714";
}

function allCslItems(records: CitationRecord[]): Record<string, any>[] {
    const seen = new Set<string>();
    const items: Record<string, any>[] = [];
    for (const record of records) {
        for (const item of record.items) {
            const id = String(item.csl.id);
            if (!seen.has(id)) {
                seen.add(id);
                items.push(item.csl);
            }
        }
    }
    return items;
}

async function updateCitationSpans(blocks: DocCitationBlock[], visibleById: Map<string, string>): Promise<void> {
    for (const block of blocks) {
        let dom: string;
        try {
            dom = await getBlockDom(block.blockId);
        } catch {
            continue;
        }
        if (!dom) {
            continue;
        }
        const parsed = new DOMParser().parseFromString(dom, "text/html");
        let changed = false;
        for (const span of Array.from(parsed.querySelectorAll<HTMLElement>('[data-href*="/citation?id="]'))) {
            const id = parseCitationIdFromHref(span.dataset.href || span.getAttribute("href") || "");
            const visible = visibleById.get(id);
            if (visible !== undefined && span.innerHTML !== visible) {
                span.innerHTML = visible;
                changed = true;
            }
        }
        if (changed) {
            await updateBlockDom(block.blockId, parsed.body.innerHTML);
        }
    }
}

async function blockUsable(id: string): Promise<boolean> {
    if (!id) return false;
    try {
        return Boolean((await getBlockDom(id)).trim());
    } catch {
        return false;
    }
}

async function updateReferences(store: Store, docId: string, style: CitationStyle, entries: string[]): Promise<string[]> {
    // One paragraph block with hard line breaks. Unlike a markdown list this has no
    // child blocks, so refresh replaces it in place without accumulating duplicates.
    const markdown = entries.map((entry, index) => entry || `[${index + 1}]`).join("  \n");
    const existing = store.state.references[docId];
    if (existing) {
        let headingBlockId = existing.headingBlockId;
        if (!await blockUsable(headingBlockId)) {
            const heading = await appendMarkdown(docId, "#### 参考文献");
            headingBlockId = heading.ids[0] || "";
        }
        if (!await blockUsable(existing.listBlockId)) {
            const list = await appendMarkdown(docId, markdown);
            existing.listBlockId = list.ids[0] || "";
            existing.headingBlockId = headingBlockId;
            existing.style = style;
            existing.updatedAt = Date.now();
            return entries;
        }
        try {
            await updateBlockMarkdown(existing.listBlockId, markdown);
            existing.headingBlockId = headingBlockId;
            existing.style = style;
            existing.updatedAt = Date.now();
            return entries;
        } catch {
            const list = await appendMarkdown(docId, markdown);
            existing.listBlockId = list.ids[0] || "";
            existing.headingBlockId = headingBlockId;
            existing.style = style;
            existing.updatedAt = Date.now();
            return entries;
        }
    }
    const heading = await appendMarkdown(docId, "#### 参考文献");
    const list = await appendMarkdown(docId, markdown);
    const refs: ReferencesBlock = {
        docId,
        headingBlockId: heading.ids[0] || "",
        listBlockId: list.ids[0] || "",
        style,
        updatedAt: Date.now(),
    };
    store.state.references[docId] = refs;
    return entries;
}

export async function refreshDocumentCitations(store: Store, docId: string): Promise<CitationRefreshResult> {
    const blocks = await getDocCitationBlocks(docId);
    const orderedIds = blocks.flatMap(block => block.citationIds);
    const records: CitationRecord[] = [];
    const seen = new Set<string>();
    for (const id of orderedIds) {
        const record = store.state.citations[id];
        if (!record || seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
    }
    // The block index can lag a few hundred ms behind Protyle.insert(). Only fall
    // back to a structured record when its block still contains that citation;
    // stale records from manually deleted citations must not enter the numbering.
    const docRecords = Object.values(store.state.citations)
        .filter(record => record.siyuanDocId === docId)
        .sort((a, b) => a.createdAt - b.createdAt);
    for (const record of docRecords) {
        if (seen.has(record.id) || !record.siyuanBlockId) continue;
        try {
            const dom = await getBlockDom(record.siyuanBlockId);
            if (!dom.includes(record.id)) continue;
        } catch {
            continue;
        }
        seen.add(record.id);
        records.push(record);
        if (!blocks.some(block => block.blockId === record.siyuanBlockId)) {
            blocks.push({blockId: record.siyuanBlockId, markdown: "", citationIds: [record.id]});
        }
    }
    if (!records.length) {
        if (store.state.references[docId]) {
            await updateReferences(store, docId, store.state.settings.defaultCitationStyle, []);
            await store.save();
        }
        return {ok: true, citationCount: 0, references: [], style: store.state.settings.defaultCitationStyle};
    }
    const style = styleForRecords(records);
    const items = allCslItems(records);
    const clusters = records.map(record => ({
        id: record.id,
        cslIds: record.items.map(item => String(item.csl.id)),
        options: record.options,
    }));
    const formatted = await formatCitationsAndBibliography(clusters, items, style);
    const visibleById = new Map<string, string>();
    records.forEach((record, index) => {
        record.visibleHtml = formatted.citations[index];
        record.style = style;
        record.updatedAt = Date.now();
        visibleById.set(record.id, formatted.citations[index]);
    });
    await updateCitationSpans(blocks, visibleById);
    await updateReferences(store, docId, style, formatted.bibliography);
    await store.save();
    return {
        ok: true,
        citationCount: records.length,
        references: formatted.bibliography,
        style,
        debug: {
            blockRows: blocks.map(block => ({id: block.blockId, ids: block.citationIds})),
            orderedIds,
            docRecordIds: docRecords.map(record => record.id),
            recordIds: records.map(record => record.id),
        },
    };
}

export async function updateCitation(
    store: Store,
    citationId: string,
    patch: {style?: CitationStyle; options?: CitationOptions},
): Promise<void> {
    const record = store.state.citations[citationId];
    if (!record) {
        return;
    }
    if (patch.style) {
        record.style = patch.style;
    }
    if (patch.options) {
        record.options = {...record.options, ...patch.options};
    }
    record.updatedAt = Date.now();
    await store.save();
    await refreshDocumentCitations(store, record.siyuanDocId);
}

export async function setDocumentCitationStyle(store: Store, docId: string, style: CitationStyle): Promise<void> {
    for (const record of Object.values(store.state.citations)) {
        if (record.siyuanDocId === docId) {
            record.style = style;
            record.updatedAt = Date.now();
        }
    }
    await store.save();
    await refreshDocumentCitations(store, docId);
}

export async function deleteCitation(store: Store, citationId: string): Promise<void> {
    const record = store.state.citations[citationId];
    if (!record) {
        return;
    }
    const blocks = await getDocCitationBlocks(record.siyuanDocId);
    const block = blocks.find(item => item.citationIds.includes(citationId));
    if (block) {
        try {
            const dom = await getBlockDom(block.blockId);
            const parsed = new DOMParser().parseFromString(dom, "text/html");
            for (const span of Array.from(parsed.querySelectorAll<HTMLElement>('[data-href*="/citation?id="]'))) {
                if (parseCitationIdFromHref(span.dataset.href || "") === citationId) {
                    span.remove();
                }
            }
            await updateBlockDom(block.blockId, parsed.body.innerHTML);
        } catch {
            // ignore
        }
    }
    delete store.state.citations[citationId];
    await store.save();
    await refreshDocumentCitations(store, record.siyuanDocId);
}

export function citationEditorForDoc(docId: string): any | null {
    return activeEditorForDoc(docId) || null;
}
