export interface CleanOptions {
    /** Convert \(..\) and \[..\] TeX delimiters to $..$ / $$..$$ so SiYuan renders them. */
    math: boolean;
    /** Convert simple HTML tables to Markdown pipe tables. */
    tables: boolean;
    /** Strip Doc2X wrapper tags such as div/span/hr/br/comments. */
    html: boolean;
    /** Drop HTML comments (Doc2X can leave layout markers). */
    comments: boolean;
}

export const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
    math: true,
    tables: true,
    html: true,
    comments: true,
};

export interface CleanResult {
    markdown: string;
    warnings: string[];
}

function decodeEntities(text: string): string {
    return text
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, "&");
}

function stripTags(text: string): string {
    return decodeEntities(String(text || "")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, ""))
        .replace(/\s+/g, " ")
        .trim();
}

function convertTables(markdown: string, warnings: string[]): string {
    return markdown.replace(/<table[\s\S]*?<\/table>/gi, block => {
        const rows = Array.from(block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map(row =>
            Array.from(String(row[1]).matchAll(/<(t[dh])([^>]*)>([\s\S]*?)<\/\1>/gi)).map(cell => ({
                tag: String(cell[1]).toLowerCase(),
                attrs: String(cell[2] || ""),
                text: stripTags(cell[3]),
            })),
        );
        if (!rows.length || rows.some(row => row.length === 0)) {
            warnings.push("发现无法解析的表格，已保留原始 HTML。");
            return block;
        }
        const complex = rows.some(row => row.some(cell => /rowspan|colspan/i.test(cell.attrs)));
        if (complex) {
            warnings.push("表格包含合并单元格，已保留原始 HTML（思源可能无法渲染）。");
            return block;
        }
        const width = Math.max(...rows.map(row => row.length));
        const cells = rows.map(row => {
            const values = row.map(cell => cell.text.replace(/\|/g, "\\|"));
            while (values.length < width) values.push("");
            return `| ${values.join(" | ")} |`;
        });
        const separator = `| ${Array.from({length: width}, () => "---").join(" | ")} |`;
        return ["", cells[0], separator, ...cells.slice(1), ""].join("\n");
    });
}

export function cleanDoc2xMarkdown(input: string, options: CleanOptions = DEFAULT_CLEAN_OPTIONS): CleanResult {
    let markdown = String(input || "").replace(/\r\n?/g, "\n");
    const warnings: string[] = [];

    if (options.comments) {
        markdown = markdown.replace(/<!--[\s\S]*?-->/g, "");
    }
    if (options.math) {
        markdown = markdown
            .replace(/\\\[([\s\S]*?)\\\]/g, (_raw, tex) => `\n$$\n${String(tex).trim()}\n$$\n`)
            .replace(/\\\(([\s\S]*?)\\\)/g, (_raw, tex) => `$${String(tex).trim()}$`);
    }
    if (options.tables) {
        markdown = convertTables(markdown, warnings);
    }
    if (options.html) {
        markdown = markdown
            .replace(/<\/?(?:div|span|center|section|article|font)\b[^>]*>/gi, "")
            .replace(/<hr\s*\/?>/gi, "\n---\n")
            .replace(/<br\s*\/?>/gi, "\n");
    }
    markdown = markdown
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return {markdown, warnings};
}

export function firstHeading(markdown: string, fallback = ""): string {
    const match = String(markdown || "").match(/^\s{0,3}#{1,3}\s+(.+)$/m);
    if (match) return stripTags(match[1]).slice(0, 120);
    const first = String(markdown || "").split(/\n/).map(line => line.trim()).find(line => line && !line.startsWith("!["));
    return (first ? stripTags(first) : "").slice(0, 120) || fallback;
}
