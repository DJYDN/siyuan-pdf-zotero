import test from "node:test";
import assert from "node:assert/strict";
import {migrateMatrixProject, formulaValue} from "../../.test-build/matrix-model.mjs";

test("migrateMatrixProject upgrades legacy views and canvas state", () => {
    const {project, changed} = migrateMatrixProject({
        id: "mx1",
        name: "legacy",
        columns: [{id: "c1", name: "n", type: "number", visible: true, system: false, source: "custom"}],
        rows: [{id: "r1", libraryId: 1, itemKey: "K1", values: {c1: 3}}],
        views: [{id: "v1", name: "legacy view", filter: "", sortColumn: "", sortDirection: "asc"}],
    });
    assert.equal(changed, true);
    assert.equal(project.schemaVersion, 3);
    assert.equal(project.views[0].kind, "table");
    assert.deepEqual(project.views[0].filters, []);
    assert.equal(project.views[0].filterLogic, "and");
});

test("migrateMatrixProject initializes canvas arrays", () => {
    const {project} = migrateMatrixProject({
        id: "mx2",
        name: "canvas",
        columns: [],
        rows: [],
        views: [{id: "v2", name: "canvas view", filter: "", sortColumn: "", sortDirection: "asc", kind: "canvas"}],
    });
    assert.equal(project.views[0].kind, "canvas");
    assert.deepEqual(project.views[0].canvas, {nodes: [], edges: []});
});

test("migrateMatrixProject supplies safe defaults for absent state", () => {
    const {project, changed} = migrateMatrixProject(null);
    assert.equal(changed, true);
    assert.equal(project.schemaVersion, 3);
    assert.ok(project.columns.length > 0);
    assert.deepEqual(project.rows, []);
    assert.deepEqual(project.views, []);
});

test("formulaValue computes count and sum", () => {
    const project = {
        columns: [
            {id: "c1", name: "a", type: "number", visible: true, system: false, source: "custom"},
            {id: "c2", name: "sum", type: "formula", formula: "sum:c1", visible: true, system: false, source: "custom"},
            {id: "c3", name: "count", type: "formula", formula: "count:c1", visible: true, system: false, source: "custom"},
        ],
    };
    const row = {id: "r1", libraryId: 1, itemKey: "K1", values: {c1: 7}};
    assert.equal(formulaValue(project, row, project.columns[1]), "7");
    assert.equal(formulaValue(project, row, project.columns[2]), "1");
});

