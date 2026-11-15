import {newId} from "../storage";
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
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

export function systemValue(row: MatrixRow, columnId: string): string {
    const value = row.values[columnId];
    if (value !== undefined && value !== null && value !== "") return String(value);
    return "";
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
