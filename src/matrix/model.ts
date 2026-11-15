import {newId} from "../storage";
import {MATRIX_SCHEMA_VERSION} from "../constants";
import type {MatrixColumn, MatrixProject, MatrixRow} from "../types";

export const RESEARCH_COLUMNS: Array<Pick<MatrixColumn, "name" | "type" | "source" | "options">> = [
    {name: "研究问题", type: "longtext", source: "research"},
    {name: "理论框架", type: "longtext", source: "research"},
    {name: "方法", type: "longtext", source: "research"},
    {name: "数据/样本", type: "longtext", source: "research"},
    {name: "变量/测量", type: "longtext", source: "research"},
    {name: "主要发现", type: "longtext", source: "research"},
    {name: "结论", type: "longtext", source: "research"},
    {name: "局限", type: "longtext", source: "research"},
    {name: "相关性", type: "rating", source: "research"},
    {name: "质量/偏倚", type: "rating", source: "research"},
    {name: "状态", type: "select", source: "research", options: ["未读", "在读", "已读", "已摘录"]},
    {name: "我的评价", type: "longtext", source: "research"},
];

export function defaultMatrixColumns(): MatrixColumn[] {
    const system: MatrixColumn[] = [
        {id: "title", name: "标题", type: "text", visible: true, system: true, source: "zotero", width: 260},
        {id: "authors", name: "作者", type: "text", visible: true, system: true, source: "zotero", width: 180},
        {id: "year", name: "年份", type: "number", visible: true, system: true, source: "zotero", width: 80},
        {id: "venue", name: "期刊/会议", type: "text", visible: true, system: true, source: "zotero", width: 160},
        {id: "doi", name: "DOI", type: "text", visible: true, system: true, source: "zotero", width: 180},
        {id: "pdf", name: "PDF", type: "text", visible: true, system: true, source: "zotero", width: 60},
        {id: "note", name: "笔记", type: "text", visible: true, system: true, source: "zotero", width: 60},
        {id: "citation", name: "引文", type: "text", visible: true, system: true, source: "zotero", width: 120},
    ];
    return [...system, ...RESEARCH_COLUMNS.map(item => ({
        id: newId("mxcol"),
        name: item.name,
        type: item.type,
        options: item.options,
        source: "research" as const,
        visible: true,
        system: false,
        width: item.type === "longtext" ? 220 : item.type === "rating" ? 80 : 120,
    }))];
}

export function createMatrixProject(name: string, collectionKeys: string[] = []): MatrixProject {
    return {
        id: newId("mx"),
        name: name.trim() || "未命名研究项目",
        collectionKeys,
        columns: defaultMatrixColumns(),
        rows: [],
        views: [],
        schemaVersion: MATRIX_SCHEMA_VERSION,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

export function systemValue(row: MatrixRow, columnId: string): string {
    const value = row.values[columnId];
    if (value !== undefined && value !== null && value !== "") return String(value);
    return "";
}

export function migrateMatrixProject(raw: any): {project: MatrixProject; changed: boolean} {
    let changed = false;
    const project: MatrixProject = {
        id: String(raw?.id || newId("mx")),
        name: String(raw?.name || "未命名研究项目"),
        collectionKeys: Array.isArray(raw?.collectionKeys) ? raw.collectionKeys.map(String) : [],
        columns: Array.isArray(raw?.columns) ? raw.columns : defaultMatrixColumns(),
        rows: Array.isArray(raw?.rows) ? raw.rows : [],
        views: Array.isArray(raw?.views) ? raw.views : [],
        schemaReviewed: Boolean(raw?.schemaReviewed),
        schemaVersion: Number(raw?.schemaVersion || 0),
        createdAt: Number(raw?.createdAt || Date.now()),
        updatedAt: Number(raw?.updatedAt || Date.now()),
    };
    if (!Array.isArray(raw?.columns) || !project.columns.length) changed = true;
    if (!Array.isArray(raw?.rows)) changed = true;
    if (!Array.isArray(raw?.views)) changed = true;
    for (const view of project.views) {
        if (!view.id) { view.id = newId("mxview"); changed = true; }
        if (!view.kind) { view.kind = "table"; changed = true; }
        if (!Array.isArray(view.filters)) { view.filters = []; changed = true; }
        if (!view.filterLogic) { view.filterLogic = "and"; changed = true; }
        if (view.kind === "canvas") {
            if (!view.canvas) { view.canvas = {nodes: [], edges: []}; changed = true; }
            if (!Array.isArray(view.canvas.nodes)) { view.canvas.nodes = []; changed = true; }
            if (!Array.isArray(view.canvas.edges)) { view.canvas.edges = []; changed = true; }
            view.canvas.nodes = view.canvas.nodes.filter(node => node && node.id).map(node => ({...node, x: Number(node.x) || 0, y: Number(node.y) || 0}));
            view.canvas.edges = view.canvas.edges.filter(edge => edge && edge.id && edge.from && edge.to);
        }
    }
    if (project.schemaVersion !== MATRIX_SCHEMA_VERSION) {
        project.schemaVersion = MATRIX_SCHEMA_VERSION;
        changed = true;
    }
    return {project, changed};
}

export function formulaValue(project: MatrixProject, row: MatrixRow, column: MatrixColumn): string {
    const expression = String(column.formula || "").trim();
    if (!expression) return "";
    const [operatorRaw, source] = expression.split(":", 2);
    const operator = operatorRaw.toLowerCase();
    const sourceColumn = source ? project.columns.find(item => item.id === source || item.name === source) : undefined;
    const raw = sourceColumn ? row.values[sourceColumn.id] : undefined;
    const values = Array.isArray(raw) ? raw : raw !== undefined && raw !== null && String(raw).trim() ? [raw] : [];
    if (operator === "count") return String(values.length);
    const numbers = values.map(value => Number(value)).filter(value => Number.isFinite(value));
    if (!numbers.length) return "";
    if (operator === "sum") return String(numbers.reduce((sum, value) => sum + value, 0));
    if (operator === "avg") return String(Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length * 100) / 100);
    if (operator === "min") return String(Math.min(...numbers));
    if (operator === "max") return String(Math.max(...numbers));
    return "";
}

export interface MatrixSchemaSuggestion {
    columnId: string;
    name: string;
    currentType: MatrixColumn["type"];
    suggestedType: MatrixColumn["type"];
    options?: string[];
}

export function suggestMatrixSchema(project: MatrixProject): MatrixSchemaSuggestion[] {
    const suggestions: MatrixSchemaSuggestion[] = [];
    for (const column of project.columns || []) {
        const name = column.name || "";
        let suggested: MatrixColumn["type"] | null = null;
        if (!column.type) suggested = /年份|year/i.test(name) ? "number" : /DOI|URL|链接/i.test(name) ? "url" : /状态/.test(name) ? "select" : /相关性|质量|评分/.test(name) ? "rating" : /问题|框架|方法|数据|变量|发现|结论|局限|评价/.test(name) ? "longtext" : "text";
        else if (column.type === "text" && /年份|year/i.test(name) && project.rows.some(row => /^\d{4}$/.test(String(row.values[column.id] ?? "")))) suggested = "number";
        else if (column.type === "text" && /DOI|URL|链接/i.test(name)) suggested = "url";
        else if (column.type === "text" && /状态/.test(name)) suggested = "select";
        if (suggested && suggested !== column.type) {
            suggestions.push({columnId: column.id, name: column.name, currentType: column.type || "text", suggestedType: suggested, options: suggested === "select" && !column.options?.length ? ["未读", "在读", "已读", "已摘录"] : column.options});
        }
    }
    return suggestions;
}

export function normalizeMatrixSchema(project: MatrixProject): boolean {
    let changed = false;
    for (const column of project.columns || []) {
        if (!column.type) {
            const name = column.name || "";
            column.type = /年份|year/i.test(name) ? "number" : /DOI|URL|链接/i.test(name) ? "url" : /状态/.test(name) ? "select" : /相关性|质量|评分/.test(name) ? "rating" : /问题|框架|方法|数据|变量|发现|结论|局限|评价/.test(name) ? "longtext" : "text";
            changed = true;
        }
        if (column.type === "select" && !column.options?.length && /状态/.test(column.name)) {
            column.options = ["未读", "在读", "已读", "已摘录"];
            changed = true;
        }
    }
    return changed;
}

export function rowForZoteroItem(item: any, libraryId: number): MatrixRow {
    const creators = Array.isArray(item?.creators) ? item.creators : [];
    const csl = item?.csl || {};
    return {
        id: newId("mxrow"),
        libraryId,
        itemKey: String(item?.key || ""),
        values: {
            title: String(item?.title || csl.title || ""),
            authors: creators.join("; "),
            year: String(item?.year || csl.issued?.["date-parts"]?.[0]?.[0] || ""),
            venue: String(csl["container-title"] || ""),
            doi: String(item?.doi || csl.DOI || ""),
            citation: String(csl["citation-key"] || ""),
        },
        lastZoteroSyncAt: Date.now(),
    };
}
