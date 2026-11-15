import type {NoteTemplate, MatrixRow} from "../types";
import type {PluginHost} from "../host";
import {ensureBuiltinTemplates, templateLinkForItem} from "./model";

export interface TemplateRenderResult {
    html: string;
    errors: string[];
}

interface TemplateContext {
    topItem: any;
    Zotero: any;
    matrix: Record<string, unknown>;
}

function creatorsText(item: any): string {
    return (item?.creators || []).join("; ");
}

function fieldValue(item: any, csl: any, name: string): string {
    const map: Record<string, string> = {
        title: item?.title || csl?.title || "",
        publicationTitle: csl?.["container-title"] || "",
        date: item?.year || csl?.issued?.["date-parts"]?.[0]?.[0] || "",
        DOI: item?.doi || csl?.DOI || "",
        url: csl?.URL || "",
        abstractNote: item?.abstract || csl?.abstract || "",
        volume: csl?.volume || "",
        issue: csl?.issue || "",
        pages: csl?.page || "",
        citationKey: csl?.["citation-key"] || "",
        author: creatorsText(item),
        firstCreator: String(item?.creators?.[0] || ""),
        shortTitle: String(item?.title || "").slice(0, 60),
    };
    return String(map[name] ?? "");
}

function findMatrixValue(host: PluginHost, itemKey: string, name: string): string {
    const project = host.store.state.matrixProjects?.find(item => item.id === host.store.state.matrixActiveProjectId)
        || host.store.state.matrixProjects?.[0];
    if (!project) return "";
    const column = project.columns.find(item => item.name === name);
    const row: MatrixRow | undefined = project.rows.find(item => item.itemKey === itemKey);
    if (!column || !row) return "";
    return String(row.values[column.id] ?? "");
}

function buildContext(host: PluginHost, itemKey: string): TemplateContext {
    const item = (host.store.state.zotero.items || []).find(entry => entry.key === itemKey);
    const csl = item?.csl || {};
    const attachments = Object.values(host.store.state.attachments || {})
        .filter(attachment => attachment.zotero?.itemKey === itemKey);
    const attachmentFacade = attachments.map(attachment => ({
        id: attachment.zotero?.attachmentKey || attachment.id,
        key: attachment.zotero?.attachmentKey || attachment.id,
        isAttachment: () => true,
        isPDFAttachment: () => String((attachment as any).mime || attachment.fileName || "").toLowerCase().includes("pdf") || String(attachment.fileName || "").toLowerCase().endsWith(".pdf"),
        getFilename: () => attachment.fileName,
        getField: (name: string) => name === "title" ? attachment.fileName : (name === "filename" ? attachment.fileName : (name === "DOI" ? "" : "")),
        getDisplayTitle: () => attachment.fileName,
        attachmentContentType: (attachment as any).mime || "application/pdf",
        path: attachment.path,
    }));
    const topItem: any = {
        id: item?.key || itemKey,
        key: item?.key || itemKey,
        itemType: item?.itemType || csl.type || "article-journal",
        getField: (name: string) => {
            const translated = name === "titleTranslation" || name === "abstractTranslation" ? findMatrixValue(host, itemKey, name) : "";
            return translated || fieldValue(item, csl, name);
        },
        getCreators: () => (item?.creators || []).map((creator: string) => {
            const parts = String(creator).trim().split(/\s+/);
            return {firstName: parts.slice(0, -1).join(" "), lastName: parts.slice(-1).join("")};
        }),
        getTags: () => ((item as any)?.tags || []).map((tag: any) => typeof tag === "string" ? {tag} : tag),
        getAttachments: () => attachmentFacade.map(attachment => attachment.key),
        getDisplayTitle: () => String(item?.title || csl?.title || ""),
        getNotes: (): any[] => [],
        isRegularItem: () => true,
    };
    const Zotero = {
        Items: {
            get: (ids: string | string[]) => {
                const find = (id: string) => id === topItem.id ? topItem : attachmentFacade.find(attachment => attachment.key === id);
                if (Array.isArray(ids)) return ids.map(find).filter(Boolean);
                return find(ids) || false;
            },
            getAll: () => (host.store.state.zotero.items || []).map(entry => ({id: entry.key, key: entry.key, getField: (name: string) => fieldValue(entry, entry.csl || {}, name), getDisplayTitle: () => entry.title})),
        },
        ZoteroStyle: {
            api: {
                renderCell: () => ({childNodes: [] as any[], textContent: "", outerHTML: ""}),
                getFormattedTags: () => "",
            },
        },
    };
    const matrix: Record<string, unknown> = {};
    const project = host.store.state.matrixProjects?.find(entry => entry.id === host.store.state.matrixActiveProjectId)
        || host.store.state.matrixProjects?.[0];
    const row = project?.rows.find(entry => entry.itemKey === itemKey);
    for (const column of project?.columns || []) {
        matrix[column.name] = row?.values[column.id] ?? "";
    }
    return {topItem, Zotero, matrix};
}

function evalExpression(expression: string, context: TemplateContext): string {
    const fn = new Function("topItem", "Zotero", "matrix", `return (${expression});`);
    const value = fn(context.topItem, context.Zotero, context.matrix);
    return value === undefined || value === null ? "" : String(value);
}

function evalBlock(code: string, context: TemplateContext): string {
    const fn = new Function("topItem", "Zotero", "matrix", code);
    const value = fn(context.topItem, context.Zotero, context.matrix);
    return value === undefined || value === null ? "" : String(value);
}

function findBalancedEnd(source: string, start: number, open: string, close: string): number {
    let depth = 1;
    let quote = "";
    let escaped = false;
    for (let index = start; index < source.length; index++) {
        const char = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === quote) quote = "";
            continue;
        }
        if (char === "'" || char === '"' || char === "`") {
            quote = char;
            continue;
        }
        if (char === open) depth++;
        else if (char === close) {
            depth--;
            if (depth === 0) return index;
        }
    }
    return -1;
}

export function renderNoteTemplate(host: PluginHost, template: NoteTemplate, itemKey: string): TemplateRenderResult {
    ensureBuiltinTemplates(host);
    const context = buildContext(host, itemKey);
    const errors: string[] = [];
    const source = template.content || "";
    let output = "";
    let cursor = 0;
    while (cursor < source.length) {
        const blockStart = source.indexOf("${{", cursor);
        const exprStart = source.indexOf("${", cursor);
        const starts = [blockStart, exprStart].filter(index => index >= 0);
        if (!starts.length) {
            output += source.slice(cursor);
            break;
        }
        const start = Math.min(...starts);
        output += source.slice(cursor, start);
        if (start === blockStart) {
            const end = source.indexOf("}}$", start + 3);
            if (end < 0) {
                errors.push("未闭合的模板代码块");
                output += source.slice(start);
                break;
            }
            try {
                output += evalBlock(source.slice(start + 3, end), context);
            } catch (error: any) {
                errors.push(String(error?.message || error));
            }
            cursor = end + 3;
        } else {
            const end = findBalancedEnd(source, start + 2, "{", "}");
            if (end < 0) {
                errors.push("未闭合的模板表达式");
                output += source.slice(start);
                break;
            }
            try {
                output += evalExpression(source.slice(start + 2, end), context);
            } catch (error: any) {
                errors.push(String(error?.message || error));
            }
            cursor = end + 1;
        }
    }
    return {html: output, errors};
}

export function existingTemplateDoc(host: PluginHost, itemKey: string): string {
    return templateLinkForItem(host, itemKey)?.docId || "";
}
