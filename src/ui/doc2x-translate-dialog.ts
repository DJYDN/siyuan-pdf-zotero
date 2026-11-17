import {Dialog, showMessage} from "siyuan";
import type {PluginHost} from "../host";
import type {Settings} from "../types";
import {requireNode} from "../runtime";
import {translateWithDoc2x, translateWithDoc2xMarkdown, fetchDoc2xModelList} from "../translation/doc2x";
import {translateParsedMarkdown} from "../translation/md-translate";
import {DEFAULT_CLEAN_OPTIONS, cleanDoc2xMarkdown, firstHeading} from "../doc2x/clean";
import {materializeMarkdownImages} from "../doc2x/assets";
import {
    addParseRecord,
    countImages,
    createRecordWorkspace,
    dirSizeBytes,
    enforceParseLimits,
    readParseMarkdown,
    type ParseRecord,
} from "../doc2x/library";
import {openParsePreview} from "./doc2x-preview";

function escapeHtml(text: string): string {
    return String(text ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch] as string));
}

const TARGET_LANGS = [
    ["zh", "简体中文"], ["en", "英语"], ["ja", "日语"], ["ko", "韩语"], ["fr", "法语"],
    ["de", "德语"], ["es", "西班牙语"], ["ru", "俄语"], ["pt", "葡萄牙语"], ["pt-BR", "巴西葡萄牙语"], ["ar", "阿拉伯语"],
];

function langOptions(selected: string): string {
    return TARGET_LANGS.map(([code, label]) => `<option value="${code}" ${selected === code ? "selected" : ""}>${label} (${code})</option>`).join("");
}

export function openParseTranslateDialog(host: PluginHost, record: ParseRecord): Dialog {
    const settings = host.store.state.settings;
    const dialog = new Dialog({
        title: `翻译 · ${record.sourceTitle || record.fingerprint}`,
        width: "640px",
        content: `<div class="b3-dialog__content">
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px"><span>翻译方式</span>
    <select class="b3-select fn__block" data-role="trans-method">
      <option value="fast">快速翻译已有 Markdown（不消耗 Doc2X 额度）</option>
      <option value="doc2x">Doc2X 保版翻译（重新解析原 PDF，消耗解析页数）</option>
    </select>
    <span class="pz-help">快速翻译使用插件现有翻译服务，公式与表格会保持原文；Doc2X 保版翻译可输出双语/保留排版。</span>
  </label>

  <div data-role="fast-options">
    <div class="fn__flex" style="gap:8px;margin-bottom:8px">
      <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>目标语言</span><select class="b3-select fn__block" data-role="fast-lang">${langOptions(settings.translationDefaultTargetLang || "zh-CN")}</select></label>
      <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>输出</span><select class="b3-select fn__block" data-role="fast-output"><option value="translate">仅译文</option><option value="both">双语对照</option></select></label>
    </div>
  </div>

  <div data-role="doc2x-options" hidden>
    <div class="fn__flex" style="gap:8px;margin-bottom:8px">
      <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>目标语言</span><select class="b3-select fn__block" data-role="doc2x-lang">${langOptions(settings.doc2xTargetLang || "zh")}</select></label>
      <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>输出</span><select class="b3-select fn__block" data-role="doc2x-output">
        <option value="md">文档型（Markdown · 仅译文）</option>
        <option value="md-both">文档型（Markdown · 双语对照）</option>
        <option value="translatedPdf">纯译文（重排 PDF）</option>
        <option value="dualPdf">双语对照 + 固定排版 PDF</option>
      </select></label>
    </div>
    <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>翻译模型（官方列表）</span><select class="b3-select fn__block" data-role="doc2x-model"><option value="">官方默认（Free）</option></select></label>
    <div class="pz-help" style="color:#b45309">注意：Doc2X CLI 不能复用解析结果，此方式会重新解析原 PDF 并再次消耗解析页数。</div>
  </div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="trans-cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--primary" data-act="trans-start">开始翻译</button></div>`,
    });
    const root = dialog.element;
    const method = root.querySelector<HTMLSelectElement>('[data-role="trans-method"]')!;
    const fastOptions = root.querySelector<HTMLElement>('[data-role="fast-options"]')!;
    const doc2xOptions = root.querySelector<HTMLElement>('[data-role="doc2x-options"]')!;
    const syncMethod = (): void => {
        const doc2x = method.value === "doc2x";
        doc2xOptions.hidden = !doc2x;
        fastOptions.hidden = doc2x;
    };
    method.addEventListener("change", syncMethod);
    syncMethod();

    if (settings.doc2xConfigured !== false) {
        void fetchDoc2xModelList(settings).then(list => {
            const select = root.querySelector<HTMLSelectElement>('[data-role="doc2x-model"]');
            if (!select) return;
            select.innerHTML = [`<option value="">官方默认（Free）</option>`]
                .concat(list.models.map((item: any) => {
                    const id = String(item?.modelId ?? item?.id ?? "");
                    const name = String(item?.displayName || item?.name || id);
                    return `<option value="${escapeHtml(id)}" ${settings.doc2xModel === id ? "selected" : ""}>${escapeHtml(name)} (${escapeHtml(id)})${item?.subscriptionRequired ? " · 需订阅" : ""}</option>`;
                })).join("");
        }).catch((): void => undefined);
    }

    root.querySelector('[data-act="trans-cancel"]')?.addEventListener("click", () => dialog.destroy());
    root.querySelector('[data-act="trans-start"]')?.addEventListener("click", async () => {
        const button = root.querySelector<HTMLButtonElement>('[data-act="trans-start"]');
        if (button) button.disabled = true;
        try {
            const markdown = readParseMarkdown(record);
            if (!markdown) throw new Error("解析结果文件不存在，请重新解析");
            if (method.value === "fast") {
                const targetLang = root.querySelector<HTMLSelectElement>('[data-role="fast-lang"]')?.value || "zh-CN";
                const output = (root.querySelector<HTMLSelectElement>('[data-role="fast-output"]')?.value || "translate") as "translate" | "both";
                const result = await translateParsedMarkdown(settings, markdown, {targetLang, output});
                const saved = saveTranslatedRecord(host, settings, record, result.markdown, `快速翻译 · ${targetLang}${output === "both" ? " · 双语" : ""}`);
                dialog.destroy();
                if (result.warnings.length) showMessage(result.warnings.join("；").slice(0, 300), 5000);
                host.refreshDock();
                openParsePreview(host, saved);
                return;
            }
            const targetLang = root.querySelector<HTMLSelectElement>('[data-role="doc2x-lang"]')?.value || "zh";
            const outputMode = root.querySelector<HTMLSelectElement>('[data-role="doc2x-output"]')?.value || "md";
            const model = root.querySelector<HTMLSelectElement>('[data-role="doc2x-model"]')?.value || "";
            const next: Settings = {...settings, doc2xTargetLang: targetLang, doc2xModel: model || settings.doc2xModel};
            if (outputMode === "translatedPdf" || outputMode === "dualPdf") {
                next.doc2xOutputMode = outputMode === "dualPdf" ? "dualPdf" : "translatedPdf";
                next.doc2xTranslateType = "pdf";
                const workspace = createRecordWorkspace(record.fingerprint, record.version, "translate");
                const result = await translateWithDoc2x(next, record.sourcePdfPath, workspace.dir);
                const generated = result.files[0];
                if (!generated) throw new Error("Doc2X 没有返回 PDF");
                host.store.addTranslationOutput({
                    path: generated,
                    fileName: generated.split(/[\\/]/).pop() || generated,
                    provider: "doc2x",
                    mode: next.doc2xOutputMode,
                    targetLang,
                    sourceAttachmentId: record.sourceAttachmentId,
                    sourceTitle: record.sourceTitle,
                    createdAt: Date.now(),
                });
                await host.store.save();
                showMessage("保版翻译完成，已加入「翻译」列表", 2600);
                dialog.destroy();
                host.refreshDock();
                return;
            }
            const workspace = createRecordWorkspace(record.fingerprint, record.version, "translate");
            const convert = outputMode === "md-both" ? "both" : "translate";
            const result = await translateWithDoc2xMarkdown(next, record.sourcePdfPath, workspace.dir, convert);
            const fs = requireNode("fs");
            const text = fs && result.markdownFiles[0] ? String(fs.readFileSync(result.markdownFiles[0], "utf8")) : "";
            const cleaned = cleanDoc2xMarkdown(text, DEFAULT_CLEAN_OPTIONS);
            const materialized = await materializeMarkdownImages(cleaned.markdown, workspace.dir);
            const saved = saveTranslatedRecord(host, settings, record, materialized.markdown, `Doc2X 文档型翻译 · ${targetLang}`);
            dialog.destroy();
            host.refreshDock();
            openParsePreview(host, saved);
        } catch (error: any) {
            showMessage(`翻译失败：${String(error?.message || error).slice(0, 300)}`, 6000, "error");
            if (button) button.disabled = false;
        }
    });
    return dialog;
}

function saveTranslatedRecord(host: PluginHost, settings: Settings, source: ParseRecord, markdown: string, label: string): ParseRecord {
    const fs = requireNode("fs");
    const path = requireNode("path");
    const workspace = createRecordWorkspace(source.fingerprint, source.version, "translate");
    const mdPath = path.join(workspace.dir, "document.md");
    fs.writeFileSync(mdPath, markdown, "utf8");
    const record: ParseRecord = {
        id: workspace.id,
        kind: "translate",
        fingerprint: source.fingerprint,
        sourcePdfPath: source.sourcePdfPath,
        sourceTitle: `${source.sourceTitle || source.fingerprint} · ${label}`,
        sourceAttachmentId: source.sourceAttachmentId,
        model: settings.doc2xModel || "",
        targetLang: settings.doc2xTargetLang || settings.translationDefaultTargetLang,
        translateMode: label,
        createdAt: Date.now(),
        version: source.version,
        mdPath,
        imagesDir: workspace.dir,
        imagesCount: countImages(workspace.dir),
        sizeBytes: dirSizeBytes(workspace.dir),
    };
    addParseRecord(record);
    enforceParseLimits(settings.doc2xParseHistoryLimit || 50, (settings.doc2xParseHistoryMaxMB || 2048) * 1024 * 1024);
    host.logDebug("doc2x.translate.saved", {id: record.id, label});
    return record;
}
