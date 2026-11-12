import test from "node:test";
import assert from "node:assert/strict";
import {displayTextForAnnotation, displayTextForScreenshot, formatAnnotationCopy, formatHrefCopy} from "../../.test-build/link-format.mjs";

const annotation = {
    id: "ann-1",
    attachmentId: "att-1",
    page: 8,
    rects: [],
    text: "由定义域 A 到值域 B 的函数",
    color: "#ffd400",
    pageWidth: 600,
    pageHeight: 800,
    rotation: 0,
    createdAt: 1,
    updatedAt: 1,
};
const book = {id: "b1", title: "大规模语言模型.pdf", authors: [], source: "local"};

test("display text formats match PDF++ options", () => {
    assert.equal(displayTextForAnnotation(annotation, book, "title-page"), "大规模语言模型, p.8");
    assert.equal(displayTextForAnnotation(annotation, book, "page"), "p.8");
    assert.ok(displayTextForAnnotation(annotation, book, "text").includes("定义域"));
    assert.equal(displayTextForAnnotation(annotation, book, "emoji"), "📄");
    assert.equal(displayTextForScreenshot("大规模语言模型.pdf", 8, "text"), "大规模语言模型 · p.8");
    assert.equal(displayTextForScreenshot("大规模语言模型.pdf", 8, "none"), "");
});

test("link copy formats produce link, embed, callout and quote callout", () => {
    const quoteBlock = formatAnnotationCopy(annotation, book, "quote", "title-page");
    assert.match(quoteBlock, /^> \[大规模语言模型, p\.8\]\(/);
    assert.ok(quoteBlock.includes("由定义域"));
    const link = formatAnnotationCopy(annotation, book, "link", "page");
    assert.match(link, /^\[p\.8\]\(siyuan:\/\/plugins\/siyuan-pdf-zotero\/annotation\?id=ann-1\)$/);

    const embed = formatAnnotationCopy(annotation, book, "embed", "page");
    assert.ok(embed.startsWith("![p.8]("));

    const callout = formatAnnotationCopy(annotation, book, "callout", "page");
    assert.ok(callout.startsWith("> [!PDF|yellow]"));
    assert.ok(callout.includes("p.8"));

    const quote = formatAnnotationCopy(annotation, book, "quote-callout", "page");
    assert.ok(quote.startsWith("> [!PDF|yellow]"));
    assert.ok(quote.includes("\n> > "));
    assert.ok(quote.includes("由定义域"));
});

test("rectangular selection copy formats", () => {
    const href = "siyuan://plugins/siyuan-pdf-zotero/pdf?id=att-1&page=8&rect=10,20,30,40&color=yellow";
    assert.ok(formatHrefCopy(href, "p.8", "embed", "file.pdf", 8).startsWith("![p.8]("));
    assert.ok(formatHrefCopy(href, "p.8", "callout", "file.pdf", 8).startsWith("> [!PDF|yellow]"));
    assert.equal(formatHrefCopy(href, "p.8", "link", "file.pdf", 8), `[p.8](${href})`);
});
