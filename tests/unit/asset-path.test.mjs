import test from "node:test";
import assert from "node:assert/strict";
import {imageHtml, linkedImageMarkdown, normalizeAssetPath} from "../../.test-build/asset-path.mjs";

test("normalizeAssetPath fixes the legacy data/assets upload path", () => {
    assert.equal(normalizeAssetPath("data/assets/pz-shot.png"), "assets/pz-shot.png");
    assert.equal(normalizeAssetPath("/data/assets/pz-shot.png"), "assets/pz-shot.png");
    assert.equal(normalizeAssetPath("assets/pz-shot.png"), "assets/pz-shot.png");
    assert.equal(normalizeAssetPath("/assets/pz-shot.png"), "assets/pz-shot.png");
});

test("imageHtml uses a note-relative assets path", () => {
    assert.equal(
        imageHtml("data/assets/pz-shot.png", "PDF 第 1 页截图"),
        '<img src="assets/pz-shot.png" alt="PDF 第 1 页截图" title="PDF 第 1 页截图" />',
    );
});

test("linkedImageMarkdown makes the image clickable and keeps caption plain", () => {
    assert.equal(
        linkedImageMarkdown("assets/pz-shot.png", "截图", "siyuan://plugins/test/pdf?id=1&page=2&color=yellow", "论文.pdf p.2"),
        '![截图](assets/pz-shot.png#pz=siyuan%3A%2F%2Fplugins%2Ftest%2Fpdf%3Fid%3D1%26page%3D2%26color%3Dyellow "论文.pdf p.2")',
    );
});

test("linkedImageMarkdown omits the generic image title when no caption is requested", () => {
    assert.equal(
        linkedImageMarkdown("assets/pz-shot.png", "PDF 第 1 页截图", "siyuan://plugins/test/pdf?id=1&page=1"),
        "![PDF 第 1 页截图](assets/pz-shot.png#pz=siyuan%3A%2F%2Fplugins%2Ftest%2Fpdf%3Fid%3D1%26page%3D1)",
    );
});
