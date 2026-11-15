import {Dialog, showMessage} from "siyuan";
import {appendMarkdown} from "../api";
import {insertMarkdownAtCursor, replaceSelectionWithMarkdown} from "../siyuan";
import type {NoteInsertionTarget, PluginHost} from "../host";
import type {OcrHistoryEntry} from "../types";
import {ocrItemsToMarkdown, type OcrResult} from "../ocr/client";
import {addOcrHistory} from "../ocr/history";

export interface OcrDialogOptions {
    imageBlob?: Blob;
    source: "pdf-region" | "clipboard";
    attachmentId?: string;
    page?: number;
    insertionTarget?: NoteInsertionTarget;
}

export function openOcrResultDialog(host: PluginHost, result: OcrResult, options: OcrDialogOptions): Dialog {
    const settings = host.store.state.settings;
    const dialog = new Dialog({
        title: "OCR 识别结果",
        width: "780px",
        content: `<div class="b3-dialog__content pz-ocr-preview">
  <div class="pz-ocr-preview-head"><span data-role="ocr-kind"></span><span data-role="ocr-score"></span></div>
  <div style="display:flex;gap:12px;align-items:flex-start">
    <div style="flex:0 0 260px"><img data-role="ocr-image" alt="OCR source" style="max-width:100%;border:1px solid var(--b3-border-color);border-radius:6px" /></div>
    <div style="flex:1;min-width:0">
      <div class="fn__flex" style="gap:8px;margin-bottom:6px"><label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>公式格式</span><select class="b3-select fn__block" data-role="ocr-format"><option value="inline">行内 $...$</option><option value="display">独立 $$...$$</option></select></label></div>
      <textarea class="b3-text-field fn__block" data-role="ocr-text" rows="12" style="resize:vertical"></textarea>
      <div class="pz-muted" style="font-size:11px;margin-top:4px">可以直接编辑识别结果；执行动作时会保存到 OCR 历史。</div>
    </div>
  </div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-act="ocr-cancel">关闭</button><div class="fn__space"></div>
  <button class="b3-button b3-button--outline" data-act="ocr-favorite">收藏</button><div class="fn__space"></div>
  <button class="b3-button b3-button--outline" data-act="ocr-copy">复制</button><div class="fn__space"></div>
  <button class="b3-button b3-button--outline" data-act="ocr-append">追加笔记</button><div class="fn__space"></div>
  <button class="b3-button b3-button--outline" data-act="ocr-replace">替换选区</button><div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-act="ocr-insert">插入光标</button>
</div>`,
    });
    const image = dialog.element.querySelector<HTMLImageElement>('[data-role="ocr-image"]')!;
    const textarea = dialog.element.querySelector<HTMLTextAreaElement>('[data-role="ocr-text"]')!;
    const format = dialog.element.querySelector<HTMLSelectElement>('[data-role="ocr-format"]')!;
    const kind = dialog.element.querySelector<HTMLElement>('[data-role="ocr-kind"]')!;
    const score = dialog.element.querySelector<HTMLElement>('[data-role="ocr-score"]')!;
    const imageUrl = options.imageBlob ? URL.createObjectURL(options.imageBlob) : "";
    if (imageUrl) image.src = imageUrl;
    else image.style.display = "none";
    format.value = settings.ocrFormulaFormat;
    textarea.value = ocrItemsToMarkdown(result, format.value === "display" ? "display" : "inline");
    kind.textContent = result.kind === "formula" ? "公式" : result.kind === "text" ? "文本" : "混合内容";
    const maxScore = result.items.reduce((max, item) => Math.max(max, item.confidence || 0), 0);
    score.textContent = maxScore ? `置信度 ${(maxScore * 100).toFixed(1)}%` : "";
    format.addEventListener("change", () => {
        textarea.value = ocrItemsToMarkdown(result, format.value === "display" ? "display" : "inline");
    });
    let history: OcrHistoryEntry | null = null;
    const close = () => {
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        dialog.destroy();
    };
    const record = async (favorite = false): Promise<OcrHistoryEntry> => {
        if (history) {
            history.markdown = textarea.value;
            if (favorite) history.favorite = true;
            await host.store.save();
            return history;
        }
        history = await addOcrHistory(host.store, {
            kind: result.kind,
            latex: result.items.filter(item => item.type === "formula").map(item => item.latex || item.text).join("\n"),
            text: result.items.filter(item => item.type === "text").map(item => item.text).join("\n"),
            markdown: textarea.value,
            source: options.source,
            attachmentId: options.attachmentId,
            page: options.page,
        });
        if (favorite) {
            history.favorite = true;
            await host.store.save();
        }
        return history;
    };
    const target = options.insertionTarget || host.captureNoteInsertionTarget();
    dialog.element.querySelector('[data-act="ocr-cancel"]')?.addEventListener("click", close);
    dialog.element.querySelector('[data-act="ocr-favorite"]')?.addEventListener("click", async () => {
        try {
            await record(true);
            showMessage("已收藏 OCR 结果", 2000);
        } catch (error: any) {
            showMessage(`收藏失败：${error?.message || String(error)}`, 4000, "error");
        }
    });
    dialog.element.querySelector('[data-act="ocr-copy"]')?.addEventListener("click", async () => {
        try {
            await record();
            await navigator.clipboard.writeText(textarea.value);
            showMessage("OCR 结果已复制", 2000);
        } catch (error: any) {
            showMessage(`复制 OCR 结果失败：${error?.message || String(error)}`, 4000, "error");
        }
    });
    dialog.element.querySelector('[data-act="ocr-append"]')?.addEventListener("click", async () => {
        try {
            await record();
            const docId = target.docId || host.getLastNoteDocId();
            if (!docId) {
                showMessage("请先打开一个思源笔记", 3000, "error");
                return;
            }
            await appendMarkdown(docId, textarea.value);
            showMessage("OCR 结果已追加到笔记末尾", 2500);
            close();
        } catch (error: any) {
            showMessage(`追加失败：${error?.message || String(error)}`, 4000, "error");
        }
    });
    dialog.element.querySelector('[data-act="ocr-replace"]')?.addEventListener("click", async () => {
        try {
            await record();
            const replaced = await replaceSelectionWithMarkdown(textarea.value, target);
            if (!replaced) {
                showMessage("替换失败，请重新选择笔记中的文本后重试", 4000, "error");
                return;
            }
            showMessage("OCR 结果已替换当前选区", 2000);
            close();
        } catch (error: any) {
            showMessage(`替换失败：${error?.message || String(error)}`, 4000, "error");
        }
    });
    dialog.element.querySelector('[data-act="ocr-insert"]')?.addEventListener("click", async () => {
        try {
            await record();
            const blockId = await insertMarkdownAtCursor(textarea.value, target);
            if (!blockId) {
                showMessage("OCR 结果已保存，但插入笔记失败", 4000, "error");
                return;
            }
            showMessage("OCR 结果已插入笔记", 2000);
            close();
        } catch (error: any) {
            showMessage(`插入失败：${error?.message || String(error)}`, 4000, "error");
        }
    });
    return dialog;
}
