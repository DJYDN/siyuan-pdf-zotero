import test from "node:test";
import assert from "node:assert/strict";
import {ocrItemsToMarkdown} from "../../.test-build/ocr-client.mjs";

test("OCR formula formatting prefers markdown and supports inline/display", () => {
    const result = {ok: true, kind: "formula", markdown: "", items: [
        {type: "formula", latex: "x^2", text: "x^2", confidence: 0.9},
        {type: "text", latex: "", text: "where x is real", confidence: 0.8},
    ]};
    assert.equal(ocrItemsToMarkdown(result, "inline"), "$x^2$\n\nwhere x is real");
    assert.equal(ocrItemsToMarkdown(result, "display"), "$$x^2$$\n\nwhere x is real");
});

test("OCR markdown output is preserved when server already returned markdown", () => {
    const result = {ok: true, kind: "formula", markdown: "$$x$$", items: []};
    assert.equal(ocrItemsToMarkdown(result, "inline"), "$$x$$");
});
