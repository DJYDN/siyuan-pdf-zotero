import {Dialog, showMessage} from "siyuan";
import {CITATION_STYLES} from "../citation/csl";
import {deleteCitation, insertCitation, updateCitation} from "../citations";
import type {CitationRecord, CitationStyle} from "../types";
import type {Store} from "../storage";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch] as string));
}

export interface CitationDialogOptions {
    store: Store;
    citation?: CitationRecord;
}

export function openCitationDialog(options: CitationDialogOptions): Dialog {
    const {store, citation} = options;
    const selected = new Set<string>(citation?.items.map(item => item.itemKey) || []);
    const dialog = new Dialog({
        title: citation ? "编辑引文" : "插入 Zotero 引文",
        width: "760px",
        content: `<div class="b3-dialog__content pz-citation-dialog">
  <div class="pz-citation-search-row">
    <input class="b3-text-field fn__block" data-role="citation-search" placeholder="搜索标题、作者、年份、DOI" />
  </div>
  <div class="pz-citation-results" data-role="citation-results"></div>
  <div class="pz-citation-form">
    <label class="fn__flex" style="flex-direction:column;gap:4px">
      <span>引用样式</span>
      <select class="b3-select fn__block" data-role="citation-style">
        ${Object.entries(CITATION_STYLES).map(([key, meta]) => `<option value="${key}" ${((citation?.style || store.state.settings.defaultCitationStyle) === key) ? "selected" : ""}>${escapeHtml(meta.label)}</option>`).join("")}
      </select>
    </label>
    <label class="fn__flex" style="flex-direction:column;gap:4px">
      <span>页码/定位词 locator（可选）</span>
      <input class="b3-text-field fn__block" data-role="citation-locator" value="${escapeHtml(citation?.options.locator || "")}" placeholder="例如 12 或 12-14" />
    </label>
    <div class="fn__flex" style="gap:8px">
      <label class="fn__flex-1" style="flex-direction:column;gap:4px"><span>前缀 prefix</span><input class="b3-text-field fn__block" data-role="citation-prefix" value="${escapeHtml(citation?.options.prefix || "")}" /></label>
      <label class="fn__flex-1" style="flex-direction:column;gap:4px"><span>后缀 suffix</span><input class="b3-text-field fn__block" data-role="citation-suffix" value="${escapeHtml(citation?.options.suffix || "")}" /></label>
    </div>
    <label class="fn__flex" style="gap:6px;align-items:center"><input type="checkbox" data-role="citation-suppress" ${citation?.options.suppressAuthor ? "checked" : ""}/> 隐藏作者（suppress author）</label>
    <div class="pz-citation-selected" data-role="citation-selected"></div>
  </div>
</div>
<div class="b3-dialog__action">
  ${citation ? '<button class="b3-button b3-button--cancel" data-act="citation-delete">删除引文</button><div class="fn__space"></div>' : ""}
  <button class="b3-button b3-button--cancel" data-act="citation-cancel">取消</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-act="citation-save">${citation ? "保存" : "插入"}</button>
</div>`,
    });

    const search = dialog.element.querySelector<HTMLInputElement>('[data-role="citation-search"]')!;
    const results = dialog.element.querySelector<HTMLElement>('[data-role="citation-results"]')!;
    const selectedBox = dialog.element.querySelector<HTMLElement>('[data-role="citation-selected"]')!;
    const styleSelect = dialog.element.querySelector<HTMLSelectElement>('[data-role="citation-style"]')!;
    const locator = dialog.element.querySelector<HTMLInputElement>('[data-role="citation-locator"]')!;
    const prefix = dialog.element.querySelector<HTMLInputElement>('[data-role="citation-prefix"]')!;
    const suffix = dialog.element.querySelector<HTMLInputElement>('[data-role="citation-suffix"]')!;
    const suppress = dialog.element.querySelector<HTMLInputElement>('[data-role="citation-suppress"]')!;

    const renderSelected = () => {
        const items = store.state.zotero.items.filter(item => selected.has(item.key));
        selectedBox.innerHTML = items.length
            ? `<div class="pz-citation-selected-title">已选 ${items.length} 篇</div>` + items.map(item => `<span class="pz-citation-chip">${escapeHtml(item.title)}</span>`).join("")
            : `<div class="pz-muted">尚未选择文献</div>`;
    };

    const renderResults = () => {
        const query = search.value.trim().toLowerCase();
        const matches = store.state.zotero.items
            .filter(item => {
                if (!query) {
                    return true;
                }
                return [item.title, item.creators.join(" "), item.year, item.doi || ""]
                    .join(" ")
                    .toLowerCase()
                    .includes(query);
            });
        const items = matches.slice(0, 200);
        results.innerHTML = items.length
            ? `<div class="pz-muted" style="padding:3px 7px">匹配 ${matches.length} 条${matches.length > items.length ? `，当前显示前 ${items.length} 条，请继续输入关键词缩小范围` : ""}</div>` + items.map(item => `<label class="pz-citation-result">
  <input type="checkbox" data-citation-key="${escapeHtml(item.key)}" ${selected.has(item.key) ? "checked" : ""}/>
  <span class="pz-citation-result-main"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.creators.join("; ") || "未知作者")}${item.year ? ` · ${escapeHtml(item.year)}` : ""}${item.itemType ? ` · ${escapeHtml(item.itemType)}` : ""}</small></span>
</label>`).join("")
            : `<div class="pz-muted">缓存中没有匹配文献。请先在 Dock 刷新 Zotero。</div>`;
    };

    results.addEventListener("change", (event) => {
        const input = (event.target as HTMLElement).closest<HTMLInputElement>("input[data-citation-key]");
        if (!input) {
            return;
        }
        if (input.checked) {
            selected.add(input.dataset.citationKey!);
        } else {
            selected.delete(input.dataset.citationKey!);
        }
        renderSelected();
    });
    search.addEventListener("input", renderResults);
    renderResults();
    renderSelected();

    dialog.element.querySelector('[data-act="citation-cancel"]')?.addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector('[data-act="citation-delete"]')?.addEventListener("click", async () => {
        if (!citation) {
            return;
        }
        await deleteCitation(store, citation.id);
        dialog.destroy();
        showMessage("引文已删除");
    });
    dialog.element.querySelector('[data-act="citation-save"]')?.addEventListener("click", async () => {
        if (!selected.size) {
            showMessage("请至少选择一篇文献", 3000, "error");
            return;
        }
        const style = styleSelect.value as CitationStyle;
        const citationOptions = {
            locator: locator.value.trim(),
            prefix: prefix.value.trim(),
            suffix: suffix.value.trim(),
            suppressAuthor: suppress.checked,
        };
        try {
            if (citation) {
                await updateCitation(store, citation.id, {style, options: citationOptions});
            } else {
                await insertCitation(store, Array.from(selected), style, citationOptions);
            }
            store.updateSettings({defaultCitationStyle: style});
            await store.save();
            dialog.destroy();
            showMessage(citation ? "引文已更新" : "已插入结构化引文");
        } catch (error: any) {
            showMessage(`引文操作失败：${error?.message || String(error)}`, 6000, "error");
        }
    });
    return dialog;
}
