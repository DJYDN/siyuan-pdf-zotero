import {Dialog, showMessage} from "siyuan";
import type {PluginHost} from "../host";
import {createDocWithMd, listNotebooks} from "../api";
import {insertMarkdownAtCursor} from "../siyuan";
import {renderQaMarkdown} from "../qa/render";
import {DEFAULT_CLEAN_OPTIONS, cleanDoc2xMarkdown, type CleanOptions} from "../doc2x/clean";
import {readParseMarkdown, updateParseRecord, writeParseMarkdown, type ParseRecord} from "../doc2x/library";
import {markdownForPreview} from "../doc2x/assets";

function escapeHtml(text: string): string {
    return String(text ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch] as string));
}

function cleanOptionsHtml(options: CleanOptions): string {
    const rows: Array<[keyof CleanOptions, string]> = [
        ["math", "公式分隔符（\\[...\\] → $$...$$）"],
        ["tables", "HTML 表格 → Markdown 表格"],
        ["html", "移除 Doc2X HTML 包装标签"],
        ["comments", "移除 HTML 注释"],
    ];
    return rows.map(([key, label]) => `<label class="fn__flex" style="align-items:center;gap:6px;font-size:12px"><input type="checkbox" data-clean-option="${key}" ${options[key] ? "checked" : ""}/> ${escapeHtml(label)}</label>`).join("");
}

export function openParsePreview(host: PluginHost, record: ParseRecord): Dialog {
    // Base the preview on the cleaned/stored Markdown (images already point at SiYuan assets);
    // raw.md is kept on disk only as a manual recovery source.
    const raw = readParseMarkdown(record) || readParseMarkdown(record, true);
    const dialog = new Dialog({
        title: `解析结果预览 · ${record.sourceTitle || record.fingerprint}`,
        width: "980px",
        height: "720px",
        content: `<div class="b3-dialog__content" style="display:flex;flex-direction:column;gap:8px;height:100%">
  <div class="fn__flex" style="gap:12px;align-items:center;flex-wrap:wrap">
    <div class="fn__flex" style="gap:6px">
      <button class="b3-button b3-button--outline" data-role="preview-tab" data-tab="rendered">渲染</button>
      <button class="b3-button b3-button--outline" data-role="preview-tab" data-tab="source">源码</button>
    </div>
    <span class="pz-muted" data-role="preview-meta" style="font-size:12px"></span>
    <div class="fn__flex" style="gap:8px;flex-wrap:wrap;margin-left:auto" data-role="clean-options">${cleanOptionsHtml(DEFAULT_CLEAN_OPTIONS)}</div>
  </div>
  <div data-role="preview-warnings" class="pz-muted" style="font-size:12px;color:#b45309"></div>
  <div data-role="preview-rendered" style="flex:1;overflow:auto;border:1px solid var(--b3-border-color);border-radius:8px;padding:18px 22px;background:var(--b3-theme-background)"></div>
  <pre data-role="preview-source" style="display:none;flex:1;overflow:auto;border:1px solid var(--b3-border-color);border-radius:8px;padding:14px;margin:0;background:var(--b3-theme-surface);white-space:pre-wrap;font-size:12px"></pre>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--text" data-act="preview-cancel">取消</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--outline" data-act="preview-save">仅保存</button>
  <button class="b3-button b3-button--outline" data-act="preview-new-doc">新建文档</button>
  <button class="b3-button b3-button--primary" data-act="preview-insert">插入光标</button>
</div>`,
    });
    const root = dialog.element;
    const rendered = root.querySelector<HTMLElement>('[data-role="preview-rendered"]')!;
    const source = root.querySelector<HTMLElement>('[data-role="preview-source"]')!;
    const warnings = root.querySelector<HTMLElement>('[data-role="preview-warnings"]')!;
    const meta = root.querySelector<HTMLElement>('[data-role="preview-meta"]')!;
    let options: CleanOptions = {...DEFAULT_CLEAN_OPTIONS};
    let currentMarkdown = "";

    const apply = (): void => {
        const result = cleanDoc2xMarkdown(raw, options);
        currentMarkdown = result.markdown;
        rendered.innerHTML = renderQaMarkdown(markdownForPreview(result.markdown));
        source.textContent = result.markdown;
        warnings.textContent = result.warnings.join(" ");
        meta.textContent = `${result.markdown.length} 字符 · ${result.markdown.split("\n").length} 行`;
    };
    const showTab = (tab: "rendered" | "source"): void => {
        rendered.style.display = tab === "rendered" ? "" : "none";
        source.style.display = tab === "source" ? "" : "none";
        for (const button of Array.from(root.querySelectorAll<HTMLElement>("[data-role=preview-tab]"))) {
            button.classList.toggle("b3-button--primary", button.dataset.tab === tab);
        }
    };
    for (const button of Array.from(root.querySelectorAll<HTMLElement>("[data-role=preview-tab]"))) {
        button.addEventListener("click", () => showTab(button.dataset.tab === "source" ? "source" : "rendered"));
    }
    for (const input of Array.from(root.querySelectorAll<HTMLInputElement>("[data-clean-option]"))) {
        input.addEventListener("change", () => {
            options = {...options, [input.dataset.cleanOption as keyof CleanOptions]: input.checked};
            apply();
        });
    }
    const saveToRecord = (): void => {
        writeParseMarkdown(record, currentMarkdown);
        updateParseRecord(record.id, {mdPath: record.mdPath});
    };
    root.querySelector('[data-act="preview-cancel"]')?.addEventListener("click", () => dialog.destroy());
    root.querySelector('[data-act="preview-save"]')?.addEventListener("click", () => {
        saveToRecord();
        showMessage("解析结果已保存到解析历史", 2200);
        dialog.destroy();
        host.refreshDock();
    });
    root.querySelector('[data-act="preview-insert"]')?.addEventListener("click", async () => {
        saveToRecord();
        const target = host.captureNoteInsertionTarget();
        const blockId = await insertMarkdownAtCursor(currentMarkdown, target);
        if (!blockId) {
            showMessage("插入失败：请先打开一个思源文档", 4000, "error");
            return;
        }
        updateParseRecord(record.id, {noteDocId: target.docId, noteBlockId: blockId});
        showMessage("解析结果已插入当前笔记", 2200);
        dialog.destroy();
        host.refreshDock();
    });
    root.querySelector('[data-act="preview-new-doc"]')?.addEventListener("click", async () => {
        saveToRecord();
        void openNewDocDialog(host, record, currentMarkdown, dialog);
    });
    apply();
    showTab("rendered");
    return dialog;
}

async function openNewDocDialog(host: PluginHost, record: ParseRecord, markdown: string, parent: Dialog): Promise<void> {
    const notebooks = await listNotebooks().catch((): any[] => []);
    if (!notebooks.length) {
        showMessage("没有可用的笔记本，无法新建文档", 4000, "error");
        return;
    }
    const defaultNotebook = notebooks.find(item => !item.closed)?.id || notebooks[0].id;
    const title = (record.sourceTitle || "Doc2X 解析结果").replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 80) || "Doc2X 解析结果";
    const dialog = new Dialog({
        title: "新建文档",
        width: "520px",
        content: `<div class="b3-dialog__content">
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px"><span>笔记本</span><select class="b3-select fn__block" data-role="new-doc-notebook">${notebooks.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === defaultNotebook ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label>
  <label class="fn__flex" style="flex-direction:column;gap:4px"><span>文档标题</span><input class="b3-text-field fn__block" data-role="new-doc-title" value="${escapeHtml(title)}" /></label>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="new-doc-cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--primary" data-act="new-doc-create">创建</button></div>`,
    });
    dialog.element.querySelector('[data-act="new-doc-cancel"]')?.addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector('[data-act="new-doc-create"]')?.addEventListener("click", async () => {
        const notebook = dialog.element.querySelector<HTMLSelectElement>('[data-role="new-doc-notebook"]')?.value || defaultNotebook;
        const docTitle = dialog.element.querySelector<HTMLInputElement>('[data-role="new-doc-title"]')?.value.trim() || title;
        try {
            const docId = await createDocWithMd(notebook, `/${docTitle}`, markdown);
            updateParseRecord(record.id, {noteDocId: docId});
            host.openDoc(docId);
            showMessage("已新建文档", 2200);
            dialog.destroy();
            parent.destroy();
            host.refreshDock();
        } catch (error: any) {
            showMessage(`新建文档失败：${String(error?.message || error).slice(0, 160)}`, 5000, "error");
        }
    });
}
