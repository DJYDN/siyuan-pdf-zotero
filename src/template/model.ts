import {newId} from "../storage";
import type {NoteTemplate, TemplateNoteLink} from "../types";

export function builtInTemplates(): NoteTemplate[] {
    const now = Date.now();
    return [
        {
            id: "template-academic-reading",
            name: "学术阅读（推荐）",
            builtin: true,
            trusted: true,
            createdAt: now,
            updatedAt: now,
            content: `<!-- 标题 -->
<h1 style="color:#193c47; background-color:#eef9fd; padding:8px;">\${topItem.getField("title") || ""}</h1>

<!-- 元数据 -->
<table>
<tr><td><b>作者：</b>\${topItem.getCreators().map(v => v.firstName + " " + v.lastName).join("; ")}</td></tr>
<tr><td><b>期刊：</b>\${topItem.getField("publicationTitle") || ""}</td></tr>
<tr><td><b>年份：</b>\${topItem.getField("date") || ""}</td></tr>
<tr><td><b>DOI：</b>\${topItem.getField("DOI") || ""}</td></tr>
<tr><td><b>摘要：</b><i>\${topItem.getField("abstractNote") || ""}</i></td></tr>
</table>

<h2>研究核心</h2>
<blockquote>做了什么工作，解决了什么问题，创新点和不足是什么？</blockquote>
<h3>内容</h3><p></p>
<h3>创新点</h3><p></p>
<h3>不足之处</h3><p></p>

<h2>研究内容</h2>
<h3>数据</h3><p></p>
<h3>方法</h3><p></p>
<h3>实验</h3><p></p>
<h3>结论</h3><p></p>

<h2>个人总结</h2>
<blockquote>还有哪些疑问？可以如何改进？</blockquote>
<h3>关键记录</h3><p></p>
<h3>待解决问题</h3><p></p>
<h3>思考启发</h3><p></p>`,
        },
        {
            id: "template-minimal",
            name: "极简元数据",
            builtin: true,
            trusted: true,
            createdAt: now,
            updatedAt: now,
            content: `<h1>\${topItem.getField("title") || ""}</h1>
<p><b>作者：</b>\${topItem.getCreators().map(v => v.firstName + " " + v.lastName).join("; ")}</p>
<p><b>年份：</b>\${topItem.getField("date") || ""}</p>
<p><b>期刊：</b>\${topItem.getField("publicationTitle") || ""}</p>
<p><b>DOI：</b>\${topItem.getField("DOI") || ""}</p>
<h2>摘要</h2>
<p>\${topItem.getField("abstractNote") || ""}</p>
<h2>我的笔记</h2>
<p></p>`,
        },
    ];
}

export function ensureBuiltinTemplates(host: {store: any}): NoteTemplate[] {
    const current = host.store.state.noteTemplates as NoteTemplate[] | undefined;
    if (current?.length) return current;
    const templates = builtInTemplates();
    host.store.state.noteTemplates = templates;
    if (!host.store.state.settings.noteTemplateActiveId) {
        host.store.state.settings.noteTemplateActiveId = templates[0].id;
    }
    void host.store.save();
    return templates;
}

export function templateLinkForItem(host: {store: any}, itemKey: string): TemplateNoteLink | undefined {
    return host.store.state.templateNotes?.[itemKey];
}

export function noteTitleFromPattern(pattern: string, data: {year?: string; firstAuthor?: string; shortTitle?: string; title?: string}): string {
    return String(pattern || "{{title}}")
        .replaceAll("{{year}}", data.year || "")
        .replaceAll("{{firstAuthor}}", data.firstAuthor || "")
        .replaceAll("{{shortTitle}}", data.shortTitle || "")
        .replaceAll("{{title}}", data.title || "")
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\s+/g, " ")
        .trim() || newId("note");
}
