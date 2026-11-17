import type {Settings, TranslationServiceConfig} from "../types";
import {translateText} from "./service";

export interface MarkdownTranslateOptions {
    targetLang: string;
    /** "translate" = translation only, "both" = original + translation per paragraph. */
    output: "translate" | "both";
    /** Keep tables in the source language (default true). */
    skipTables?: boolean;
}

export interface MarkdownTranslateResult {
    markdown: string;
    warnings: string[];
}

function activeService(settings: Settings): TranslationServiceConfig | undefined {
    const services = settings.translationServices || [];
    const active = services.find(item => item.id === settings.translationActiveServiceId);
    if (active?.enabled) return active;
    return services.find(item => item.enabled);
}

function protectMarkdown(markdown: string): {text: string; restore: Array<{token: string; value: string}>} {
    const restore: Array<{token: string; value: string}> = [];
    const stash = (value: string) => {
        const token = `PZMD${restore.length}TOKEN`;
        restore.push({token, value});
        return token;
    };
    let text = markdown;
    // fenced code blocks
    text = text.replace(/```[\s\S]*?```/g, block => stash(block));
    // display + inline math
    text = text.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, block => stash(block));
    // Markdown tables (consecutive lines starting with |)
    text = text.replace(/(?:^\|.*\|[ \t]*\n?)+/gm, block => stash(block));
    return {text, restore};
}

function restoreMarkdown(text: string, restore: Array<{token: string; value: string}>): string {
    let result = text;
    for (const item of restore) {
        result = result.split(item.token).join(item.value);
    }
    return result;
}

function splitChunks(markdown: string, maxChars = 3200): string[] {
    const blocks = markdown.split(/\n{2,}/);
    const chunks: string[] = [];
    let current = "";
    for (const block of blocks) {
        if (!block.trim()) continue;
        if (current && current.length + block.length + 2 > maxChars) {
            chunks.push(current);
            current = block;
        } else {
            current = current ? `${current}\n\n${block}` : block;
        }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [markdown];
}

export async function translateParsedMarkdown(
    settings: Settings,
    markdown: string,
    options: MarkdownTranslateOptions,
): Promise<MarkdownTranslateResult> {
    const service = activeService(settings);
    if (!service) {
        throw new Error("没有可用的翻译服务：请先在设置 → 翻译 → 服务 中启用一个翻译服务");
    }
    const warnings: string[] = [];
    if (options.skipTables !== false) {
        // tables are protected together with math/code; warn if any were skipped
        if (/(?:^\|.*\|[ \t]*$)/m.test(markdown)) warnings.push("表格已保持原文，不参与机器翻译。");
    }
    const protectedMarkdown = protectMarkdown(markdown);
    const chunks = splitChunks(protectedMarkdown.text);
    const translatedChunks: string[] = [];
    for (const chunk of chunks) {
        try {
            const result = await translateText(service, chunk, options.targetLang || "zh-CN");
            translatedChunks.push(String(result.text || "").trim());
        } catch (error: any) {
            warnings.push(`部分段落翻译失败，已保留原文：${String(error?.message || error).slice(0, 120)}`);
            translatedChunks.push(chunk);
        }
    }
    const translated = restoreMarkdown(translatedChunks.join("\n\n"), protectedMarkdown.restore);
    if (options.output === "both") {
        // Bilingual output: insert the translated chunk after each source chunk.
        const pairs: string[] = [];
        for (let index = 0; index < chunks.length; index += 1) {
            const source = restoreMarkdown(chunks[index], protectedMarkdown.restore);
            const target = restoreMarkdown(translatedChunks[index] || "", protectedMarkdown.restore);
            pairs.push(target ? `${source}\n\n${target}` : source);
        }
        return {markdown: pairs.join("\n\n"), warnings};
    }
    return {markdown: translated, warnings};
}
