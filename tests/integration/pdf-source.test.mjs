import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

globalThis.__pzNodeRequire = createRequire(import.meta.url);
const {defaultTitleFromFileName, loadAttachmentBytes} = await import("../../.test-build/pdf-source.mjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = path.join(root, "test-fixtures", "sample-paper.pdf");

function attachment(overrides = {}) {
    return {
        id: "att-test",
        bookId: "book-test",
        path: fixture,
        source: "local",
        fingerprint: "",
        fileName: "sample-paper.pdf",
        size: 0,
        mtimeMs: 0,
        isPrimary: true,
        ...overrides,
    };
}

test("loadAttachmentBytes reads a real external PDF from disk without copying it", async () => {
    const result = await loadAttachmentBytes(attachment());
    assert.equal(String.fromCharCode(...result.bytes.slice(0, 5)), "%PDF-");
    assert.equal(result.bytes.length, 144786);
    assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(result.size, 144786);
    assert.equal(result.changed, false);
});

test("loadAttachmentBytes detects a content change via fingerprint", async () => {
    const first = await loadAttachmentBytes(attachment());
    const second = await loadAttachmentBytes(attachment({fingerprint: first.fingerprint}));
    assert.equal(second.changed, false);
    const changed = await loadAttachmentBytes(attachment({fingerprint: "deadbeef"}));
    assert.equal(changed.changed, true);
});

test("loadAttachmentBytes fails clearly for a missing file instead of pretending success", async () => {
    await assert.rejects(
        () => loadAttachmentBytes(attachment({path: path.join(root, "test-fixtures", "missing.pdf")})),
        /不存在或不可访问/,
    );
});

test("defaultTitleFromFileName strips the pdf extension", () => {
    assert.equal(defaultTitleFromFileName("A Study.PDF"), "A Study");
    assert.equal(defaultTitleFromFileName("paper.pdf"), "paper");
});
