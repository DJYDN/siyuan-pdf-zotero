import {Dialog, showMessage} from "siyuan";
import type {PluginHost} from "../host";
import type {Settings} from "../types";
import {doc2xErrorLogDir, parseWithDoc2x, translateWithDoc2x} from "../translation/doc2x";
import {requireNode} from "../runtime";
import {Pdf2zhHud} from "./pdf2zh-hud";
import {effectiveTargetLang} from "../translation/target-lang";
import {DEFAULT_CLEAN_OPTIONS, cleanDoc2xMarkdown, firstHeading} from "../doc2x/clean";
import {
    addParseRecord,
    countImages,
    createRecordWorkspace,
    dirSizeBytes,
    enforceParseLimits,
    findParseRecord,
    loadParseLibrary,
    nextParseVersion,
    removeParseRecord,
    type ParseRecord,
} from "../doc2x/library";
import {openParsePreview} from "./doc2x-preview";
import {materializeMarkdownImages} from "../doc2x/assets";
import {openParseTranslateDialog} from "./doc2x-translate-dialog";

export interface Doc2xTarget {
    id: string;
    path: string;
    fingerprint: string;
    sourceAttachmentId?: string;
    sourceTitle?: string;
}

function requireConfigured(host: PluginHost): Settings | null {
    const settings = host.store.state.settings;
    if (!settings.doc2xConfigured) {
        showMessage("请先在设置 → Doc2X 勾选“我已配置完成解析&翻译设置”", 4000, "error");
        return null;
    }
    return settings;
}

function askParseConflict(existing: ParseRecord): Promise<"overwrite" | "version" | "cancel"> {
    return new Promise(resolve => {
        const dialog = new Dialog({
            title: "该 PDF 已有解析结果",
            width: "520px",
            content: `<div class="b3-dialog__content">
  <div class="pz-muted" style="margin-bottom:10px">${existing.sourceTitle ? `${existing.sourceTitle} · ` : ""}已有 ${new Date(existing.createdAt).toLocaleString()} 的解析结果。</div>
  <div class="pz-help">覆盖会删除旧解析结果及其图片；保留新版本会新建一条记录。</div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-act="cancel">取消</button><div class="fn__space"></div>
  <button class="b3-button b3-button--outline" data-act="version">保留为新版本</button>
  <button class="b3-button b3-button--primary" data-act="overwrite">覆盖旧结果</button>
</div>`,
        });
        const finish = (value: "overwrite" | "version" | "cancel") => {
            dialog.destroy();
            resolve(value);
        };
        dialog.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => finish("cancel"));
        dialog.element.querySelector('[data-act="version"]')?.addEventListener("click", () => finish("version"));
        dialog.element.querySelector('[data-act="overwrite"]')?.addEventListener("click", () => finish("overwrite"));
    });
}

/** Parse a PDF into the parse library, then open the preview dialog. */
export async function runDoc2xParseAction(host: PluginHost, target: Doc2xTarget, openPreview = true): Promise<ParseRecord | null> {
    const settings = requireConfigured(host);
    if (!settings) return null;
    const existing = findParseRecord(target.fingerprint, "parse");
    let version = 1;
    if (existing) {
        const choice = await askParseConflict(existing);
        if (choice === "cancel") return null;
        if (choice === "overwrite") {
            removeParseRecord(existing.id, true);
        } else {
            version = nextParseVersion(target.fingerprint);
        }
    }
    const hud = new Pdf2zhHud("Doc2X");
    hud.setIndeterminate("正在解析 PDF 为 Markdown…");
    try {
        const workspace = createRecordWorkspace(target.fingerprint, version, "parse");
        const result = await parseWithDoc2x(settings, target.path, workspace.dir);
        const fs = requireNode("fs");
        const path = requireNode("path");
        const sourceMd = result.markdownFiles[0];
        if (!sourceMd) throw new Error("Doc2X 没有返回 Markdown 文件");
        const raw = String(fs.readFileSync(sourceMd, "utf8"));
        const rawPath = path.join(workspace.dir, "document.raw.md");
        fs.writeFileSync(rawPath, raw, "utf8");
        const cleaned = cleanDoc2xMarkdown(raw, DEFAULT_CLEAN_OPTIONS);
        const materialized = await materializeMarkdownImages(cleaned.markdown, workspace.dir);
        const mdPath = path.join(workspace.dir, "document.md");
        fs.writeFileSync(mdPath, materialized.markdown, "utf8");
        const record: ParseRecord = {
            id: workspace.id,
            kind: "parse",
            fingerprint: target.fingerprint,
            sourcePdfPath: target.path,
            sourceTitle: target.sourceTitle || firstHeading(raw, path.basename(target.path)),
            sourceAttachmentId: target.sourceAttachmentId,
            model: settings.doc2xVisionModel || settings.doc2xParseImageModel || "doc2x",
            createdAt: Date.now(),
            version,
            mdPath,
            rawPath,
            imagesDir: workspace.dir,
            imagesCount: countImages(workspace.dir),
            sizeBytes: dirSizeBytes(workspace.dir),
        };
        addParseRecord(record);
        enforceParseLimits(settings.doc2xParseHistoryLimit || 50, (settings.doc2xParseHistoryMaxMB || 2048) * 1024 * 1024);
        hud.complete("解析完成");
        host.refreshDock();
        if (openPreview) openParsePreview(host, record);
        return record;
    } catch (error: any) {
        hud.fail(String(error?.message || error || "Doc2X 解析失败"));
        return null;
    }
}

async function ensureParseRecord(host: PluginHost, target: Doc2xTarget): Promise<ParseRecord | null> {
    const existing = findParseRecord(target.fingerprint, "parse");
    if (existing) return existing;
    const parsed = await runDoc2xParseAction(host, target, false);
    return parsed;
}

export async function runDoc2xMarkdownAction(
    host: PluginHost,
    target: Doc2xTarget,
    kind: "parse-md" | "translate-md",
): Promise<void> {
    if (kind === "parse-md") {
        await runDoc2xParseAction(host, target);
        return;
    }
    const record = await ensureParseRecord(host, target);
    if (record) openParseTranslateDialog(host, record);
}

export async function runDoc2xPdfAction(
    host: PluginHost,
    target: Doc2xTarget,
    mode: "translatedPdf" | "dualPdf",
): Promise<void> {
    const settings = requireConfigured(host);
    if (!settings) return;
    if (mode === "dualPdf" && settings.doc2xTranslateType === "md") {
        const record = await ensureParseRecord(host, target);
        if (record) openParseTranslateDialog(host, record);
        return;
    }
    const hud = new Pdf2zhHud("Doc2X");
    hud.setIndeterminate(mode === "dualPdf" ? "正在生成双语排版 PDF…" : "正在生成译文 PDF…");
    try {
        const nextSettings = {...settings, doc2xOutputMode: mode};
        const outputDir = `${doc2xErrorLogDir(nextSettings)}/../doc2x-pdf`;
        const result = await translateWithDoc2x(nextSettings, target.path, outputDir);
        const generated = result.files[0];
        if (!generated) throw new Error("Doc2X 没有返回 PDF");
        host.store.addTranslationOutput({
            path: generated,
            fileName: generated.split(/[\\/]/).pop() || generated,
            provider: "doc2x",
            mode,
            targetLang: effectiveTargetLang(nextSettings, "doc2x"),
            sourceAttachmentId: target.sourceAttachmentId,
            sourceTitle: target.sourceTitle,
            createdAt: Date.now(),
        });
        await host.store.save();
        hud.complete("Doc2X PDF 生成完成");
        host.refreshDock();
        const imported = await host.importLocalPath(generated);
        if (imported) host.openAttachment(imported);
    } catch (error: any) {
        hud.fail(String(error?.message || error || "Doc2X PDF 生成失败"));
    }
}

export function openParseLibraryForTarget(host: PluginHost, target: Doc2xTarget): void {
    const records = loadParseLibrary().filter(item => item.fingerprint === target.fingerprint);
    if (!records.length) {
        void runDoc2xParseAction(host, target);
        return;
    }
    openParsePreview(host, records.sort((a, b) => b.createdAt - a.createdAt)[0]);
}

export function openDoc2xErrorLogDir(host: PluginHost): void {
    const settings = host.store.state.settings;
    const fs = requireNode("fs");
    const electron = requireNode("electron");
    try {
        const dir = doc2xErrorLogDir(settings);
        fs?.mkdirSync?.(dir, {recursive: true});
        if (electron?.shell?.openPath) void electron.shell.openPath(dir);
        else showMessage(dir, 6000);
    } catch (error: any) {
        showMessage(String(error?.message || error), 4000, "error");
    }
}
