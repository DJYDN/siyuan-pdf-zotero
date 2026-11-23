import test from "node:test";
import assert from "node:assert/strict";
import {buildSimilarityEdges, jaccard, nodeColor, nodeRadius} from "../../.test-build/graph-similarity.mjs";
import {layoutGraph} from "../../.test-build/graph-layout.mjs";

const paper = (id, refs, citations = 10, relation = "reference") => ({
    id,
    title: `Paper ${id}`,
    year: 2020,
    citations,
    authors: [],
    refIds: refs,
    relation,
});

test("jaccard is symmetric and ignores empty sets", () => {
    assert.equal(jaccard(["a", "b"], ["b", "c"]), 1 / 3);
    assert.equal(jaccard(["a"], ["a"]), 1);
    assert.equal(jaccard([], ["a"]), 0);
    assert.equal(jaccard(["a"], ["b"]), 0);
});

test("buildSimilarityEdges keeps strong pairs and caps per node", () => {
    const papers = [
        paper("A", ["r1", "r2", "r3"]),
        paper("B", ["r1", "r2", "r3"]),
        paper("C", ["r1", "r2"]),
        paper("D", ["z1"]),
    ];
    const edges = buildSimilarityEdges(papers, {minWeight: 0.1, perNode: 2});
    assert.ok(edges.length > 0);
    assert.ok(edges.every(edge => edge.weight >= 0.1));
    assert.ok(edges.every(edge => edge.from !== edge.to));
    const degree = new Map();
    for (const edge of edges) {
        degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
        degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
    }
    for (const value of degree.values()) assert.ok(value <= 4, "perNode caps each direction");
    assert.ok(!edges.some(edge => edge.from === "D" || edge.to === "D"), "no shared references, no edge");
});

test("nodeRadius grows with citations and is capped", () => {
    assert.ok(nodeRadius(0) < nodeRadius(100));
    assert.ok(nodeRadius(100) < nodeRadius(100000));
    assert.ok(nodeRadius(1000000000) <= 26);
    assert.equal(nodeRadius(-5), nodeRadius(0));
});

test("nodeColor interpolates by year and handles missing years", () => {
    const old = nodeColor(1990, 1990, 2020);
    const recent = nodeColor(2020, 1990, 2020);
    assert.match(old, /^hsl\(\d+ \d+% \d+%\)$/);
    assert.notEqual(old, recent);
    assert.equal(nodeColor(undefined, 1990, 2020), "#94a3b8");
});

test("layoutGraph is deterministic and keeps nodes in bounds", () => {
    const build = () => [
        {...paper("seed", [], 100, "seed")},
        {...paper("B", ["r1"])},
        {...paper("C", ["r1", "r2"])},
        {...paper("D", ["r2", "r3"])},
        {...paper("E", ["r3"])},
    ];
    const edges = [
        {from: "seed", to: "B", weight: 1, kind: "reference"},
        {from: "seed", to: "C", weight: 1, kind: "reference"},
        {from: "D", to: "seed", weight: 1, kind: "citation"},
    ];
    const first = build();
    layoutGraph(first, edges, {width: 800, height: 600, iterations: 60});
    const second = build();
    layoutGraph(second, edges, {width: 800, height: 600, iterations: 60});

    for (const node of first) {
        assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
        assert.ok(node.x >= 0 && node.x <= 800);
        assert.ok(node.y >= 0 && node.y <= 600);
        assert.ok(node.radius > 0);
    }
    const seed = first.find(node => node.id === "seed");
    assert.ok(Math.abs(seed.x - 400) < 220 && Math.abs(seed.y - 300) < 220, "seed stays near the centre");
    const again = second.map(node => [node.id, Math.round(node.x), Math.round(node.y)]);
    const original = first.map(node => [node.id, Math.round(node.x), Math.round(node.y)]);
    assert.deepEqual(again, original);
});
