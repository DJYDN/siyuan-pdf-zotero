import CSL from "citeproc";
import {pluginAssetUrl} from "../runtime";
import type {CitationOptions, CitationStyle} from "../types";

export interface StyleMeta {
    file: string;
    lang: string;
    label: string;
    numeric: boolean;
}

export const CITATION_STYLES: Record<CitationStyle, StyleMeta> = {
    gbt7714: {
        file: "gb-t-7714-2015-numeric.csl",
        lang: "zh-CN",
        label: "GB/T 7714-2015（顺序编码）",
        numeric: true,
    },
    apa: {
        file: "apa.csl",
        lang: "en-US",
        label: "APA 7th",
        numeric: false,
    },
    ieee: {
        file: "ieee.csl",
        lang: "en-US",
        label: "IEEE",
        numeric: true,
    },
};

const textCache = new Map<string, string>();

async function loadStyleText(file: string): Promise<string> {
    if (textCache.has(file)) {
        return textCache.get(file) as string;
    }
    const response = await fetch(pluginAssetUrl(`styles/${file}`));
    if (!response.ok) {
        throw new Error(`CSL 样式加载失败：${file} (HTTP ${response.status})`);
    }
    const text = await response.text();
    textCache.set(file, text);
    return text;
}

async function loadLocale(lang: string): Promise<string> {
    try {
        return await loadStyleText(`locales-${lang}.xml`);
    } catch {
        return loadStyleText("locales-en-US.xml");
    }
}

export interface CitationCluster {
    id: string;
    cslIds: string[];
    options: CitationOptions;
}

export function cslId(csl: Record<string, any>): string {
    return String(csl.id || "");
}

async function createEngine(
    items: Record<string, any>[],
    style: CitationStyle,
): Promise<{engine: any; styleMeta: StyleMeta}> {
    const meta = CITATION_STYLES[style];
    const [styleXml, localeXml] = await Promise.all([
        loadStyleText(meta.file),
        loadLocale(meta.lang),
    ]);
    const byId = new Map<string, any>();
    for (const item of items) {
        if (item?.id) {
            byId.set(String(item.id), item);
        }
    }
    const sys = {
        // citeproc expects the locale XML synchronously; this engine only handles one locale.
        retrieveLocale: (_lang: string) => localeXml,
        retrieveItem: (id: string) => byId.get(String(id)) || {id, type: "article", title: id},
    };
    const engine = new CSL.Engine(sys, styleXml, meta.lang);
    engine.updateItems(Array.from(byId.keys()));
    return {engine, styleMeta: meta};
}

/** Format one or more citation clusters in document order (numeric numbering follows this order). */
export async function formatCitationClusters(
    clusters: CitationCluster[],
    items: Record<string, any>[],
    style: CitationStyle,
): Promise<string[]> {
    const {engine} = await createEngine(items, style);
    const output: string[] = [];
    for (const cluster of clusters) {
        const citationItems = cluster.cslIds.map(id => ({
            id,
            ...(cluster.options.locator ? {locator: cluster.options.locator} : {}),
            ...(cluster.options.prefix ? {prefix: cluster.options.prefix} : {}),
            ...(cluster.options.suffix ? {suffix: cluster.options.suffix} : {}),
            ...(cluster.options.suppressAuthor ? {"suppress-author": true} : {}),
        }));
        output.push(String(engine.makeCitationCluster(citationItems)));
    }
    return output;
}

function decodeEntities(text: string): string {
    const named: Record<string, string> = {
        "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
    };
    return text
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
        .replace(/&(amp|lt|gt|quot|#39);/g, match => named[match] ?? match);
}

/** Turn citeproc bibliography HTML into one plain-text entry per reference. */
export function bibliographyToText(entries: string[]): string[] {
    return entries.map(entry => decodeEntities(
        String(entry)
            .replace(/<div class="csl-left-margin">([\s\S]*?)<\/div>/g, "$1 ")
            .replace(/<div class="csl-right-inline">([\s\S]*?)<\/div>/g, "$1")
            .replace(/<[^>]+>/g, "")
            .replace(/\s+/g, " ")
            .trim(),
    ));
}

export async function formatBibliography(
    items: Record<string, any>[],
    style: CitationStyle,
): Promise<string[]> {
    const {engine} = await createEngine(items, style);
    const bibliography = engine.makeBibliography();
    if (!bibliography || !Array.isArray(bibliography[1])) {
        return [];
    }
    return bibliographyToText(bibliography[1]);
}

export function citationStyleLabel(style: CitationStyle): string {
    return CITATION_STYLES[style]?.label || style;
}
