import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {fixtureDir, nodeGetDocument} from "./pdf-test-utils.mjs";
import {getLinkBoxes, loadOutline} from "../../.test-build/pdf-links.mjs";

const fixture = path.join(fixtureDir, "navigation.pdf");

test("loadOutline resolves LaTeX bookmarks to 1-based pages", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = nodeGetDocument(pdfjs, fixture);
    const pdf = await task.promise;
    try {
        const outline = await loadOutline(pdf);
        assert.ok(outline.length >= 4);
        assert.equal(outline[0].title, "1 Introduction");
        assert.equal(outline[0].page, 2);
        assert.equal(outline[1].page, 3);
    } finally {
        await task.destroy();
    }
});

test("getLinkBoxes converts PDF link rects and resolves internal destinations", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = nodeGetDocument(pdfjs, fixture);
    const pdf = await task.promise;
    try {
        let total = 0;
        const pageTargets = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({scale: 1.15});
            const boxes = await getLinkBoxes(pdf, page, pageNumber, viewport);
            total += boxes.length;
            for (const box of boxes) {
                assert.ok(box.rect.x >= 0 && box.rect.x <= 1);
                assert.ok(box.rect.y >= 0 && box.rect.y <= 1);
                assert.ok(box.rect.w > 0 && box.rect.h > 0);
                if (box.page) {
                    pageTargets.push(box.page);
                }
            }
        }
        assert.equal(total, 7);
        assert.deepEqual([...new Set(pageTargets)].sort(), [2, 3, 4, 5]);
    } finally {
        await task.destroy();
    }
});
