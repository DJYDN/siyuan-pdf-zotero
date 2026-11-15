/**
 * Safe LaTeX pretty-printer for OCR results.
 *
 * The formatter only changes whitespace and compresses repeated spacing
 * commands. In math mode a newline is just a space, so the rendered formula is
 * unchanged. It never inserts `\\`, never rewrites environments and never
 * removes single spacing commands.
 */

const MULTILINE_ENVS = [
    "aligned", "align", "align*", "alignedat", "gathered", "split", "multline", "multline*",
    "cases", "dcases", "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix",
    "smallmatrix", "array", "subarray", "eqnarray", "eqnarray*", "equation", "equation*",
];

const RELATION_COMMANDS = new Set([
    "=", "\\leq", "\\le", "\\geq", "\\ge", "\\neq", "\\ne", "\\approx", "\\equiv", "\\sim", "\\simeq",
    "\\cong", "\\propto", "\\ll", "\\gg", "\\leqslant", "\\geqslant", "\\to", "\\rightarrow",
    "\\leftarrow", "\\Rightarrow", "\\Leftarrow", "\\Leftrightarrow", "\\iff", "\\implies",
    "\\in", "\\notin", "\\subset", "\\subseteq", "\\supset", "\\supseteq", "\\perp", "\\parallel",
]);

const RELATION_CHARS = new Set(["=", "<", ">"]);

const SPACING_COMMANDS = new Set([
    "\\,", "\\!", "\\;", "\\:", "\\ ", "\\quad", "\\qquad", "\\thinspace", "\\medspace", "\\thickspace", "\\enspace",
]);

type Token =
    | {k: "cmd"; v: string}
    | {k: "env"; begin: boolean; name: string; raw: string}
    | {k: "lb"; raw: string}
    | {k: "open"}
    | {k: "close"}
    | {k: "char"; v: string}
    | {k: "space"; raw: string};

export function shouldFormatLatex(latex: string): boolean {
    const value = String(latex || "");
    if (value.trim().length > 120) {
        return true;
    }
    for (const env of MULTILINE_ENVS) {
        if (value.includes(`\\begin{${env}}`)) {
            return true;
        }
    }
    return false;
}

export function extractLatexFromKramdown(kramdown: string): string {
    const raw = String(kramdown || "").trim();
    if (!raw) return "";
    // Drop SiYuan's trailing block attribute line, e.g. `{: id="202..." updated="..."}`.
    const withoutAttrs = raw.replace(/\n?\{:[^}]*\}\s*$/, "").trim();
    const fenced = /^\$\$([\s\S]*?)\$\$$/.exec(withoutAttrs);
    if (fenced) {
        return fenced[1].trim();
    }
    return "";
}

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        if (/\s/.test(ch)) {
            let j = i;
            while (j < source.length && /\s/.test(source[j])) j++;
            tokens.push({k: "space", raw: source.slice(i, j)});
            i = j;
            continue;
        }
        if (ch === "\\") {
            if (source[i + 1] === "\\") {
                let end = i + 2;
                const optional = /^\[[^\]]*\]/.exec(source.slice(end));
                if (optional) end += optional[0].length;
                tokens.push({k: "lb", raw: source.slice(i, end)});
                i = end;
                continue;
            }
            let j = i + 1;
            if (/[a-zA-Z]/.test(source[j] || "")) {
                while (j < source.length && /[a-zA-Z]/.test(source[j])) j++;
            } else {
                j = Math.min(source.length, i + 2);
            }
            const command = source.slice(i, j);
            if (command === "\\begin" || command === "\\end") {
                const env = /^\s*\{([^{}]*)\}/.exec(source.slice(j));
                if (env) {
                    tokens.push({
                        k: "env",
                        begin: command === "\\begin",
                        name: env[1].trim(),
                        raw: command + env[0],
                    });
                    i = j + env[0].length;
                    continue;
                }
            }
            tokens.push({k: "cmd", v: command});
            i = j;
            continue;
        }
        if (ch === "{") {
            tokens.push({k: "open"});
            i += 1;
            continue;
        }
        if (ch === "}") {
            tokens.push({k: "close"});
            i += 1;
            continue;
        }
        tokens.push({k: "char", v: ch});
        i += 1;
    }
    return tokens;
}

/** Collapse runs of `\, \,`-style commands into a single one (keeps the first). */
function compressSpacingCommands(tokens: Token[]): Token[] {
    const result: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.k === "cmd" && SPACING_COMMANDS.has(token.v)) {
            result.push(token);
            // Consume only the *repeated* spacing commands (and the spaces between
            // them); the space separating the run from the next token is kept.
            let j = i + 1;
            for (;;) {
                let k = j;
                while (k < tokens.length && tokens[k].k === "space") k += 1;
                const next = k < tokens.length ? tokens[k] : null;
                if (next && next.k === "cmd" && SPACING_COMMANDS.has(next.v)) {
                    j = k + 1;
                    continue;
                }
                break;
            }
            i = j - 1;
            continue;
        }
        result.push(token);
    }
    return result;
}

function validate(tokens: Token[]): boolean {
    let braceDepth = 0;
    const envStack: string[] = [];
    for (const token of tokens) {
        if (token.k === "open") braceDepth += 1;
        else if (token.k === "close") {
            braceDepth -= 1;
            if (braceDepth < 0) return false;
        } else if (token.k === "env") {
            if (token.begin) envStack.push(token.name);
            else if (envStack.pop() !== token.name) return false;
        }
    }
    return braceDepth === 0 && envStack.length === 0;
}

/**
 * Format raw LaTeX. Returns the input unchanged when the source is unbalanced or
 * the formatter cannot safely process it.
 */
export function formatLatex(latex: string): string {
    const source = String(latex || "");
    if (!source.trim()) return source;
    try {
        const tokens = compressSpacingCommands(tokenize(source));
        if (!validate(tokens)) return source;

        const lines: string[] = [];
        let current = "";
        let braceDepth = 0;
        let textDepth = 0;
        let pendingText = false;
        let envStack: string[] = [];

        const pushLine = (): void => {
            const text = current.replace(/[ \t]+$/g, "");
            if (text.trim()) {
                lines.push("  ".repeat(envStack.length) + text);
            }
            current = "";
        };
        // Only top-level relations (outside any environment and brace) are broken;
        // inside aligned/cases rows the rows are already delimited by \\.
        const breakRelation = (): boolean => braceDepth === 0 && textDepth === 0 && envStack.length === 0;

        for (const token of tokens) {
            switch (token.k) {
                case "env":
                    if (token.begin) {
                        current += token.raw;
                        pushLine();
                        envStack.push(token.name);
                    } else {
                        pushLine();
                        const index = envStack.lastIndexOf(token.name);
                        if (index >= 0) envStack = envStack.slice(0, index);
                        current += token.raw;
                    }
                    break;
                case "lb":
                    current += token.raw;
                    pushLine();
                    break;
                case "open":
                    current += "{";
                    if (pendingText) {
                        textDepth += 1;
                        pendingText = false;
                    } else {
                        braceDepth += 1;
                    }
                    break;
                case "close":
                    current += "}";
                    if (textDepth > 0) textDepth -= 1;
                    else braceDepth -= 1;
                    break;
                case "space":
                    if (textDepth > 0) current += token.raw;
                    else if (current && !current.endsWith(" ")) current += " ";
                    break;
                case "cmd":
                    current += token.v;
                    if (token.v === "\\text") pendingText = true;
                    if (RELATION_COMMANDS.has(token.v) && breakRelation()) pushLine();
                    break;
                case "char":
                    current += token.v;
                    if (RELATION_CHARS.has(token.v) && breakRelation()) pushLine();
                    break;
            }
        }
        pushLine();
        const formatted = lines.join("\n");
        return formatted.trim() ? formatted : source;
    } catch {
        return source;
    }
}
