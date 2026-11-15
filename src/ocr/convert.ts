/**
 * LaTeX → Typst 数学公式转换。
 *
 * 设计约束：
 * - 纯函数、零第三方依赖，不 import 其它 src 模块；
 * - 面向 Texo 等 OCR 模型的输出（大量空格、`{ }` 分组、常见 amsmath 命令）；
 * - 无法映射的命令会按出现顺序去重记录到 `unsupported`，同时尽量输出可用的
 *   Typst 代码，任何输入都不抛异常（最坏情况退化为纯文本）；
 * - 输出是公式体，不含 `$` 包裹，调用方自行拼接 `$ ... $`。
 */

export interface LatexToTypstResult {
    typst: string;
    unsupported: string[];
}

/** 解析过程中的一个节点。atomic 为 true 表示它是一颗“原子”，可安全地作为上下标或函数实参。 */
interface Piece {
    typst: string;
    atomic: boolean;
}

const GREEK: Record<string, string> = {
    alpha: "alpha",
    beta: "beta",
    gamma: "gamma",
    delta: "delta",
    epsilon: "ϵ",
    varepsilon: "ε",
    zeta: "zeta",
    eta: "eta",
    theta: "theta",
    vartheta: "ϑ",
    iota: "iota",
    kappa: "kappa",
    lambda: "lambda",
    mu: "mu",
    nu: "nu",
    xi: "xi",
    omicron: "omicron",
    pi: "pi",
    varpi: "ϖ",
    rho: "rho",
    varrho: "ϱ",
    sigma: "sigma",
    varsigma: "ς",
    tau: "tau",
    upsilon: "upsilon",
    phi: "ϕ",
    varphi: "φ",
    chi: "chi",
    psi: "psi",
    omega: "omega",
    Gamma: "Gamma",
    Delta: "Delta",
    Theta: "Theta",
    Lambda: "Lambda",
    Xi: "Xi",
    Pi: "Pi",
    Sigma: "Sigma",
    Upsilon: "Upsilon",
    Phi: "Phi",
    Psi: "Psi",
    Omega: "Omega",
};

const SYMBOLS: Record<string, string> = {
    // 关系符
    le: "<=",
    leq: "<=",
    ge: ">=",
    geq: ">=",
    ne: "!=",
    neq: "!=",
    approx: "approx",
    equiv: "equiv",
    sim: "∼",
    simeq: "≃",
    cong: "≅",
    propto: "∝",
    ll: "≪",
    gg: "≫",
    in: "in",
    notin: "∉",
    ni: "∋",
    subset: "subset",
    subseteq: "subset.eq",
    supset: "supset",
    supseteq: "supset.eq",
    cup: "∪",
    cap: "∩",
    setminus: "∖",
    // 箭头
    to: "->",
    rightarrow: "->",
    leftarrow: "<-",
    gets: "<-",
    Rightarrow: "=>",
    Leftarrow: "⟸",
    leftrightarrow: "<->",
    Leftrightarrow: "⟺",
    implies: "=>",
    iff: "⟺",
    mapsto: "|->",
    uparrow: "↑",
    downarrow: "↓",
    // 运算
    pm: "±",
    mp: "∓",
    times: "times",
    cdot: "⋅",
    div: "÷",
    ast: "ast",
    star: "star",
    circ: "∘",
    bullet: "bullet",
    oplus: "⊕",
    otimes: "⊗",
    bigcup: "⋃",
    bigcap: "⋂",
    // 大型运算符
    sum: "sum",
    prod: "product",
    coprod: "∐",
    int: "integral",
    iint: "integral.double",
    iiint: "integral.triple",
    oint: "integral.cont",
    // 常用符号
    infty: "infinity",
    partial: "partial",
    nabla: "nabla",
    forall: "forall",
    exists: "exists",
    nexists: "∄",
    emptyset: "emptyset",
    varnothing: "∅",
    cdots: "dots.h",
    ldots: "dots",
    dots: "dots",
    vdots: "dots.v",
    ddots: "dots.down",
    prime: "′",
    degree: "degree",
    ell: "ell",
    hbar: "ℏ",
    hslash: "ℏ",
    top: "⊤",
    bot: "⊥",
    perp: "⊥",
    parallel: "parallel",
    angle: "angle",
    triangle: "△",
    square: "□",
    therefore: "∴",
    because: "∵",
    Re: "ℜ",
    Im: "ℑ",
    aleph: "aleph",
    wp: "℘",
    vert: "|",
    Vert: "‖",
    lvert: "|",
    rvert: "|",
    lVert: "‖",
    rVert: "‖",
    langle: "⟨",
    rangle: "⟩",
    lfloor: "⌊",
    rfloor: "⌋",
    lceil: "⌈",
    rceil: "⌉",
    lbrace: "\\{",
    rbrace: "\\}",
    backslash: "∖",
};

/** Typst 里以原名直接可用的算子（sin、lim 等是内置数学算子）。 */
const BARE_OPERATORS = new Set([
    "sin", "cos", "tan", "cot", "sec", "csc",
    "sinh", "cosh", "tanh", "coth",
    "log", "ln", "exp", "lim", "max", "min", "sup", "inf", "det", "gcd",
]);

/** 其余算子统一降级为 `op("...")` 文本算子。 */
const OP_OPERATORS = new Set([
    "arcsin", "arccos", "arctan", "arccot",
    "liminf", "limsup", "arg", "argmax", "argmin", "dim", "ker", "deg", "hom", "mod", "bmod", "Pr",
]);

/** 重音 / 装饰命令 → Typst 数学重音函数。 */
const ACCENTS: Record<string, string> = {
    hat: "hat",
    widehat: "hat",
    tilde: "tilde",
    widetilde: "tilde",
    bar: "macron",
    overline: "overline",
    vec: "arrow",
    overrightarrow: "arrow",
    overleftarrow: "arrow.l",
    dot: "dot",
    ddot: "dot.double",
    dddot: "dot.triple",
    check: "caron",
    breve: "breve",
    acute: "acute",
    grave: "grave",
    underline: "underline",
    underbrace: "underbrace",
    overbrace: "overbrace",
    mathring: "circle",
};

/** 数学字体命令 → Typst 数学 style / variant 函数。 */
const VARIANTS: Record<string, string> = {
    mathrm: "upright",
    mathbf: "bold",
    mathit: "italic",
    mathcal: "cal",
    mathbb: "bb",
    mathsf: "sans",
    mathtt: "mono",
    mathfrak: "frak",
    boldsymbol: "bold",
    bm: "bold",
};

/** 文本命令 → 包裹方式；"text" 表示直接输出 Typst 字符串。 */
const TEXT_COMMANDS: Record<string, string> = {
    text: "text",
    textrm: "text",
    textnormal: "text",
    textup: "text",
    textsc: "text",
    mbox: "text",
    textbf: "bold",
    textit: "italic",
    texttt: "mono",
    textsf: "sans",
};

const SPACE_COMMANDS: Record<string, string> = {
    quad: "#h(1em)",
    qquad: "#h(2em)",
    enspace: "#h(0.5em)",
    thinspace: "thin",
    medspace: "med",
    thickspace: "thick",
    negthinspace: "",
};

/** Typst 数学模式里的花括号本身是分组符，要输出字面量得转义。 */
const DELIMITERS: Record<string, string> = {
    lbrace: "\\{",
    rbrace: "\\}",
    langle: "⟨",
    rangle: "⟩",
    lfloor: "⌊",
    rfloor: "⌋",
    lceil: "⌈",
    rceil: "⌉",
    vert: "|",
    Vert: "‖",
    lvert: "|",
    rvert: "|",
    lVert: "‖",
    rVert: "‖",
    uparrow: "↑",
    downarrow: "↓",
    backslash: "∖",
};

/** 矩阵类环境 → mat 的 delim 参数。 */
const MATRIX_DELIMS: Record<string, string> = {
    matrix: "none",
    smallmatrix: "none",
    pmatrix: "(",
    bmatrix: "[",
    Bmatrix: "{",
    vmatrix: "|",
    Vmatrix: "||",
};

/** 对齐类环境：Typst 没有直接对应物，降级为无括号矩阵并标注精度损失。 */
const ALIGN_ENVS = new Set([
    "aligned", "align", "alignat", "alignedat", "gather", "gathered",
    "split", "eqnarray", "multline", "flalign",
]);

/** 公式外壳环境：直接输出内部内容。 */
const PASSTHROUGH_ENVS = new Set(["equation", "displaymath", "math"]);

/** 只影响排版、可安全忽略的命令。 */
const IGNORED_COMMANDS = new Set([
    "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle",
    "limits", "nolimits", "nonumber", "notag", "allowbreak", "hfill",
    "mathstrut", "strut", "noindent", "centering", "relax",
    "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr",
    "biggl", "biggr", "Biggl", "Biggr",
    "hline", "toprule", "midrule", "bottomrule",
]);

/** 忽略命令本身，但吃掉一个 `{...}` 参数（颜色、间距、标签等）。 */
const IGNORED_ARG_COMMANDS = new Set([
    "label", "tag", "ref", "eqref", "cite", "hspace", "vspace",
    "phantom", "hphantom", "vphantom", "color", "cline", "cmidrule",
]);

const NOT_MAP: Record<string, string> = {
    in: "∉",
    "=": "!=",
    subset: "⊄",
    equiv: "≢",
    le: "≰",
    ge: "≱",
};

function isLetterChar(ch: string): boolean {
    return ch.length === 1 && /[A-Za-z]/.test(ch);
}

function hasOwn(map: Record<string, string>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(map, key);
}

function escapeTypstString(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 拼接节点：标点前后不加多余空格，其余用空格分隔（Typst 数学模式空白本身无意义）。 */
function joinPieces(pieces: Piece[]): string {
    let out = "";
    for (const piece of pieces) {
        const text = piece.typst;
        if (!text) continue;
        if (!out) {
            out = text;
            continue;
        }
        const prev = out[out.length - 1];
        const next = text[0];
        const noSpaceBefore = next === "," || next === ";" || next === ")" || next === "]" || next === ".";
        const noSpaceAfter = prev === "(" || prev === "[";
        out += (noSpaceBefore || noSpaceAfter ? "" : " ") + text;
    }
    return out;
}

/** 根号、分式、重音等函数的实参：若含顶层逗号需要加括号，否则逗号会被当成多参数。 */
function hasTopLevelComma(text: string): boolean {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") {
                i += 1;
                continue;
            }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") depth += 1;
        else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
        else if (ch === "," && depth === 0) return true;
    }
    return false;
}

/** 判断文本里是否还有顶层（括号外）的上下标标记，用于避免 `x^a^2` 这类歧义写法。 */
function hasTopLevelScript(text: string): boolean {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") {
                i += 1;
                continue;
            }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") depth += 1;
        else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
        else if ((ch === "^" || ch === "_") && depth === 0) return true;
    }
    return false;
}

/** 去掉表格横线命令，避免它们混入矩阵单元格。 */
function stripTableRules(body: string): string {
    return body
        .replace(/\\(?:hline|toprule|midrule|bottomrule)\b/g, " ")
        .replace(/\\(?:cline|cmidrule)\s*\{[^}]*\}/g, " ");
}

/**
 * 把环境体按 `\\`（行）与 `&`（列）切分成二维数组。
 * 花括号分组与 `\left ... \right` 内部的 `&` 不作为分隔符。
 */
function splitEnvironmentRows(body: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let braceDepth = 0;
    let leftDepth = 0;

    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === "\\") {
            const next = body[i + 1];
            if (next === "\\") {
                row.push(cell);
                rows.push(row);
                row = [];
                cell = "";
                i += 1;
                // 跳过行距可选参数，例如 `\\[2pt]`
                let cursor = i + 1;
                while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1;
                if (body[cursor] === "[") {
                    let close = cursor + 1;
                    while (close < body.length && body[close] !== "]") close += 1;
                    i = close;
                }
                continue;
            }
            let end = i + 1;
            if (isLetterChar(body[end] ?? "")) {
                while (end < body.length && isLetterChar(body[end])) end += 1;
            } else {
                end += 1;
            }
            const name = body.slice(i + 1, end);
            if (name === "left") leftDepth += 1;
            else if (name === "right") leftDepth = Math.max(0, leftDepth - 1);
            cell += body.slice(i, end);
            i = end - 1;
            continue;
        }
        if (ch === "{") braceDepth += 1;
        else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
        if (ch === "&" && braceDepth === 0 && leftDepth === 0) {
            row.push(cell);
            cell = "";
            continue;
        }
        cell += ch;
    }
    row.push(cell);
    rows.push(row);
    return rows.filter(entry => entry.some(value => value.trim() !== ""));
}

class LatexConverter {
    private pos = 0;

    constructor(
        private readonly src: string,
        private readonly unsupported: string[] = [],
    ) {}

    run(): LatexToTypstResult {
        const pieces = this.parseSequence(false);
        return {typst: joinPieces(pieces).trim(), unsupported: this.unsupported};
    }

    private note(token: string): void {
        if (!this.unsupported.includes(token)) this.unsupported.push(token);
    }

    private noteCommand(name: string): void {
        this.note("\\" + name);
    }

    private skipSpaces(): void {
        while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos += 1;
    }

    private convertRaw(raw: string): string {
        return new LatexConverter(raw, this.unsupported).run().typst;
    }

    // ---------------------------------------------------------------- 序列

    private parseSequence(inGroup: boolean): Piece[] {
        const pieces: Piece[] = [];
        while (this.pos < this.src.length) {
            this.skipSpaces();
            if (this.pos >= this.src.length) break;
            const ch = this.src[this.pos];
            if (ch === "}") {
                if (inGroup) break;
                this.pos += 1;
                continue;
            }
            if (ch === "^" || ch === "_") {
                // 没有底数的上下标：丢弃标记，只保留内容
                this.pos += 1;
                const stray = this.parseScriptArgument();
                if (stray && stray.typst) pieces.push(stray);
                continue;
            }
            const atom = this.parseAtom();
            if (!atom) continue;
            pieces.push(this.attachScripts(atom));
        }
        return pieces;
    }

    /** 把紧随其后的 `^` / `_` 附加到底数上。 */
    private attachScripts(base: Piece): Piece {
        let text = base.typst;
        let changed = false;
        while (true) {
            this.skipSpaces();
            const marker = this.src[this.pos];
            if (marker !== "^" && marker !== "_") break;
            if (!text) {
                this.pos += 1;
                this.parseScriptArgument();
                continue;
            }
            if (!changed && !base.atomic) text = `(${text})`;
            this.pos += 1;
            const arg = this.parseScriptArgument();
            changed = true;
            if (!arg || !arg.typst) continue;
            const needsParens = !arg.atomic || hasTopLevelScript(arg.typst);
            text += marker + (needsParens ? `(${arg.typst})` : arg.typst);
        }
        return changed ? {typst: text, atomic: true} : base;
    }

    private parseScriptArgument(): Piece | null {
        this.skipSpaces();
        if (this.pos >= this.src.length) return null;
        if (this.src[this.pos] === "{") {
            this.pos += 1;
            const pieces = this.parseSequence(true);
            if (this.src[this.pos] === "}") this.pos += 1;
            return {typst: joinPieces(pieces), atomic: pieces.length === 1 && pieces[0].atomic};
        }
        return this.parseAtom();
    }

    // ---------------------------------------------------------------- 原子

    private parseAtom(): Piece | null {
        this.skipSpaces();
        if (this.pos >= this.src.length) return null;
        const ch = this.src[this.pos];
        if (ch === "{") {
            this.pos += 1;
            const pieces = this.parseSequence(true);
            if (this.src[this.pos] === "}") this.pos += 1;
            return {typst: joinPieces(pieces), atomic: pieces.length === 1 && pieces[0].atomic};
        }
        if (ch === "}") {
            this.pos += 1;
            return null;
        }
        if (ch === "\\") return this.parseCommand();
        if (ch === "$" || ch === "&") {
            this.pos += 1;
            return null;
        }
        if (ch === "~") {
            this.pos += 1;
            return {typst: "thin", atomic: true};
        }
        if (ch === "#") {
            this.pos += 1;
            return {typst: "\\#", atomic: true};
        }
        if (/[0-9]/.test(ch)) {
            const start = this.pos;
            while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) this.pos += 1;
            return {typst: this.src.slice(start, this.pos), atomic: true};
        }
        this.pos += 1;
        return {typst: ch, atomic: true};
    }

    // ---------------------------------------------------------------- 命令

    private parseCommand(): Piece | null {
        this.pos += 1;
        if (this.pos >= this.src.length) return null;
        const ch = this.src[this.pos];
        if (isLetterChar(ch)) {
            const start = this.pos;
            while (this.pos < this.src.length && isLetterChar(this.src[this.pos])) this.pos += 1;
            const name = this.src.slice(start, this.pos);
            if (this.src[this.pos] === "*") this.pos += 1;
            return this.parseNamedCommand(name);
        }
        this.pos += 1;
        return this.parseSingleCharCommand(ch);
    }

    private parseSingleCharCommand(ch: string): Piece | null {
        switch (ch) {
            case "{":
                return {typst: "\\{", atomic: true};
            case "}":
                return {typst: "\\}", atomic: true};
            case "%":
                return {typst: "%", atomic: true};
            case "&":
                return {typst: "&", atomic: true};
            case "#":
                return {typst: "\\#", atomic: true};
            case "_":
                return {typst: "\\_", atomic: true};
            case "$":
                return {typst: "\\$", atomic: true};
            case "|":
                return {typst: "‖", atomic: true};
            case " ":
            case ",":
                return {typst: "thin", atomic: true};
            case ":":
            case ">":
                return {typst: "med", atomic: true};
            case ";":
                return {typst: "thick", atomic: true};
            case "!":
                return null;
            case "\\":
                return {typst: "#linebreak()", atomic: true};
            case "/":
                return {typst: "/", atomic: true};
            default:
                return {typst: ch, atomic: true};
        }
    }

    private parseNamedCommand(name: string): Piece | null {
        if (name === "left") return this.parseLeftRight();
        if (name === "right") {
            this.readDelimiter();
            return null;
        }
        if (name === "middle") {
            const delim = this.readDelimiter();
            return {typst: `mid(${delim || "|"})`, atomic: true};
        }
        if (name === "begin") return this.parseEnvironment();
        if (name === "end") {
            this.readRawGroup();
            return null;
        }
        if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
            return this.renderCall("frac", [this.parseAtom(), this.parseAtom()]);
        }
        if (name === "sqrt") return this.parseSqrt();
        if (name === "binom" || name === "dbinom" || name === "tbinom") {
            return this.renderCall("binom", [this.parseAtom(), this.parseAtom()]);
        }
        if (name === "substack") return this.parseSubstack();
        if (name === "boxed" || name === "fbox") return this.parseAtom();
        if (name === "operatorname") {
            const raw = this.readRawGroup();
            return {typst: `op("${escapeTypstString((raw ?? "").trim())}")`, atomic: true};
        }
        if (name === "textcolor") {
            this.readRawGroup();
            return this.parseAtom();
        }
        if (name === "not") return this.parseNot();
        if (hasOwn(ACCENTS, name)) {
            return this.renderCall(ACCENTS[name], [this.parseAtom()]);
        }
        if (hasOwn(VARIANTS, name)) return this.parseFontVariant(VARIANTS[name]);
        if (hasOwn(TEXT_COMMANDS, name)) return this.parseTextCommand(TEXT_COMMANDS[name]);
        if (hasOwn(SPACE_COMMANDS, name)) {
            const text = SPACE_COMMANDS[name];
            return text ? {typst: text, atomic: true} : null;
        }
        if (hasOwn(GREEK, name)) return {typst: GREEK[name], atomic: true};
        if (hasOwn(SYMBOLS, name)) return {typst: SYMBOLS[name], atomic: true};
        if (BARE_OPERATORS.has(name)) return {typst: name, atomic: true};
        if (OP_OPERATORS.has(name)) return {typst: `op("${name}")`, atomic: true};
        if (IGNORED_COMMANDS.has(name)) return null;
        if (IGNORED_ARG_COMMANDS.has(name)) {
            this.readRawGroup();
            return null;
        }
        // 未知命令：记录并降级成文本算子，保证输出仍是合法 Typst 的可能性最大
        this.noteCommand(name);
        return {typst: `op("${name}")`, atomic: true};
    }

    // ---------------------------------------------------------------- 具体命令

    private renderCall(fn: string, args: (Piece | null)[]): Piece {
        const parts = args.map(arg => this.argumentText(arg));
        return {typst: `${fn}(${parts.join(", ")})`, atomic: true};
    }

    private argumentText(arg: Piece | null): string {
        if (!arg || !arg.typst) return '""';
        if (hasTopLevelComma(arg.typst)) return `(${arg.typst})`;
        return arg.typst;
    }

    private parseSqrt(): Piece {
        this.skipSpaces();
        let index: Piece | null = null;
        if (this.src[this.pos] === "[") {
            const raw = this.readBracketRaw() ?? "";
            if (raw.trim()) index = {typst: this.convertRaw(raw), atomic: true};
        }
        const body = this.parseAtom();
        if (!index) return this.renderCall("sqrt", [body]);
        return this.renderCall("root", [index, body]);
    }

    private parseNot(): Piece | null {
        const atom = this.parseAtom();
        const mapped = atom ? NOT_MAP[atom.typst] : undefined;
        if (mapped) return {typst: mapped, atomic: true};
        this.noteCommand("not");
        return atom;
    }

    private parseSubstack(): Piece {
        this.noteCommand("substack");
        const raw = this.readRawGroup();
        if (raw === null) return {typst: "", atomic: true};
        const rows = splitEnvironmentRows(raw);
        const cells = rows
            .map(row => row.map(cell => this.convertRaw(cell).trim()).join(", "))
            .filter(text => text !== "");
        if (cells.length === 0) return {typst: "", atomic: true};
        return {typst: `mat(delim: none, ${cells.join("; ")})`, atomic: true};
    }

    private parseFontVariant(variant: string): Piece {
        const raw = this.readRawGroup();
        if (raw !== null) {
            const trimmed = raw.trim();
            if (!trimmed) return {typst: "", atomic: true};
            if (/^[A-Za-z0-9\s]+$/.test(trimmed)) {
                return {typst: `${variant}("${escapeTypstString(trimmed)}")`, atomic: true};
            }
            return {typst: `${variant}(${this.convertRaw(raw)})`, atomic: true};
        }
        const arg = this.parseAtom();
        if (!arg || !arg.typst) return {typst: "", atomic: true};
        return {typst: `${variant}(${arg.atomic ? arg.typst : `(${arg.typst})`})`, atomic: true};
    }

    private parseTextCommand(mode: string): Piece {
        const raw = this.readRawGroup();
        if (raw === null) {
            const arg = this.parseAtom();
            if (!arg || !arg.typst) return {typst: "", atomic: true};
            return {typst: mode === "text" ? `"${escapeTypstString(arg.typst)}"` : `${mode}("${escapeTypstString(arg.typst)}")`, atomic: true};
        }
        const text = raw.replace(/\$([^$]*)\$/g, "$1").trim();
        if (!text) return {typst: "", atomic: true};
        if (mode === "text") return {typst: `"${escapeTypstString(text)}"`, atomic: true};
        return {typst: `${mode}("${escapeTypstString(text)}")`, atomic: true};
    }

    private parseLeftRight(): Piece {
        const open = this.readDelimiter();
        const start = this.pos;
        let depth = 0;
        let rightAt = -1;
        let scan = start;
        while (scan < this.src.length) {
            if (this.src[scan] !== "\\") {
                scan += 1;
                continue;
            }
            let end = scan + 1;
            if (isLetterChar(this.src[end] ?? "")) {
                while (end < this.src.length && isLetterChar(this.src[end])) end += 1;
            } else {
                end += 1;
            }
            const name = this.src.slice(scan + 1, end);
            if (name === "left") depth += 1;
            else if (name === "right") {
                if (depth === 0) {
                    rightAt = scan;
                    break;
                }
                depth -= 1;
            }
            scan = end;
        }

        let innerRaw: string;
        let close = "";
        if (rightAt < 0) {
            innerRaw = this.src.slice(start);
            this.pos = this.src.length;
        } else {
            innerRaw = this.src.slice(start, rightAt);
            this.pos = rightAt + "\\right".length;
            close = this.readDelimiter();
        }

        const inner = this.convertRaw(innerRaw);
        if (!inner) return {typst: `${open}${close}`, atomic: true};
        if (open === "|" && close === "|") return {typst: `abs(${inner})`, atomic: true};
        if (open === "‖" && close === "‖") return {typst: `norm(${inner})`, atomic: true};
        return {typst: `${open}${inner}${close}`, atomic: true};
    }

    private readDelimiter(): string {
        this.skipSpaces();
        if (this.pos >= this.src.length) return "";
        const ch = this.src[this.pos];
        if (ch === "\\") {
            this.pos += 1;
            if (this.pos >= this.src.length) return "";
            if (isLetterChar(this.src[this.pos])) {
                const start = this.pos;
                while (this.pos < this.src.length && isLetterChar(this.src[this.pos])) this.pos += 1;
                const name = this.src.slice(start, this.pos);
                return hasOwn(DELIMITERS, name) ? DELIMITERS[name] : "";
            }
            const symbol = this.src[this.pos];
            this.pos += 1;
            if (symbol === "{") return "\\{";
            if (symbol === "}") return "\\}";
            if (symbol === "|") return "‖";
            if (symbol === "." || symbol === " ") return "";
            return symbol;
        }
        this.pos += 1;
        if (ch === ".") return "";
        return ch;
    }

    // ---------------------------------------------------------------- 环境

    private parseEnvironment(): Piece | null {
        const nameRaw = this.readRawGroup();
        if (nameRaw === null) return null;
        const envName = nameRaw.trim();
        const env = envName.replace(/\*$/, "");
        this.skipSpaces();
        if (this.src[this.pos] === "[") this.readBracketRaw();
        if (env === "array") this.readRawGroup();
        const body = stripTableRules(this.readEnvironmentBody(envName));
        const rows = splitEnvironmentRows(body).map(row => row.map(cell => this.convertRaw(cell).trim()));
        if (rows.length === 0) return {typst: "", atomic: true};

        if (env === "cases" || env === "rcases") {
            const branches = rows
                .map(cells => cells.filter(cell => cell !== "").join(" & "))
                .filter(text => text !== "");
            if (branches.length === 0) return {typst: "", atomic: true};
            return {typst: `cases(${branches.join(", ")})`, atomic: true};
        }

        if (hasOwn(MATRIX_DELIMS, env) || env === "array") {
            const delim = env === "array" ? "none" : MATRIX_DELIMS[env];
            // array 的列对齐声明无法保留到 mat 的 align 参数里，标注精度损失
            if (env === "array") this.note("\\begin{array}");
            const rowsText = rows.map(cells => cells.map(cell => cell || '""').join(", "));
            const prefix = delim === "none" ? "delim: none, " : `delim: "${delim}", `;
            return {typst: `mat(${prefix}${rowsText.join("; ")})`, atomic: true};
        }

        if (ALIGN_ENVS.has(env)) {
            this.note(`\\begin{${env}}`);
            const rowsText = rows
                .map(cells => cells.filter(cell => cell !== "").join(" "))
                .filter(text => text !== "");
            if (rowsText.length === 0) return {typst: "", atomic: true};
            return {typst: `mat(delim: none, ${rowsText.join("; ")})`, atomic: true};
        }

        if (!PASSTHROUGH_ENVS.has(env)) this.note(`\\begin{${env}}`);
        return {
            typst: rows.map(cells => cells.filter(cell => cell !== "").join(" ")).filter(text => text !== "").join(" ; "),
            atomic: false,
        };
    }

    /** 读取环境体：从当前位置到匹配的 `\end{envName}`（支持嵌套）。 */
    private readEnvironmentBody(envName: string): string {
        const start = this.pos;
        let depth = 0;
        let scan = start;
        while (scan < this.src.length) {
            if (this.src[scan] !== "\\") {
                scan += 1;
                continue;
            }
            let end = scan + 1;
            if (isLetterChar(this.src[end] ?? "")) {
                while (end < this.src.length && isLetterChar(this.src[end])) end += 1;
            } else {
                end += 1;
            }
            const name = this.src.slice(scan + 1, end);
            if (name !== "begin" && name !== "end") {
                scan = end;
                continue;
            }
            let cursor = end;
            while (cursor < this.src.length && /\s/.test(this.src[cursor])) cursor += 1;
            if (this.src[cursor] !== "{") {
                scan = end;
                continue;
            }
            let close = cursor + 1;
            while (close < this.src.length && this.src[close] !== "}") close += 1;
            const inner = this.src.slice(cursor + 1, close).trim();
            const after = close < this.src.length ? close + 1 : this.src.length;
            if (name === "begin") {
                depth += 1;
            } else {
                if (depth === 0 && inner === envName) {
                    const body = this.src.slice(start, scan);
                    this.pos = after;
                    return body;
                }
                if (depth > 0) depth -= 1;
            }
            scan = after;
        }
        this.pos = this.src.length;
        return this.src.slice(start);
    }

    // ---------------------------------------------------------------- 原始参数

    private readRawGroup(): string | null {
        this.skipSpaces();
        if (this.pos >= this.src.length || this.src[this.pos] !== "{") return null;
        this.pos += 1;
        const start = this.pos;
        let depth = 1;
        while (this.pos < this.src.length) {
            const ch = this.src[this.pos];
            if (ch === "\\") {
                this.pos += 2;
                continue;
            }
            if (ch === "{") {
                depth += 1;
            } else if (ch === "}") {
                depth -= 1;
                if (depth === 0) {
                    const raw = this.src.slice(start, this.pos);
                    this.pos += 1;
                    return raw;
                }
            }
            this.pos += 1;
        }
        return this.src.slice(start);
    }

    private readBracketRaw(): string | null {
        this.skipSpaces();
        if (this.pos >= this.src.length || this.src[this.pos] !== "[") return null;
        const start = this.pos + 1;
        let depth = 1;
        let cursor = start;
        while (cursor < this.src.length) {
            if (this.src[cursor] === "[") depth += 1;
            else if (this.src[cursor] === "]") {
                depth -= 1;
                if (depth === 0) {
                    this.pos = cursor + 1;
                    return this.src.slice(start, cursor);
                }
            }
            cursor += 1;
        }
        this.pos = this.src.length;
        return this.src.slice(start);
    }
}

/**
 * 把 LaTeX 数学公式转换成 Typst 公式体（不含 `$` 包裹）。
 *
 * @param latex 模型输出或手写的 LaTeX 公式
 * @returns typst 字段是尽力而为的 Typst 公式体，unsupported 是去重后的未知命令
 */
export function latexToTypst(latex: string): LatexToTypstResult {
    if (typeof latex !== "string" || !latex.trim()) {
        return {typst: "", unsupported: []};
    }
    try {
        return new LatexConverter(latex).run();
    } catch {
        // 理论上不可达；兜底保证绝不向调用方抛异常
        const fallback = latex
            .replace(/\\[A-Za-z]+\*?/g, " ")
            .replace(/[{}]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        return {typst: fallback, unsupported: []};
    }
}
