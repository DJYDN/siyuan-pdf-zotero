import type {MatrixProject, MatrixRow} from "../types";

export function matrixRowTags(project: MatrixProject, row: MatrixRow): string[] {
    const tags: string[] = [];
    for (const column of project.columns) {
        if (column.type !== "multiselect" && !/标签|关键词|主题/.test(column.name)) continue;
        const raw = row.values[column.id];
        if (Array.isArray(raw)) tags.push(...raw.map(String));
        else if (raw) tags.push(...String(raw).split(/[,，;；]/));
    }
    return [...new Set(tags.map(item => item.trim()).filter(Boolean))];
}

export interface SuggestedRelation {
    from: string;
    to: string;
    label: string;
}

export function suggestCanvasRelations(project: MatrixProject, rows: MatrixRow[], limit = 80): SuggestedRelation[] {
    const hints: SuggestedRelation[] = [];
    const seen = new Set<string>();
    const add = (a: string, b: string, label: string) => {
        const key = [a, b].sort().join("|");
        if (a === b || seen.has(key) || hints.length >= limit) return;
        seen.add(key);
        hints.push({from: a, to: b, label});
    };
    const rowIds = new Set(rows.map(row => row.id));
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            const a = rows[i];
            const b = rows[j];
            if (!rowIds.has(a.id) || !rowIds.has(b.id)) continue;
            const tagsA = new Set(matrixRowTags(project, a));
            const sharedTag = matrixRowTags(project, b).find(tag => tagsA.has(tag));
            if (sharedTag) {
                add(a.id, b.id, `标签：${sharedTag}`);
                continue;
            }
            const authorsA = new Set(String(a.values.authors || "").split(/[;,；，]/).map(item => item.trim()).filter(Boolean));
            const sharedAuthor = String(b.values.authors || "").split(/[;,；，]/).map(item => item.trim()).find(author => author && authorsA.has(author));
            if (sharedAuthor) {
                add(a.id, b.id, `作者：${sharedAuthor}`);
                continue;
            }
            for (const column of project.columns) {
                if (!/方法|主题|结论|理论/.test(column.name) || !column.visible) continue;
                const av = String(a.values[column.id] ?? "").trim();
                const bv = String(b.values[column.id] ?? "").trim();
                if (av && av === bv) {
                    add(a.id, b.id, `${column.name}：${av.slice(0, 20)}`);
                    break;
                }
            }
        }
    }
    return hints;
}
