import test from "node:test";
import assert from "node:assert/strict";

const {cleanDoc2xMarkdown, firstHeading, DEFAULT_CLEAN_OPTIONS} = await import("../../.test-build/doc2x-clean.mjs");

test("converts LaTeX bracket delimiters to dollar delimiters", () => {
    const input = "before\n\\[\nE = mc^2\n\\]\nafter \\(x+y\\) end";
    const result = cleanDoc2xMarkdown(input);
    assert.match(result.markdown, /\$\$\nE = mc\^2\n\$\$/);
    assert.match(result.markdown, /\$x\+y\$/);
    assert.equal(result.markdown.includes("\\["), false);
});

test("converts simple HTML tables to Markdown pipe tables", () => {
    const input = `<table><tr><td>Symbol</td><td>Value</td></tr><tr><td>\\mu</td><td>73 kPa</td></tr></table>`;
    const result = cleanDoc2xMarkdown(input);
    assert.match(result.markdown, /\| Symbol \| Value \|/);
    assert.match(result.markdown, /\| \\mu \| 73 kPa \|/);
    assert.equal(result.warnings.length, 0);
});

test("keeps complex tables and reports a warning", () => {
    const input = `<table><tr><td colspan="2">merged</td></tr><tr><td>a</td><td>b</td></tr></table>`;
    const result = cleanDoc2xMarkdown(input);
    assert.match(result.markdown, /<table>/);
    assert.ok(result.warnings.some(item => item.includes("合并单元格")));
});

test("removes Doc2X wrapper tags and comments", () => {
    const input = `<!-- page marker -->\n<div>\n<span>text</span>\n</div>\n<hr/>`;
    const result = cleanDoc2xMarkdown(input);
    assert.equal(result.markdown.includes("<!--"), false);
    assert.equal(result.markdown.includes("<div>"), false);
    assert.equal(result.markdown.includes("<span>"), false);
    assert.match(result.markdown, /text/);
});

test("respects disabled clean options", () => {
    const input = "\\[x\\]\n<div>keep</div>";
    const result = cleanDoc2xMarkdown(input, {...DEFAULT_CLEAN_OPTIONS, math: false, html: false});
    assert.equal(result.markdown.includes("\\[x\\]"), true);
    assert.equal(result.markdown.includes("<div>"), true);
});

test("firstHeading extracts a readable title", () => {
    assert.equal(firstHeading("# Hello World\ncontent"), "Hello World");
    assert.equal(firstHeading("Table 1. Some caption\n\nbody"), "Table 1. Some caption");
});
