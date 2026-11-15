import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {fixtureDir, nodeGetDocument} from "./pdf-test-utils.mjs";

const fixture = path.join(fixtureDir, "sample-paper.pdf");

test("PDF.js loads the fixture, extracts selectable text and page geometry", async () => {
    // The legacy build is the supported Node.js build and avoids browser-only V8 helpers.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = nodeGetDocument(pdfjs, fixture);
    const pdf = await loadingTask.promise;
    try {
        assert.equal(pdf.numPages, 2);
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({scale: 1});
        assert.equal(Math.round(viewport.width), 595);
        assert.equal(Math.round(viewport.height), 842);
        const text = await page.getTextContent();
        assert.ok(text.items.length > 100);
        const joined = text.items.map(item => item.str).join(" ");
        assert.match(joined, /poly\(vinyl chlo/i);
        assert.match(joined, /PVC/);
    } finally {
        await loadingTask.destroy();
    }
});
