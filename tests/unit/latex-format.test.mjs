import test from "node:test";
import assert from "node:assert/strict";

const {formatLatex, shouldFormatLatex, extractLatexFromKramdown} = await import("../../.test-build/ocr-latex-format.mjs");

test("shouldFormatLatex detects long formulas and multiline environments", () => {
    assert.equal(shouldFormatLatex("x^2+1"), false);
    assert.equal(shouldFormatLatex("a".repeat(121)), true);
    assert.equal(shouldFormatLatex("\\begin{aligned} a &= b \\end{aligned}"), true);
    assert.equal(shouldFormatLatex("\\begin{cases} x & x>0 \\\\ 0 & \\text{else} \\end{cases}"), true);
});

test("formatLatex keeps the rendered formula identical (no new commands)", () => {
    const source = "\\left\\{\\begin{aligned} & & f(x)=\\frac{a}{b} \\\\ & & g(x)=\\frac{c}{d} \\end{aligned}\\right.";
    const formatted = formatLatex(source);
    // No semantic changes: same command/environment counts, same braces, only whitespace added.
    for (const pattern of [/\\begin\{/g, /\\end\{/g, /\{/g, /\}/g, /\\frac/g, /\\\\/g]) {
        const before = (source.match(pattern) || []).length;
        const after = (formatted.match(pattern) || []).length;
        assert.equal(after, before, `${pattern} count preserved`);
    }
    assert.ok(formatted.split("\n").length > 3, "multiline output");
});

test("formatLatex indents environment bodies and breaks at line breaks", () => {
    const formatted = formatLatex("\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}");
    assert.equal(formatted, [
        "\\begin{aligned}",
        "  a &= b \\\\",
        "  c &= d",
        "\\end{aligned}",
    ].join("\n"));
});

test("formatLatex breaks top-level relations for long plain formulas", () => {
    const source = "f(x)=a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z+0+1+2+3+4+5+6+7+8+9";
    const formatted = formatLatex(source);
    assert.ok(formatted.startsWith("f(x)="), "starts with the left side");
    assert.ok(formatted.includes("\n"), "broken into lines");
    assert.ok(formatted.split("\n").every(line => !line.startsWith("  ")), "top-level lines are not indented");
});

test("formatLatex compresses repeated spacing commands only", () => {
    assert.equal(formatLatex("a\\, \\, \\, b"), "a\\, b");
    assert.equal(formatLatex("a\\,b"), "a\\,b", "single spacing command is kept");
    assert.equal(formatLatex("a\\quad\\qquad b"), "a\\quad b");
});

test("formatLatex preserves text blocks verbatim", () => {
    const source = "\\text{if  x > 0} + y";
    const formatted = formatLatex(source);
    assert.ok(formatted.includes("\\text{if  x > 0}"), "double spaces inside \\text survive");
    assert.ok(!formatted.includes("\\text{if\n"), "no line break inside \\text");
});

test("formatLatex is idempotent", () => {
    const source = "\\begin{cases} x & \\text{if  x>0} \\\\ \\frac{a}{b} & \\text{otherwise} \\end{cases}";
    const once = formatLatex(source);
    assert.equal(formatLatex(once), once, "formatting twice is stable");
});

test("formatLatex returns the input unchanged when it cannot be parsed safely", () => {
    const broken = "\\frac{a}{b";
    assert.equal(formatLatex(broken), broken);
    assert.equal(formatLatex("\\begin{aligned} a \\end{cases}"), "\\begin{aligned} a \\end{cases}");
});

test("extractLatexFromKramdown reads math blocks", () => {
    assert.equal(extractLatexFromKramdown("$$\na = b\n$$"), "a = b");
    assert.equal(extractLatexFromKramdown("$$\na = b\n$$\n{: id=\"2021\" updated=\"2021\"}"), "a = b");
    assert.equal(extractLatexFromKramdown("not math"), "");
});
