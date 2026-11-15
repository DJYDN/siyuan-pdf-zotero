import test from "node:test";
import assert from "node:assert/strict";
import {latexToTypst} from "../../.test-build/ocr-convert.mjs";

/** 断言结果包含所有关键结构（不硬绑 Typst 的空白风格）。 */
function assertContains(actual, ...fragments) {
    for (const fragment of fragments) {
        assert.ok(
            actual.includes(fragment),
            `期望输出包含 ${JSON.stringify(fragment)}，实际为 ${JSON.stringify(actual)}`,
        );
    }
}

test("上下标：x^2 / x^{2} / x_i^2 与嵌套", () => {
    assert.equal(latexToTypst("x^2").typst, "x^2");
    assert.equal(latexToTypst("x^{2}").typst, "x^2");
    assert.equal(latexToTypst("x_i^2").typst, "x_i^2");
    assert.equal(latexToTypst("x^{a^2}").typst, "x^(a^2)");
    assert.equal(latexToTypst("x_{i_{j}}").typst, "x_(i_j)");
});

test("上下标：带逗号的多元下标会补括号", () => {
    assert.equal(latexToTypst("a_{i,j}").typst, "a_(i, j)");
});

test("分式：\\frac / \\dfrac / \\tfrac 与嵌套", () => {
    assert.equal(latexToTypst("\\frac { a } { b }").typst, "frac(a, b)");
    assert.equal(latexToTypst("\\dfrac{1}{2}").typst, "frac(1, 2)");
    assert.equal(latexToTypst("\\tfrac{1}{2}").typst, "frac(1, 2)");
    assert.equal(latexToTypst("\\frac{x^{2}}{\\sqrt{y}}").typst, "frac(x^2, sqrt(y))");
});

test("根号：\\sqrt 与可选次数转为 root", () => {
    assert.equal(latexToTypst("\\sqrt{x}").typst, "sqrt(x)");
    assert.equal(latexToTypst("\\sqrt[3]{x}").typst, "root(3, x)");
    assert.equal(latexToTypst("\\sqrt { a ^ { 2 } + b ^ { 2 } }").typst, "sqrt(a^2 + b^2)");
});

test("希腊字母：小写、大写与变体", () => {
    const result = latexToTypst("\\alpha + \\beta = \\Omega \\Delta");
    assertContains(result.typst, "alpha", "beta", "Omega", "Delta");
    assert.equal(result.unsupported.length, 0);
    // \varepsilon / \epsilon 等变体无法一一对应 Typst 名称时退化为 Unicode 字形
    assertContains(latexToTypst("\\varepsilon \\epsilon \\varphi \\phi").typst, "ε", "ϵ", "φ", "ϕ");
});

test("常用关系符与集合符号", () => {
    const result = latexToTypst("\\le \\leq \\ge \\geq \\ne \\neq \\approx \\equiv \\in \\notin \\subset");
    assertContains(result.typst, "<=", ">=", "!=", "approx", "equiv", "in", "∉", "subset");
    assert.equal(result.unsupported.length, 0);
});

test("箭头符号", () => {
    const result = latexToTypst("\\to \\rightarrow \\Rightarrow \\leftrightarrow");
    assertContains(result.typst, "->", "=>", "<->");
    assert.equal(result.unsupported.length, 0);
});

test("常用运算符与微积分符号", () => {
    const result = latexToTypst("\\pm \\mp \\times \\cdot \\div \\infty \\partial \\nabla");
    assertContains(result.typst, "±", "∓", "times", "⋅", "÷", "infinity", "partial", "nabla");
    assert.equal(result.unsupported.length, 0);
});

test("大型运算符上下限：sum / int / prod", () => {
    assert.equal(latexToTypst("\\sum_{i=1}^{n} x_i").typst, "sum_(i = 1)^n x_i");
    assert.equal(latexToTypst("\\int_{0}^{1}").typst, "integral_0^1");
    assert.equal(latexToTypst("\\prod_{k=1}^{n} k").typst, "product_(k = 1)^n k");
    assertContains(latexToTypst("\\iint \\oint").typst, "integral.double", "integral.cont");
});

test("省略号与点", () => {
    const result = latexToTypst("\\cdots \\ldots \\dots \\vdots \\ddots");
    assertContains(result.typst, "dots.h", "dots", "dots.v", "dots.down");
});

test("括号：\\left( \\right) / 方括号 / 花括号 / 绝对值", () => {
    assert.equal(latexToTypst("\\left( x \\right)").typst, "(x)");
    assert.equal(latexToTypst("\\left[ x \\right]").typst, "[x]");
    assert.equal(latexToTypst("\\left| x \\right|").typst, "abs(x)");
    assert.equal(latexToTypst("\\left\\{ x \\right\\}").typst, "\\{x\\}");
    assert.equal(latexToTypst("\\left( \\frac{a}{b} \\right)").typst, "(frac(a, b))");
});

test("嵌套 \\left / \\right 正确配对", () => {
    const result = latexToTypst("\\left( \\left[ x \\right] + 1 \\right)");
    assert.equal(result.typst, "([x] + 1)");
    assert.equal(result.unsupported.length, 0);
});

test("字体命令：mathrm/mathbf/mathit/mathcal/mathbb/mathsf/mathtt", () => {
    assert.equal(latexToTypst("\\mathrm{d}").typst, 'upright("d")');
    assert.equal(latexToTypst("\\mathbf{A}").typst, 'bold("A")');
    assert.equal(latexToTypst("\\mathit{x}").typst, 'italic("x")');
    assert.equal(latexToTypst("\\mathcal{L}").typst, 'cal("L")');
    assert.equal(latexToTypst("\\mathbb{R}").typst, 'bb("R")');
    assert.equal(latexToTypst("\\mathsf{T}").typst, 'sans("T")');
    assert.equal(latexToTypst("\\mathtt{cmd}").typst, 'mono("cmd")');
});

test("字体命令含表达式时按数学内容递归转换", () => {
    const result = latexToTypst("\\mathbf{x + y}");
    assertContains(result.typst, "bold(", "x + y");
    assert.equal(result.typst.startsWith("bold("), true);
});

test("文本命令与 operatorname", () => {
    assert.equal(latexToTypst("\\text{ if }").typst, '"if"');
    assert.equal(latexToTypst("\\text{if } x > 0").typst, '"if" x > 0');
    assert.equal(latexToTypst("\\operatorname{argmax}").typst, 'op("argmax")');
    assert.equal(latexToTypst("\\operatorname*{argmin}").typst, 'op("argmin")');
});

test("重音 / 装饰命令", () => {
    assert.equal(latexToTypst("\\hat{x}").typst, "hat(x)");
    assert.equal(latexToTypst("\\tilde{x}").typst, "tilde(x)");
    assert.equal(latexToTypst("\\bar{x}").typst, "macron(x)");
    assert.equal(latexToTypst("\\overline{AB}").typst, "overline(A B)");
    assert.equal(latexToTypst("\\vec{v}").typst, "arrow(v)");
    assert.equal(latexToTypst("\\dot{x}").typst, "dot(x)");
    assert.equal(latexToTypst("\\ddot{x}").typst, "dot.double(x)");
    assert.equal(latexToTypst("\\check{x}").typst, "caron(x)");
    assert.equal(latexToTypst("\\underline{x}").typst, "underline(x)");
    assert.equal(latexToTypst("\\underbrace{x}_{n}").typst, "underbrace(x)_n");
});

test("矩阵：pmatrix 映射为 mat(delim: \"(\")", () => {
    const result = latexToTypst("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}");
    assert.equal(result.typst, 'mat(delim: "(", a, b; c, d)');
    assert.equal(result.unsupported.length, 0);
});

test("矩阵：matrix / bmatrix / vmatrix", () => {
    assert.equal(latexToTypst("\\begin{matrix} 1 & 0 \\\\ 0 & 1 \\end{matrix}").typst, "mat(delim: none, 1, 0; 0, 1)");
    assert.equal(latexToTypst("\\begin{bmatrix} 1 \\\\ 2 \\end{bmatrix}").typst, 'mat(delim: "[", 1; 2)');
    assert.equal(latexToTypst("\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}").typst, 'mat(delim: "|", a, b; c, d)');
});

test("矩阵：行距可选参数与单元格内分式", () => {
    const result = latexToTypst("\\begin{bmatrix} \\frac{1}{2} & 0 \\\\[2pt] 0 & \\sqrt{2} \\end{bmatrix}");
    assertContains(result.typst, 'mat(delim: "[",', "frac(1, 2)", "sqrt(2)");
    assert.equal(result.unsupported.length, 0);
});

test("cases 环境映射为 Typst cases", () => {
    const result = latexToTypst("\\begin{cases} x & x > 0 \\\\ -x & x \\le 0 \\end{cases}");
    assertContains(result.typst, "cases(", "&", "x > 0", "<= 0");
    assert.equal(result.unsupported.length, 0);
});

test("aligned 环境降级为 mat 并标注精度损失", () => {
    const result = latexToTypst("\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}");
    assertContains(result.typst, "mat(delim: none", "a = b", "c = d");
    assert.deepEqual(result.unsupported, ["\\begin{aligned}"]);
});

test("array 环境降级为 mat 并标注精度损失", () => {
    const result = latexToTypst("\\begin{array}{cc} 1 & 2 \\\\ 3 & 4 \\end{array}");
    assertContains(result.typst, "mat(delim: none", "1, 2", "3, 4");
    assert.deepEqual(result.unsupported, ["\\begin{array}"]);
});

test("空白命令：\\, \\; \\quad \\qquad", () => {
    const result = latexToTypst("a \\, b \\; c \\quad d \\qquad e");
    assertContains(result.typst, "thin", "thick", "#h(1em)", "#h(2em)");
    assert.equal(result.unsupported.length, 0);
});

test("真实 Texo 片段：二次方程求根公式", () => {
    const latex = "\\frac { -b \\pm \\sqrt { b ^ { 2 } - 4 a c } } { 2 a }";
    const result = latexToTypst(latex);
    assertContains(result.typst, "frac(", "sqrt(", "±", "b^2", "4 a c", "2 a");
    assert.equal(result.unsupported.length, 0);
});

test("真实 Texo 片段：求和公式整体转换", () => {
    const latex = "\\sum _ { i = 1 } ^ { n } \\frac { 1 } { i ^ { 2 } } = \\frac { \\pi ^ { 2 } } { 6 }";
    const result = latexToTypst(latex);
    assertContains(result.typst, "sum_(i = 1)^n", "frac(1, i^2)", "frac(pi^2, 6)");
    assert.equal(result.unsupported.length, 0);
});

test("真实 Texo 片段：偏导方括号", () => {
    const latex = "\\left[ \\frac { \\partial f } { \\partial x } \\right]";
    const result = latexToTypst(latex);
    assertContains(result.typst, "[", "]", "frac(", "partial", "f", "x");
    assert.equal(result.typst.startsWith("["), true);
    assert.equal(result.typst.endsWith("]"), true);
    assert.equal(result.unsupported.length, 0);
});

test("真实 Texo 片段：集合与箭头", () => {
    const latex = "f : \\mathbb { R } ^ { n } \\to \\mathbb { R } ^ { m }";
    const result = latexToTypst(latex);
    assertContains(result.typst, 'bb("R")^n', "->", 'bb("R")^m');
    assert.equal(result.unsupported.length, 0);
});

test("未知命令进入 unsupported 且不抛异常", () => {
    const result = latexToTypst("\\substack{a \\\\ b}");
    assert.ok(Array.isArray(result.unsupported));
    assert.deepEqual(result.unsupported, ["\\substack"]);
    assert.ok(typeof result.typst === "string");
    assert.ok(result.typst.length > 0);
});

test("unsupported 按出现顺序去重", () => {
    const result = latexToTypst("\\foo{x} + \\baz{y} + \\foo{z}");
    assert.deepEqual(result.unsupported, ["\\foo", "\\baz"]);
});

test("未知命令仍尽量输出可预览的内容", () => {
    const result = latexToTypst("\\unknowncmd{x+1}");
    assertContains(result.typst, 'op("unknowncmd")', "x + 1");
    assert.deepEqual(result.unsupported, ["\\unknowncmd"]);
});

test("空输入与纯空白返回空结果", () => {
    assert.deepEqual(latexToTypst(""), {typst: "", unsupported: []});
    assert.deepEqual(latexToTypst("   \n\t "), {typst: "", unsupported: []});
});

test("多余的 $ 包裹与冗余花括号会被清理", () => {
    assert.equal(latexToTypst("$x^2$").typst, "x^2");
    assert.equal(latexToTypst("{a + b}").typst, "a + b");
    assert.equal(latexToTypst("{{x}}").typst, "x");
});

test("残缺 / 异常输入绝不抛异常", () => {
    const inputs = [
        "\\",
        "}{",
        "\\frac{",
        "\\left(",
        "\\begin{matrix} a & b",
        "\\begin{cases}",
        "\\sqrt[3",
        "\\text{unterminated",
        "%%%",
        "\\\\\\",
        "\\left. x \\right)",
    ];
    for (const input of inputs) {
        assert.doesNotThrow(() => latexToTypst(input), `输入 ${JSON.stringify(input)} 不应抛异常`);
    }
});

test("接口契约：返回 {typst, unsupported} 且为纯函数", () => {
    const first = latexToTypst("\\alpha^2");
    const second = latexToTypst("\\alpha^2");
    assert.equal(typeof first.typst, "string");
    assert.ok(Array.isArray(first.unsupported));
    assert.deepEqual(first, second);
    assert.equal(first.typst, "alpha^2");
});
