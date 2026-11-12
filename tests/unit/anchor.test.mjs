import test from "node:test";
import assert from "node:assert/strict";
import {annotationHref, normalizeClientRect, parsePluginUrl, rectsFromSelection} from "../../.test-build/anchor.mjs";

test("parsePluginUrl accepts this plugin's annotation URL", () => {
    const parsed = parsePluginUrl("siyuan://plugins/siyuan-pdf-zotero/annotation?id=ann-123");
    assert.deepEqual(parsed, {
        pluginName: "siyuan-pdf-zotero",
        route: "annotation",
        id: "ann-123",
    });
});

test("parsePluginUrl rejects other plugins and malformed URLs", () => {
    assert.equal(parsePluginUrl("siyuan://plugins/other/annotation?id=1"), null);
    assert.equal(parsePluginUrl("https://example.com"), null);
    assert.equal(parsePluginUrl("siyuan://plugins/siyuan-pdf-zotero"), null);
});

test("parsePluginUrl preserves a PDF screenshot region", () => {
    const parsed = parsePluginUrl("siyuan://plugins/siyuan-pdf-zotero/pdf?id=att-1&page=7&rect=10.5,20,30.5,40&color=blue");
    assert.deepEqual(parsed, {
        pluginName: "siyuan-pdf-zotero",
        route: "pdf",
        id: "att-1",
        page: 7,
        rect: [10.5, 20, 30.5, 40],
        color: "blue",
    });
});

test("annotationHref keeps the id URL-encoded and stable", () => {
    const href = annotationHref("ann/a b");
    assert.equal(href, "siyuan://plugins/siyuan-pdf-zotero/annotation?id=ann%2Fa%20b");
    const parsed = parsePluginUrl(href);
    assert.equal(parsed.id, "ann/a b");
});

test("normalizeClientRect converts viewport pixels to normalized page coords", () => {
    const rect = normalizeClientRect(
        {left: 150, top: 260, width: 100, height: 20},
        {left: 100, top: 200, width: 400, height: 600},
    );
    assert.ok(rect);
    assert.equal(rect.x, 0.125);
    assert.equal(rect.y, 0.1);
    assert.equal(rect.w, 0.25);
    assert.ok(Math.abs(rect.h - 0.03333333333333333) < 1e-12);
});

test("normalizeClientRect clamps selection rectangles to the page", () => {
    const rect = normalizeClientRect(
        {left: 80, top: 190, width: 500, height: 700},
        {left: 100, top: 200, width: 400, height: 600},
    );
    assert.ok(rect);
    assert.equal(rect.x, 0);
    assert.equal(rect.y, 0);
    assert.equal(rect.x + rect.w, 1);
    assert.equal(rect.y + rect.h, 1);
});

test("normalizeClientRect rejects empty or off-page rectangles", () => {
    assert.equal(normalizeClientRect(
        {left: 100, top: 200, width: 0, height: 10},
        {left: 100, top: 200, width: 400, height: 600},
    ), null);
    assert.equal(normalizeClientRect(
        {left: 100, top: 200, width: 100, height: 10},
        {left: 100, top: 200, width: 0, height: 600},
    ), null);
});

test("rectsFromSelection uses a fake range without a DOM", () => {
    const range = {
        toString: () => "  hello   PDF  ",
        getClientRects: () => [
            {left: 200, top: 300, width: 80, height: 12},
            {left: 200, top: 316, width: 40, height: 12},
        ],
    };
    const page = {
        getBoundingClientRect: () => ({left: 100, top: 200, width: 400, height: 600}),
    };
    const anchor = rectsFromSelection(range, page, {page: 3, pageWidth: 595, pageHeight: 842, rotation: 0});
    assert.ok(anchor);
    assert.equal(anchor.page, 3);
    assert.equal(anchor.text, "hello PDF");
    assert.equal(anchor.rects.length, 2);
    assert.equal(anchor.rects[0].x, 0.25);
    assert.equal(anchor.rects[0].y, 0.16666666666666666);
    assert.equal(anchor.rects[0].w, 0.2);
    assert.ok(Math.abs(anchor.rects[0].h - 0.02) < 1e-12);
});

test("rectsFromSelection merges overlapping PDF text-layer fragments on one visual line", () => {
    const range = {
        toString: () => "overlapping fragments",
        getClientRects: () => [
            {left: 120, top: 220, width: 90, height: 14},
            {left: 205, top: 221, width: 80, height: 13},
            {left: 120, top: 240, width: 70, height: 14},
        ],
    };
    const page = {
        getBoundingClientRect: () => ({left: 100, top: 200, width: 400, height: 600}),
    };
    const anchor = rectsFromSelection(range, page, {page: 1, pageWidth: 400, pageHeight: 600, rotation: 0});
    assert.ok(anchor);
    assert.equal(anchor.rects.length, 2);
    assert.ok(Math.abs(anchor.rects[0].x - 0.05) < 1e-12);
    assert.ok(Math.abs(anchor.rects[0].y - 1 / 30) < 1e-12);
    assert.ok(Math.abs(anchor.rects[0].w - 0.4125) < 1e-12);
    assert.ok(Math.abs(anchor.rects[0].h - 7 / 300) < 1e-12);
});
