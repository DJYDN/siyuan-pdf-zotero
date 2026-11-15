import {Dialog, showMessage} from "siyuan";
import {insertMarkdownAtCursor} from "../siyuan";
import type {PluginHost} from "../host";
import type {OcrHistoryEntry} from "../types";
import {clearOcrHistory, ocrHistoryEntries, removeOcrHistory, toggleOcrFavorite} from "../ocr/history";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch] as string));
}

export function openOcrHistory(host: PluginHost): Dialog {
    const dialog = new Dialog({
        title: "OCR 历史",
        width: "760px",
        content: `<div class="b3-dialog__content pz-ocr-history"><div data-role="ocr-history-list"></div></div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="ocr-history-clear">清空未收藏</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="ocr-history-close">关闭</button></div>`,
    });
    const list = dialog.element.querySelector<HTMLElement>('[data-role="ocr-history-list"]')!;
    const render = () => {
        const entries = ocrHistoryEntries(host.store);
        list.innerHTML = entries.length ? entries.map(item => `<div class="pz-ocr-history-item" data-ocr-history-id="${escapeHtml(item.id)}">
  <div class="pz-ocr-history-main">
    <div class="pz-ocr-history-title">${item.favorite ? "★ " : ""}${item.kind === "formula" ? "公式" : item.kind === "text" ? "文本" : "混合"} · ${new Date(item.createdAt).toLocaleString()}</div>
    <div class="pz-ocr-history-preview">${escapeHtml((item.markdown || item.latex || item.text || "").slice(0, 280))}</div>
  </div>
  <div class="pz-ocr-history-actions">
    <button data-act="ocr-history-favorite">${item.favorite ? "取消收藏" : "收藏"}</button>
    <button data-act="ocr-history-copy">复制</button>
    <button data-act="ocr-history-insert">插入</button>
    <button data-act="ocr-history-delete" class="is-danger">删除</button>
  </div>
</div>`).join("") : `<div class="pz-muted">还没有 OCR 历史。</div>`;
        for (const row of Array.from(list.querySelectorAll<HTMLElement>("[data-ocr-history-id]"))) {
            const id = row.dataset.ocrHistoryId || "";
            const entry = entries.find(item => item.id === id);
            if (!entry) continue;
            row.querySelector('[data-act="ocr-history-favorite"]')?.addEventListener("click", async () => {
                await toggleOcrFavorite(host.store, id);
                render();
            });
            row.querySelector('[data-act="ocr-history-copy"]')?.addEventListener("click", async () => {
                try {
                    await navigator.clipboard.writeText(entry.markdown || entry.latex || entry.text || "");
                    showMessage("OCR 历史内容已复制", 1800);
                } catch {
                    showMessage("复制失败", 3000, "error");
                }
            });
            row.querySelector('[data-act="ocr-history-insert"]')?.addEventListener("click", async () => {
                const blockId = await insertMarkdownAtCursor(entry.markdown || entry.latex || entry.text || "", host.captureNoteInsertionTarget());
                if (!blockId) showMessage("插入笔记失败", 3000, "error");
                else showMessage("已插入 OCR 历史", 1800);
            });
            row.querySelector('[data-act="ocr-history-delete"]')?.addEventListener("click", async () => {
                await removeOcrHistory(host.store, id);
                render();
            });
        }
    };
    dialog.element.querySelector('[data-act="ocr-history-close"]')?.addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector('[data-act="ocr-history-clear"]')?.addEventListener("click", async () => {
        if (!window.confirm("清空全部未收藏的 OCR 历史？")) return;
        await clearOcrHistory(host.store, true);
        render();
    });
    render();
    return dialog;
}
