import test from "node:test";
import assert from "node:assert/strict";
import {filterMatrixRows, matchesMatrixFilter} from "../../.test-build/matrix-filter.mjs";

const project = {
    columns: [
        {id: "title", name: "标题", type: "text", visible: true, system: false, source: "custom"},
        {id: "year", name: "年份", type: "number", visible: true, system: false, source: "custom"},
        {id: "status", name: "状态", type: "select", visible: true, system: false, source: "custom", options: ["未读", "已读"]},
    ],
};
const rows = [
    {id: "r1", libraryId: 1, itemKey: "A", values: {title: "机器人综述", year: "2024", status: "已读"}},
    {id: "r2", libraryId: 1, itemKey: "B", values: {title: "其他主题", year: "2020", status: "未读"}},
];

test("matchesMatrixFilter supports contains/equals/number comparisons", () => {
    assert.equal(matchesMatrixFilter(project, rows[0], {id: "f1", columnId: "title", operator: "contains", value: "机器人"}), true);
    assert.equal(matchesMatrixFilter(project, rows[0], {id: "f2", columnId: "status", operator: "equals", value: "已读"}), true);
    assert.equal(matchesMatrixFilter(project, rows[0], {id: "f3", columnId: "year", operator: "gt", value: "2023"}), true);
    assert.equal(matchesMatrixFilter(project, rows[1], {id: "f4", columnId: "year", operator: "gt", value: "2023"}), false);
});

test("filterMatrixRows combines conditions with AND and OR", () => {
    const filters = [
        {id: "f1", columnId: "title", operator: "contains", value: "机器人"},
        {id: "f2", columnId: "status", operator: "equals", value: "未读"},
    ];
    assert.equal(filterMatrixRows(project, rows, filters, "and").length, 0);
    assert.equal(filterMatrixRows(project, rows, filters, "or").length, 2);
});
