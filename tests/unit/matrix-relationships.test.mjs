import test from "node:test";
import assert from "node:assert/strict";
import {matrixRowTags, suggestCanvasRelations} from "../../.test-build/matrix-relationships.mjs";

const project = {
    columns: [
        {id: "authors", name: "作者", type: "text", visible: true, system: false, source: "custom"},
        {id: "tags", name: "标签", type: "multiselect", visible: true, system: false, source: "custom"},
        {id: "method", name: "方法", type: "text", visible: true, system: false, source: "custom"},
    ],
};
const rows = [
    {id: "r1", libraryId: 1, itemKey: "A", values: {authors: "张三; 李四", tags: ["机器人", "控制"], method: "PID"}},
    {id: "r2", libraryId: 1, itemKey: "B", values: {authors: "张三", tags: ["控制"], method: "PID"}},
    {id: "r3", libraryId: 1, itemKey: "C", values: {authors: "王五", tags: ["视觉"], method: "CNN"}},
];

test("matrixRowTags reads multiselect and tag-like columns", () => {
    assert.deepEqual(matrixRowTags(project, rows[0]).sort(), ["机器人", "控制"].sort());
});

test("suggestCanvasRelations finds shared tags, authors and field values", () => {
    const relations = suggestCanvasRelations(project, rows);
    assert.ok(relations.some(item => item.from === "r1" && item.to === "r2"));
    assert.ok(relations.every(item => item.from !== "r3" && item.to !== "r3" || item.label));
});
