import test from "node:test";
import assert from "node:assert/strict";
import {autoLayoutMatrixCanvas, ensureMatrixCanvasNodes} from "../../.test-build/matrix-canvas.mjs";

const project = {
    rows: [
        {id: "r1", libraryId: 1, itemKey: "A", values: {}},
        {id: "r2", libraryId: 1, itemKey: "B", values: {}},
    ],
};

test("ensureMatrixCanvasNodes creates one row node per row and is idempotent", () => {
    const canvas = {nodes: [], edges: []};
    ensureMatrixCanvasNodes(project, canvas);
    ensureMatrixCanvasNodes(project, canvas);
    assert.equal(canvas.nodes.length, 2);
    assert.deepEqual(canvas.nodes.map(node => node.rowId), ["r1", "r2"]);
});

test("autoLayoutMatrixCanvas uses a stable 4-column grid", () => {
    const canvas = {nodes: [], edges: []};
    autoLayoutMatrixCanvas(project, canvas);
    assert.deepEqual(
        canvas.nodes.map(node => [node.x, node.y]),
        [[56, 56], [316, 56]],
    );
});
