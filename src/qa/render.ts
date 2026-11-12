import katex from "katex";
import {pluginAssetUrl} from "../runtime";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch] as string));
}

/** Render AI Markdown with SiYuan's own Lute engine so headings, lists,
 * tables, code and math look like normal note content. */
let katexCssLoaded = false;
function ensureKatexCss(): void {
    if (katexCssLoaded) return;
    katexCssLoaded = true;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = pluginAssetUrl("katex.min.css");
    document.head.append(link);
}

export function renderQaMarkdown(markdown: string): string {
    ensureKatexCss();
    const math: Array<{token: string; tex: string; display: boolean; raw: string}> = [];
    // Protect math before Lute: its HTML renderer does not run KaTeX itself.
    const protectedMarkdown = String(markdown || "").replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (raw, displayTex, inlineTex) => {
        const tex = String(displayTex ?? inlineTex ?? "");
        const token = `PZQAMATH${math.length}TOKEN`;
        math.push({token, tex, display: displayTex !== undefined, raw});
        return token;
    });
    const Lute = (window as any).Lute;
    let html = "";
    try {
        const lute = Lute?.New?.();
        if (lute?.Md2HTML) {
            html = String(lute.Md2HTML(protectedMarkdown) || "");
        } else if (lute?.Md2BlockDOM) {
            html = String(lute.Md2BlockDOM(protectedMarkdown) || "");
        }
    } catch {
        html = "";
    }
    if (!html) {
        html = `<p>${escapeHtml(protectedMarkdown).replace(/\n/g, "<br>")}</p>`;
    }
    html = sanitize(html);
    if (math.length) {
        for (const item of math) {
            let replacement = escapeHtml(item.raw);
            try {
                replacement = katex.renderToString(item.tex, {
                    displayMode: item.display,
                    throwOnError: false,
                    strict: false,
                });
            } catch (error) {
                console.warn("[pdf-zotero] KaTeX failed", item.tex, error);
            }
            html = html.split(item.token).join(replacement);
        }
    }
    // Some Lute versions normalize or split our placeholder. Do a final pass
    // over any untouched dollar-delimited math so it never surfaces as raw TeX.
    html = html.replace(/\$\$([\s\S]+?)\$\$|\$([^$\n<]+?)\$/g, (raw, displayTex, inlineTex) => {
        try {
            return katex.renderToString(String(displayTex ?? inlineTex ?? ""), {
                displayMode: displayTex !== undefined,
                throwOnError: false,
                strict: false,
            });
        } catch {
            return raw;
        }
    });
    return html;
}

function sanitize(html: string): string {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,iframe,object,embed,link,meta").forEach(node => node.remove());
    doc.querySelectorAll("*").forEach(node => {
        for (const attr of Array.from(node.attributes)) {
            if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
            if ((attr.name === "href" || attr.name === "src") && /^\s*javascript:/i.test(attr.value)) {
                node.removeAttribute(attr.name);
            }
        }
    });
    return doc.body.innerHTML;
}
