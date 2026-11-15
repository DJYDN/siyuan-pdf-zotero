import {showMessage} from "siyuan";
import type {PluginHost} from "../host";
import type {Settings} from "../types";
import {doc2xActionOutputDir, doc2xErrorLogDir, parseWithDoc2x, translateWithDoc2x, translateWithDoc2xMarkdown} from "../translation/doc2x";
import {insertMarkdownAtCursor, uploadPngAsset} from "../siyuan";
import {requireNode} from "../runtime";
import {Pdf2zhHud} from "./pdf2zh-hud";
import {effectiveTargetLang} from "../translation/target-lang";

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

async function insertDoc2xMarkdown(markdownPath: string, host: PluginHost): Promise<void> {
    const fs = requireNode("fs");
    const path = requireNode("path");
    let markdown = fs.readFileSync(markdownPath, "utf8");
    const baseDir = path.dirname(markdownPath);
    const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    const replacements: Array<{raw: string; asset: string}> = [];
    for (const match of Array.from(markdown.matchAll(imagePattern) as any) as RegExpMatchArray[]) {
        const raw = match[2];
        if (/^[a-z]+:/i.test(raw) || raw.startsWith("/assets/")) continue;
        const file = path.isAbsolute(raw) ? raw : path.join(baseDir, decodeURIComponent(raw));
        if (!fs.existsSync(file)) continue;
        try {
            const blob = new Blob([fs.readFileSync(file)], {type: "image/jpeg"});
            const asset = await uploadPngAsset(blob, path.basename(file));
            replacements.push({raw, asset});
        } catch {
            // Keep the original image link if upload fails.
        }
    }
    for (const replacement of replacements) {
        markdown = markdown.split(`](${replacement.raw})`).join(`](${replacement.asset})`);
    }
    const blockId = await insertMarkdownAtCursor(markdown, host.captureNoteInsertionTarget());
    if (!blockId) {
        throw new Error("Markdown 已生成，但插入笔记失败；请先打开一个思源笔记");
    }
    showMessage("Doc2X Markdown 已插入当前笔记", 2500);
}

export async function runDoc2xMarkdownAction(
    host: PluginHost,
    target: Doc2xTarget,
    kind: "parse-md" | "translate-md",
): Promise<void> {
    const settings = requireConfigured(host);
    if (!settings) return;
    const hud = new Pdf2zhHud("Doc2X");
    hud.setIndeterminate(kind === "parse-md" ? "正在解析 PDF 为 Markdown…" : "正在翻译 PDF 为 Markdown…");
    try {
        const outputDir = doc2xActionOutputDir(settings, target.id, target.fingerprint, kind);
        const result = kind === "parse-md"
            ? await parseWithDoc2x(settings, target.path, outputDir)
            : await translateWithDoc2xMarkdown(settings, target.path, outputDir, "translate");
        const markdown = result.markdownFiles[0];
        if (!markdown) throw new Error("Doc2X 没有返回 Markdown 文件");
        hud.setStatus("正在插入笔记…");
        await insertDoc2xMarkdown(markdown, host);
        hud.complete("Doc2X Markdown 已插入笔记");
    } catch (error: any) {
        hud.fail(String(error?.message || error || "Doc2X Markdown 操作失败"));
    }
}

export async function runDoc2xPdfAction(
    host: PluginHost,
    target: Doc2xTarget,
    mode: "translatedPdf" | "dualPdf",
): Promise<void> {
    const settings = requireConfigured(host);
    if (!settings) return;
    const hud = new Pdf2zhHud("Doc2X");
    hud.setIndeterminate(mode === "dualPdf" ? "正在生成双语排版 PDF…" : "正在生成译文 PDF…");
    try {
        const nextSettings = {...settings, doc2xOutputMode: mode};
        const outputDir = doc2xActionOutputDir(nextSettings, target.id, target.fingerprint, mode);
        const result = await translateWithDoc2x(nextSettings, target.path, outputDir);
        const generated = result.files[0];
        if (!generated) throw new Error("Doc2X 没有返回 PDF");
        const output = host.store.addTranslationOutput({
            path: generated,
            fileName: generated.split(/[\\/]/).pop() || generated,
            provider: "doc2x",
            mode,
            targetLang: effectiveTargetLang(nextSettings, "doc2x"),
            sourceAttachmentId: target.sourceAttachmentId,
            sourceTitle: target.sourceTitle,
            createdAt: Date.now(),
        });
        void output;
        await host.store.save();
        hud.complete("Doc2X PDF 生成完成");
        const imported = await host.importLocalPath(generated);
        if (imported) host.openAttachment(imported);
    } catch (error: any) {
        hud.fail(String(error?.message || error || "Doc2X PDF 生成失败"));
    }
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
