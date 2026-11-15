import {newId} from "../storage";
import type {MatrixCanvasState, MatrixProject} from "../types";

export function ensureMatrixCanvasNodes(project: MatrixProject, canvas: MatrixCanvasState): MatrixCanvasState {
    const existing = new Set(canvas.nodes.filter(node => node.kind === "row").map(node => node.rowId));
    let index = canvas.nodes.length;
    for (const row of project.rows) {
        if (existing.has(row.id)) continue;
        canvas.nodes.push({
            id: newId("mxnode"),
            kind: "row",
            rowId: row.id,
            x: 56 + (index % 4) * 260,
            y: 56 + Math.floor(index / 4) * 118,
            width: 232,
            height: 86,
        });
        index++;
    }
    return canvas;
}

export function autoLayoutMatrixCanvas(project: MatrixProject, canvas: MatrixCanvasState): void {
    ensureMatrixCanvasNodes(project, canvas);
    let index = 0;
    for (const node of canvas.nodes) {
        if (node.kind !== "row") continue;
        node.x = 56 + (index % 4) * 260;
        node.y = 56 + Math.floor(index / 4) * 118;
        index++;
    }
}
