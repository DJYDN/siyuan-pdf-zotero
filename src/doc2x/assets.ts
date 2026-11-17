import {requireNode} from "../runtime";
import {uploadPngAsset} from "../siyuan";

const MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    svg: "image/svg+xml",
};

/**
 * Upload local images referenced by a parsed Markdown file into SiYuan assets
 * and rewrite the links, so the same Markdown renders in the preview dialog and
 * inserts cleanly into notes.
 */
export async function materializeMarkdownImages(markdown: string, baseDir: string): Promise<{markdown: string; uploaded: number}> {
    const fs = requireNode("fs");
    const path = requireNode("path");
    if (!fs || !path) return {markdown, uploaded: 0};
    const pattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    const matches = Array.from(String(markdown || "").matchAll(pattern) as any) as RegExpMatchArray[];
    const replacements: Array<{raw: string; asset: string}> = [];
    for (const match of matches) {
        const raw = String(match[2] || "");
        if (!raw || /^[a-z]+:/i.test(raw) || raw.startsWith("/assets/") || raw.startsWith("assets/")) continue;
        const file = path.isAbsolute(raw) ? raw : path.join(baseDir, decodeURIComponent(raw));
        if (!fs.existsSync(file)) continue;
        const ext = String(file.split(".").pop() || "").toLowerCase();
        try {
            const blob = new Blob([fs.readFileSync(file)], {type: MIME[ext] || "application/octet-stream"});
            const asset = await uploadPngAsset(blob, path.basename(file));
            replacements.push({raw, asset});
        } catch {
            // keep the original link when upload fails
        }
    }
    let output = markdown;
    for (const replacement of replacements) {
        output = output.split(`](${replacement.raw})`).join(`](${replacement.asset})`);
    }
    return {markdown: output, uploaded: replacements.length};
}

/** Preview needs root-relative asset URLs; stored notes keep SiYuan's relative form. */
export function markdownForPreview(markdown: string): string {
    return String(markdown || "").replace(/\]\((assets\/[^)\s]+)\)/g, "](/assets/$1)");
}
