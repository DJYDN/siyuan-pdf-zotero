import test from "node:test";
import assert from "node:assert/strict";
import {findLocalTarget, normalizeDoi, normalizeTitle} from "../../.test-build/graph-local-match.mjs";

const baseState = () => ({
    books: {},
    attachments: {},
    zotero: {items: [], attachments: [], collections: [], dataDir: "", libraryId: 0, updatedAt: 0, lastError: ""},
});

test("normalizeDoi strips prefixes and case", () => {
    assert.equal(normalizeDoi("https://doi.org/10.1038/NATURE14539"), "10.1038/nature14539");
    assert.equal(normalizeDoi("doi: 10.1/x"), "10.1/x");
    assert.equal(normalizeDoi(undefined), "");
});

test("normalizeTitle drops punctuation and spacing", () => {
    assert.equal(normalizeTitle("Deep Learning: A Review!"), "deeplearningareview");
    assert.equal(normalizeTitle("  "), "");
});

test("findLocalTarget prefers a Zotero item with a cached PDF", () => {
    const state = baseState();
    state.zotero.items.push({key: "ABCD1234", title: "Deep learning", doi: "10.1038/nature14539", csl: {DOI: "10.1038/nature14539"}});
    state.zotero.attachments.push({parentItemKey: "ABCD1234", attachmentKey: "PDF1", attachmentTitle: "Full Text PDF", filename: "a.pdf", rawPath: "storage:a.pdf", contentType: "application/pdf"});
    const target = findLocalTarget(state, {doi: "https://doi.org/10.1038/NATURE14539", title: "Deep learning"});
    assert.deepEqual(target, {kind: "zotero", id: "ABCD1234"});
});

test("findLocalTarget ignores Zotero items without a PDF", () => {
    const state = baseState();
    state.zotero.items.push({key: "NOPDF", title: "Some paper", doi: "10.1/nopdf", csl: {}});
    assert.equal(findLocalTarget(state, {doi: "10.1/nopdf", title: "Some paper"}), null);
});

test("findLocalTarget falls back to an imported attachment by title", () => {
    const state = baseState();
    state.books = {b1: {id: "b1", title: "Deep Learning", authors: [], source: "local", createdAt: 0, updatedAt: 0}};
    state.attachments = {a1: {id: "a1", bookId: "b1", path: "a.pdf", source: "local", fingerprint: "f", fileName: "a.pdf", size: 1, mtimeMs: 1, isPrimary: true}};
    assert.deepEqual(findLocalTarget(state, {title: "deep-learning"}), {kind: "attachment", id: "a1"});
});

test("findLocalTarget requires a long enough title to match", () => {
    const state = baseState();
    state.zotero.items.push({key: "SHORT", title: "AI", doi: "", csl: {}});
    state.zotero.attachments.push({parentItemKey: "SHORT", attachmentKey: "P", attachmentTitle: "pdf", filename: "p.pdf", rawPath: "p.pdf", contentType: "application/pdf"});
    assert.equal(findLocalTarget(state, {title: "AI"}), null);
});
