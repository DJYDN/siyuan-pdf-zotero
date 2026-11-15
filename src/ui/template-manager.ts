import {Dialog, showMessage} from "siyuan";
import type {PluginHost} from "../host";
import type {NoteTemplate} from "../types";
import {ensureBuiltinTemplates} from "../template/model";
import {renderNoteTemplate} from "../template/runtime";
import {createNoteFromTemplate, refreshTemplateNote} from "../template/notes";
import {newId} from "../storage";
import {listNotebooks} from "../api";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch] as string));
}

export function openTemplateManager(host: PluginHost): Dialog {
    ensureBuiltinTemplates(host);
    const templates = () => host.store.state.noteTemplates;
    let active = templates().find(item => item.id === host.store.state.settings.noteTemplateActiveId) || templates()[0];
    const items = (host.store.state.zotero.items || []).slice(0, 800);
    const dialog = new Dialog({
        title: "默认笔记模板",
        width: "1100px",
        content: `<div class="b3-dialog__content pz-template-manager">
  <div class="pz-matrix-toolbar">
    <select class="b3-select" data-role="template-select"></select>
    <button class="b3-button b3-button--outline" data-act="template-new">新建模板</button>
    <button class="b3-button b3-button--outline" data-act="template-delete">删除模板</button>
    <button class="b3-button b3-button--outline" data-act="template-create-note">用模板创建笔记</button>
    <button class="b3-button b3-button--outline" data-act="template-refresh-note">刷新当前笔记</button>
    <button class="b3-button b3-button--outline" data-act="template-import">导入模板文件</button>
    <input type="file" data-role="template-file" accept=".json,.html,.htm,.txt,.md" style="display:none" />
  </div>
  <div class="fn__flex" style="gap:8px;margin-bottom:6px">
    <input class="b3-text-field" data-role="template-name" placeholder="模板名称" style="flex:1" />
    <input class="b3-text-field" data-role="template-title-pattern" title="默认标题格式" placeholder="{{year}}-{{firstAuthor}}-{{shortTitle}}" style="flex:1" />
  </div>
  <div class="fn__flex" style="gap:8px;margin-bottom:6px">
    <select class="b3-select" data-role="template-notebook-select" style="flex:1"><option value="">目标笔记本：当前文档</option></select>
    <input class="b3-text-field" data-role="template-notebook" placeholder="目标笔记本 ID（留空=当前文档）" style="flex:1" />
    <input class="b3-text-field" data-role="template-folder" placeholder="笔记子目录（可选，例如 /文献笔记）" style="flex:1" />
    <select class="b3-select" data-role="template-item" style="flex:1"></select>
  </div>
  <textarea class="b3-text-field fn__block" data-role="template-content" rows="18" style="resize:vertical;font-family:var(--b3-font-family-code)"></textarea>
  <div class="pz-muted" style="margin-top:4px">模板支持 Better Notes 风格 <code>\${表达式}</code> 与 <code>\${{代码块}}\$</code>；当前为受信任本地执行。</div>
  <div class="pz-template-preview" data-role="template-preview"></div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="template-cancel">关闭</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="template-save">保存模板</button></div>`,
    });
    const select = dialog.element.querySelector<HTMLSelectElement>('[data-role="template-select"]')!;
    const name = dialog.element.querySelector<HTMLInputElement>('[data-role="template-name"]')!;
    const titlePattern = dialog.element.querySelector<HTMLInputElement>('[data-role="template-title-pattern"]')!;
    const notebook = dialog.element.querySelector<HTMLInputElement>('[data-role="template-notebook"]')!;
    const notebookSelect = dialog.element.querySelector<HTMLSelectElement>('[data-role="template-notebook-select"]')!;
    const folder = dialog.element.querySelector<HTMLInputElement>('[data-role="template-folder"]')!;
    const content = dialog.element.querySelector<HTMLTextAreaElement>('[data-role="template-content"]')!;
    const itemSelect = dialog.element.querySelector<HTMLSelectElement>('[data-role="template-item"]')!;
    const preview = dialog.element.querySelector<HTMLElement>('[data-role="template-preview"]')!;
    titlePattern.value = host.store.state.settings.noteTitlePattern || "{{year}}-{{firstAuthor}}-{{shortTitle}}";
    notebook.value = host.store.state.settings.noteTemplateNotebookId || "";
    folder.value = host.store.state.settings.noteTemplateFolder || "";
    void listNotebooks().then(items => {
        notebookSelect.innerHTML = `<option value="">目标笔记本：当前文档</option>` + items.filter(item => !item.closed).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
        notebookSelect.value = notebook.value;
    }).catch((): void => undefined);
    notebookSelect.addEventListener("change", () => { notebook.value = notebookSelect.value; });
    itemSelect.innerHTML = items.map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.title || item.key)}</option>`).join("");
    const render = () => {
        select.innerHTML = templates().map(item => `<option value="${escapeHtml(item.id)}" ${item.id === active.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
        name.value = active.name;
        content.value = active.content;
        const itemKey = itemSelect.value;
        if (itemKey) {
            const result = renderNoteTemplate(host, active, itemKey);
            preview.innerHTML = `<div class="pz-muted">预览${result.errors.length ? `（${result.errors.length} 个错误）` : ""}</div><div class="pz-template-preview-content">${result.html}</div>`;
        }
    };
    render();
    select.addEventListener("change", () => {
        active = templates().find(item => item.id === select.value) || active;
        host.store.state.settings.noteTemplateActiveId = active.id;
        void host.store.save();
        render();
    });
    itemSelect.addEventListener("change", render);
    content.addEventListener("input", () => {
        active.content = content.value;
        active.updatedAt = Date.now();
    });
    name.addEventListener("input", () => { active.name = name.value; });
    dialog.element.querySelector('[data-act="template-save"]')?.addEventListener("click", async () => {
        host.store.state.settings.noteTemplateActiveId = active.id;
        host.store.state.settings.noteTitlePattern = titlePattern.value.trim() || "{{year}}-{{firstAuthor}}-{{shortTitle}}";
        host.store.state.settings.noteTemplateNotebookId = notebook.value.trim();
        host.store.state.settings.noteTemplateFolder = folder.value.trim();
        await host.store.save();
        showMessage("模板已保存", 2000);
        render();
    });
    dialog.element.querySelector('[data-act="template-new"]')?.addEventListener("click", async () => {
        const now = Date.now();
        const template: NoteTemplate = {
            id: newId("template"),
            name: "新模板",
            content: `<h1>\${topItem.getField("title") || ""}</h1>\n<h2>摘要</h2>\n<p>\${topItem.getField("abstractNote") || ""}</p>\n<h2>我的笔记</h2>\n<p></p>`,
            builtin: false,
            trusted: true,
            createdAt: now,
            updatedAt: now,
        };
        host.store.state.noteTemplates.push(template);
        host.store.state.settings.noteTemplateActiveId = template.id;
        active = template;
        await host.store.save();
        render();
    });
    dialog.element.querySelector('[data-act="template-delete"]')?.addEventListener("click", async () => {
        if (active.builtin) {
            showMessage("内置模板不可删除", 2500);
            return;
        }
        host.store.state.noteTemplates = templates().filter(item => item.id !== active.id);
        host.store.state.settings.noteTemplateActiveId = host.store.state.noteTemplates[0]?.id || "";
        active = host.store.state.noteTemplates[0];
        await host.store.save();
        render();
    });
    dialog.element.querySelector('[data-act="template-create-note"]')?.addEventListener("click", async () => {
        const itemKey = itemSelect.value;
        if (!itemKey) {
            showMessage("没有可用的 Zotero 条目", 3000);
            return;
        }
        await createNoteFromTemplate(host, itemKey, active.id);
    });
    dialog.element.querySelector('[data-act="template-refresh-note"]')?.addEventListener("click", async () => {
        const itemKey = itemSelect.value;
        if (!itemKey) return;
        if (!window.confirm("刷新会覆盖模板生成的内容，包括你在这篇笔记中的编辑。继续？")) return;
        await refreshTemplateNote(host, itemKey, active.id);
    });
    const fileInput = dialog.element.querySelector<HTMLInputElement>('[data-role="template-file"]')!;
    dialog.element.querySelector('[data-act="template-import"]')?.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const text = await file.text();
        let name = file.name.replace(/\.[^.]+$/, "");
        let templateContent = text;
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && typeof parsed.content === "string") {
                name = String(parsed.name || name);
                templateContent = parsed.content;
            }
        } catch {
            // plain text/HTML template
        }
        const now = Date.now();
        const template: NoteTemplate = {
            id: newId("template"),
            name,
            content: templateContent,
            builtin: false,
            trusted: true,
            createdAt: now,
            updatedAt: now,
        };
        host.store.state.noteTemplates.push(template);
        host.store.state.settings.noteTemplateActiveId = template.id;
        active = template;
        await host.store.save();
        fileInput.value = "";
        render();
        showMessage(`已导入模板：${name}`, 2500);
    });
    dialog.element.querySelector('[data-act="template-cancel"]')?.addEventListener("click", () => dialog.destroy());
    return dialog;
}
