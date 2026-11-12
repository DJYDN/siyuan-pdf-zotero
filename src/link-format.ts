import {annotationHref} from "./anchor";
import type {Annotation, Book, DisplayTextFormat, LinkCopyFormat} from "./types";
import {HIGHLIGHT_COLORS} from "./constants";

function excerptText(text: string, max = 48): string {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
    return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => vars[key] ?? "");
}

function sourceTitle(value: string): string {
    return String(value || "PDF").replace(/\.pdf$/i, "").trim() || "PDF";
}

function annotationColorId(annotation: Annotation): string {
    return HIGHLIGHT_COLORS.find(item => item.value.toLowerCase() === annotation.color.toLowerCase())?.id || "yellow";
}

function displayTemplateVars(
    page: number,
    text: string,
    file: string,
): Record<string, string> {
    return {
        page: String(page),
        pageLabel: String(page),
        text,
        file,
        title: file,
        emoji: "📄",
    };
}

export function displayTextForAnnotation(
    annotation: Annotation,
    book: Book | undefined,
    format: DisplayTextFormat,
    customTemplate = "{{file}}, p.{{page}}",
): string {
    const page = `p.${annotation.page}`;
    if (format === "title-page") {
        return `${sourceTitle(book?.title || "PDF")}, ${page}`;
    }
    if (format === "text") {
        return excerptText(annotation.text) || page;
    }
    if (format === "emoji") {
        return "📄";
    }
    if (format === "none") {
        return `PDF ${page}`;
    }
    if (format === "custom") {
        const rendered = renderTemplate(customTemplate, displayTemplateVars(
            annotation.page,
            excerptText(annotation.text),
            sourceTitle(book?.title || "PDF"),
        )).trim();
        return rendered || page;
    }
    return page;
}

export function displayTextForScreenshot(
    fileName: string,
    page: number,
    format: DisplayTextFormat,
    customTemplate = "{{file}}, p.{{page}}",
): string {
    const pageLabel = `p.${page}`;
    const source = String(fileName || "PDF").replace(/\.pdf$/i, "").trim() || "PDF";
    const compactSource = source.length > 46 ? `${source.slice(0, 27)}…${source.slice(-15)}` : source;
    if (format === "title-page") {
        return `${compactSource}, ${pageLabel}`;
    }
    if (format === "text") {
        return `${compactSource} · ${pageLabel}`;
    }
    if (format === "emoji") {
        return "📄";
    }
    if (format === "none") {
        return "";
    }
    if (format === "custom") {
        const rendered = renderTemplate(customTemplate, displayTemplateVars(page, "", compactSource)).trim();
        return rendered || pageLabel;
    }
    return pageLabel;
}

export function formatHrefCopy(
    href: string,
    label: string,
    linkFormat: LinkCopyFormat,
    title: string,
    page: number,
    customTemplate = "{{linkWithDisplay}}",
): string {
    const link = `[${label}](${href})`;
    let colorId = "yellow";
    try { colorId = new URL(href).searchParams.get("color") || colorId; } catch { /* keep default */ }
    if (linkFormat === "quote") {
        return `> ${link}`;
    }
    if (linkFormat === "embed") {
        return `![${label}](${href})`;
    }
    if (linkFormat === "callout") {
        return `> [!PDF|${colorId}] ${link}`;
    }
    if (linkFormat === "quote-callout") {
        return `> [!PDF|${colorId}] ${link}\n>\n> >`;
    }
    if (linkFormat === "custom") {
        return renderTemplate(customTemplate, {
            linkWithDisplay: link,
            link: href,
            display: label,
            text: "",
            title,
            page: String(page),
        }).trim() || link;
    }
    return link;
}

export function formatAnnotationCopy(
    annotation: Annotation,
    book: Book | undefined,
    linkFormat: LinkCopyFormat,
    displayFormat: DisplayTextFormat,
    displayTemplate = "{{file}}, p.{{page}}",
    linkTemplate = "{{linkWithDisplay}}",
): string {
    const href = annotationHref(annotation.id);
    const label = displayTextForAnnotation(annotation, book, displayFormat, displayTemplate);
    const link = `[${label}](${href})`;
    const title = sourceTitle(book?.title || "PDF");
    if (linkFormat === "quote") {
        // Title/link first, quoted excerpt second (PDF++ quote card order).
        return `> ${link}\n>\n> ${annotation.text.replace(/\n+/g, " ")}`;
    }
    if (linkFormat === "embed") {
        return `![${label}](${href})`;
    }
    if (linkFormat === "callout") {
        return `> [!PDF|${annotationColorId(annotation)}] ${link}\n>\n> ${annotation.text.replace(/\n+/g, " ")}`;
    }
    if (linkFormat === "quote-callout") {
        return `> [!PDF|${annotationColorId(annotation)}] ${link}\n>\n> > ${annotation.text.replace(/\n+/g, " ")}`;
    }
    if (linkFormat === "custom") {
        return renderTemplate(linkTemplate, {
            linkWithDisplay: link,
            link: href,
            display: label,
            text: annotation.text,
            title,
            page: String(annotation.page),
        }).trim() || link;
    }
    return link;
}
