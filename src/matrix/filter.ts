import type {MatrixFilterCondition, MatrixProject, MatrixRow} from "../types";
import {formulaValue} from "./model";

function valueFor(project: MatrixProject, row: MatrixRow, columnId: string): string {
    const column = project.columns.find(item => item.id === columnId);
    const raw = column?.type === "formula" ? formulaValue(project, row, column) : row.values[columnId];
    return Array.isArray(raw) ? raw.join(", ") : String(raw ?? "");
}

export function matchesMatrixFilter(project: MatrixProject, row: MatrixRow, condition: MatrixFilterCondition): boolean {
    const value = valueFor(project, row, condition.columnId);
    const target = condition.value.trim();
    if (condition.operator === "not-empty") return value.trim().length > 0;
    if (!target) return true;
    if (condition.operator === "equals") return value.toLocaleLowerCase() === target.toLocaleLowerCase();
    if (condition.operator === "gt") return Number(value) > Number(target);
    if (condition.operator === "lt") return Number(value) < Number(target);
    return value.toLocaleLowerCase().includes(target.toLocaleLowerCase());
}

export function filterMatrixRows(
    project: MatrixProject,
    rows: MatrixRow[],
    filters: MatrixFilterCondition[],
    logic: "and" | "or" = "and",
): MatrixRow[] {
    if (!filters.length) return rows;
    return rows.filter(row => logic === "or"
        ? filters.some(condition => matchesMatrixFilter(project, row, condition))
        : filters.every(condition => matchesMatrixFilter(project, row, condition)));
}
