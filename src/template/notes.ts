import {getActiveEditor, getAllEditor, showMessage} from "siyuan";
import {createDocWithMd, getChildBlocks, querySql, removeDocByID, updateBlockMarkdown} from "../api";
import type {PluginHost} from "../host";
import type {NoteTemplate, TemplateNoteBlock} from "../types";
import {ensureBuiltinTemplates, noteTitleFromPattern, templateLinkForItem} from "./model";
import {renderNoteTemplate} from "./runtime";

async function docBlocks(docId: string): Promise<TemplateNoteBlock[]> {
    const escaped = docId.replaceAll("'", "''");
    const children = await getChildBlocks(docId);
    if (children.length) return children;
    let rows: TemplateNoteBlock[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
        rows = await querySql<TemplateNoteBlock>(`select id, content, markdown from blocks where root_id='${escaped}' order by sort asc`);
        if (rows.length) return rows;
        await new Promise<void>(resolve => window.setTimeout(resolve, 200));
    }
    return rows;
}

async function docSnapshot(docId: string): Promise<string> {
    const rows = await docBlocks(docId);
    return rows.map(row => row.markdown || row.content || "").join("\n");
}

async function notebookOfDoc(docId: string): Promise<string> {
    const escaped = docId.replaceAll("'", "''");
    const rows = await querySql<{box: string}>(`select box from blocks where id='${escaped}' limit 1`);
    return rows[0]?.box || "";
}

async function mergeUnchangedBlocks(host: PluginHost, link: any, template: NoteTemplate, itemKey: string): Promise<boolean> {
    if (!link.blocks?.length) {
        showMessage("笔记已编辑，且没有可用的模板块快照", 5000, "error");
        return false;
    }
    const notebookId = await notebookOfDoc(link.docId);
    if (!notebookId) {
        showMessage("找不到笔记所在笔记本，无法刷新", 4000, "error");
        return false;
    }
    const rendered = renderNoteTemplate(host, template, itemKey);
    if (!rendered.html.trim()) {
        showMessage(`模板渲染结果为空：${rendered.errors[0] || "未知错误"}`, 5000, "error");
        return false;
    }
    const temporary = await createDocWithMd(notebookId, `/模板刷新快照-${Date.now()}`, rendered.html);
    if (!temporary) {
        showMessage("创建模板刷新快照失败", 4000, "error");
        return false;
    }
    try {
        const newBlocks = await docBlocks(temporary);
        const currentBlocks = await docBlocks(link.docId);
        let updated = 0;
        for (let index = 0; index < link.blocks.length; index++) {
            const oldBlock: TemplateNoteBlock = link.blocks[index];
            const currentBlock = currentBlocks[index];
            const newBlock = newBlocks[index];
            if (!currentBlock || !newBlock) continue;
            if (currentBlock.id !== oldBlock.id) continue;
            if ((currentBlock.content || "") !== (oldBlock.content || "")) continue;
            if ((newBlock.markdown || newBlock.content) === (oldBlock.markdown || oldBlock.content)) continue;
            await updateBlockMarkdown(currentBlock.id, newBlock.markdown || newBlock.content);
            updated++;
        }
        link.templateId = template.id;
        link.updatedAt = Date.now();
        link.blocks = await docBlocks(link.docId);
        link.snapshot = await docSnapshot(link.docId);
        await host.store.save();
        showMessage(updated ? `已只更新 ${updated} 个未编辑的元数据/模板块` : "没有可安全更新的模板块", updated ? 3500 : 3000);
        return updated > 0;
    } finally {
        await removeDocByID(temporary).catch((): void => undefined);
    }
}

export async function refreshTemplateNote(host: PluginHost, itemKey: string, templateId?: string): Promise<boolean> {
    const link = templateLinkForItem(host, itemKey);
    if (!link?.docId) {
        const docId = await createNoteFromTemplate(host, itemKey, templateId);
        return Boolean(docId);
    }
    const templates = ensureBuiltinTemplates(host);
    const template: NoteTemplate | undefined = templates.find(item => item.id === (templateId || host.store.state.settings.noteTemplateActiveId))
        || templates[0];
    if (!template) {
        showMessage("没有可用的笔记模板", 3000, "error");
        return false;
    }
    if (link.snapshot) {
        const current = await docSnapshot(link.docId);
        if (current && current !== link.snapshot) {
            return mergeUnchangedBlocks(host, link, template, itemKey);
        }
    }
    const rendered = renderNoteTemplate(host, template, itemKey);
    if (!rendered.html.trim()) {
        showMessage(`模板渲染结果为空：${rendered.errors[0] || "未知错误"}`, 5000, "error");
        return false;
    }
    await updateBlockMarkdown(link.docId, rendered.html);
    link.templateId = template.id;
    link.updatedAt = Date.now();
    link.blocks = await docBlocks(link.docId);
    link.snapshot = await docSnapshot(link.docId);
    await host.store.save();
    host.openDoc(link.docId);
    showMessage("已刷新模板笔记", 2500);
    return true;
}

export async function createNoteFromTemplate(host: PluginHost, itemKey: string, templateId?: string): Promise<string> {
    const existing = templateLinkForItem(host, itemKey);
    if (existing?.docId) {
        host.openDoc(existing.docId);
        return existing.docId;
    }
    const templates = ensureBuiltinTemplates(host);
    const template: NoteTemplate | undefined = templates.find(item => item.id === (templateId || host.store.state.settings.noteTemplateActiveId))
        || templates[0];
    if (!template) {
        showMessage("没有可用的笔记模板", 3000, "error");
        return "";
    }
    const item = (host.store.state.zotero.items || []).find(entry => entry.key === itemKey);
    if (!item) {
        showMessage("找不到 Zotero 条目", 3000, "error");
        return "";
    }
    const rendered = renderNoteTemplate(host, template, itemKey);
    if (!rendered.html.trim()) {
        showMessage(`模板渲染结果为空：${rendered.errors[0] || "未知错误"}`, 5000, "error");
        return "";
    }
    const editor = getActiveEditor() || getAllEditor()[0];
    const notebookId = host.store.state.settings.noteTemplateNotebookId.trim()
        || String(editor?.protyle?.notebookId || "");
    if (!notebookId) {
        showMessage("请先打开一个思源文档，或在模板设置中选择目标笔记本", 4000, "error");
        return "";
    }
    const year = String(item.year || item.csl?.issued?.["date-parts"]?.[0]?.[0] || "");
    const firstAuthor = String(item.creators?.[0] || "").split(/\s+/).slice(-1)[0] || "";
    const shortTitle = String(item.title || "").slice(0, 60);
    const title = noteTitleFromPattern(host.store.state.settings.noteTitlePattern, {year, firstAuthor, shortTitle, title: item.title});
    const folder = host.store.state.settings.noteTemplateFolder.trim().replace(/^\/+|\/+$/g, "");
    const path = `/${folder ? `${folder}/` : ""}${title}`;
    const docId = await createDocWithMd(notebookId, path, rendered.html);
    if (!docId) {
        showMessage("创建文献笔记失败", 4000, "error");
        return "";
    }
    for (const project of host.store.state.matrixProjects || []) {
        for (const row of project.rows) {
            if (row.itemKey === itemKey) {
                row.noteDocId = docId;
                project.updatedAt = Date.now();
            }
        }
    }
    host.store.state.templateNotes[itemKey] = {
        itemKey,
        docId,
        templateId: template.id,
        updatedAt: Date.now(),
        blocks: await docBlocks(docId),
        snapshot: "",
    };
    host.store.state.templateNotes[itemKey].snapshot = await docSnapshot(docId);
    await host.store.save();
    if (rendered.errors.length) {
        showMessage(`笔记已创建，模板有 ${rendered.errors.length} 个表达式错误`, 5000, "error");
    }
    host.openDoc(docId);
    return docId;
}
