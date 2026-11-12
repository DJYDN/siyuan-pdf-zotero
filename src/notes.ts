import {getActiveEditor, getAllEditor, getFrontend, showMessage} from "siyuan";
import {annotationHref} from "./anchor";
import type {Annotation, Book, DisplayTextFormat, LinkCopyFormat} from "./types";
import {displayTextForAnnotation, formatAnnotationCopy} from "./link-format";
import type {Store} from "./storage";
import {HIGHLIGHT_COLORS} from "./constants";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[ch] as string));
}

function escapeAttr(text: string): string {
    return escapeHtml(text).replace(/`/g, "&#96;");
}

function escapeMarkdownLabel(text: string): string {
    return text.replace(/([\\[\]])/g, "\\$1").replace(/\r?\n/g, " ");
}

function apiHeaders(): Record<string, string> {
    const apiToken = String((window as any).siyuan?.config?.api?.token || "");
    return {"Content-Type": "application/json", ...(apiToken ? {Authorization: `Token ${apiToken}`} : {})};
}

/** Inline fallback for themes that tint the whole callout via high-specificity CSS. */
export function stylePdfCalloutDom(block: HTMLElement | null): void {
    if (!block) {
        return;
    }
    block.style.setProperty("background", "var(--pz-callout-body-bg)", "important");
    block.style.setProperty("border", "1px solid rgba(var(--pz-callout-rgb), .55)", "important");
    block.style.setProperty("box-shadow", "0 1px 3px rgba(0,0,0,.07)", "important");
    const info = block.querySelector<HTMLElement>(".callout-info");
    info?.style.setProperty("background", "rgba(var(--pz-callout-rgb), var(--pz-callout-band-alpha))", "important");
    info?.style.setProperty("background-image", "none", "important");
    info?.style.setProperty("border-bottom", "1px solid rgba(var(--pz-callout-rgb), .42)", "important");
    const title = block.querySelector<HTMLElement>(".callout-title");
    title?.style.setProperty("color", "var(--pz-callout-title-color)", "important");
    title?.style.setProperty("-webkit-text-fill-color", "var(--pz-callout-title-color)", "important");
    const content = block.querySelector<HTMLElement>(".callout-content");
    content?.style.setProperty("background", "var(--pz-callout-body-bg)", "important");
    content?.style.setProperty("background-image", "none", "important");
    content?.style.setProperty("color", "var(--b3-theme-on-background)", "important");
    content?.querySelectorAll<HTMLElement>(".p").forEach(paragraph => {
        paragraph.style.setProperty("background", "var(--pz-callout-body-bg)", "important");
        paragraph.style.setProperty("background-image", "none", "important");
        paragraph.style.setProperty("color", "var(--b3-theme-on-background)", "important");
        paragraph.style.setProperty("-webkit-text-fill-color", "var(--b3-theme-on-background)", "important");
    });
    // The callout theme also sets -webkit-text-fill-color on inner spans; force them too.
    content?.querySelectorAll<HTMLElement>("*").forEach(element => {
        element.style.setProperty("color", "var(--b3-theme-on-background)", "important");
        element.style.setProperty("-webkit-text-fill-color", "var(--b3-theme-on-background)", "important");
    });
    content?.querySelectorAll<HTMLElement>(".p, .p > div").forEach(element => {
        element.style.setProperty("font-weight", "400", "important");
        element.style.setProperty("font-family", "inherit", "important");
        element.style.setProperty("font-style", "normal", "important");
    });
}

export async function applyPdfCalloutAttributes(blockId: string, kind: "PDF" | "quote", colorId: string): Promise<void> {
    if (!blockId) return;
    const attrs = {
        "custom-callout": kind,
        "custom-b": kind,
        "custom-callout-mode": "small",
        "callout-mode": "small",
        "custom-pz-callout": "true",
        "custom-pz-color": colorId,
    };
    const response = await fetch("/api/attr/setBlockAttrs", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({id: blockId, attrs}),
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
        throw new Error(result.msg || "设置 Callout 属性失败");
    }
}

export function excerpt(text: string, max = 120): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

export interface InsertedNote {
    blockId: string;
    docId: string;
    html: string;
}

export function buildPdfCalloutMarkdown(
    annotation: Annotation,
    book: Book | undefined,
    displayFormat: DisplayTextFormat,
    displayTemplate: string,
    quoteInCallout: boolean,
): string {
    const href = annotationHref(annotation.id);
    const sourceLabel = displayTextForAnnotation(annotation, book, displayFormat, displayTemplate);
    // Lute does not parse Obsidian callout markers inside the plugin's Md2BlockDOM
    // path, so use a normal blockquote and style it through custom attrs.
    const header = `> [${escapeMarkdownLabel(sourceLabel)}](${href})`;
    const body = annotation.text.replace(/\r?\n+/g, " ");
    return quoteInCallout ? `${header}\n>\n> > ${body}` : `${header}\n>\n> ${body}`;
}

/** Insert a structured PDF annotation link at the current editor cursor via public Protyle API. */
export async function insertAnnotationNote(
    store: Store,
    annotation: Annotation,
    book: Book | undefined,
): Promise<InsertedNote | null> {
    annotation = store.getAnnotation(annotation.id) || annotation;
    if (getFrontend() === "mobile" || getFrontend() === "browser-mobile") {
        showMessage("P0 暂只支持桌面端插入笔记");
        return null;
    }
    const active = getActiveEditor();
    const editor = active || getAllEditor()[0];
    if (!editor) {
        showMessage("请先打开一个思源文档，再插入 PDF 摘录");
        return null;
    }
    const root = editor.protyle.wysiwyg?.element;
    if (!root) {
        showMessage("当前编辑器尚未就绪，请稍后重试");
        return null;
    }
    const before = new Set<string>();
    root.querySelectorAll<HTMLElement>("[data-node-id]").forEach(el => {
        if (el.dataset.nodeId) {
            before.add(el.dataset.nodeId);
        }
    });

    const href = annotationHref(annotation.id);
    const title = book ? `${book.title}${book.year ? ` (${book.year})` : ""}` : "PDF";
    const template = store.state.settings.excerptTemplate || "{text}";
    const label = template
        .replaceAll("{text}", excerpt(annotation.text))
        .replaceAll("{page}", String(annotation.page))
        .replaceAll("{title}", book?.title || "PDF")
        .replace(/\s+/g, " ")
        .trim() || excerpt(annotation.text);
    const linkHtml = `<span data-type="a" data-href="${escapeAttr(href)}" title="${escapeAttr(`${title} · p.${annotation.page}`)}">${escapeHtml(label)}</span>`;
    const linkFormat = store.state.settings.linkCopyFormat;
    const isCallout = linkFormat === "callout" || linkFormat === "quote-callout";
    const calloutKind = linkFormat === "quote-callout" ? "quote" : "PDF";
    const colorId = HIGHLIGHT_COLORS.find(item => item.value.toLowerCase() === annotation.color.toLowerCase())?.id || "yellow";
    const calloutMarkdown = buildPdfCalloutMarkdown(
        annotation,
        book,
        store.state.settings.displayTextFormat,
        store.state.settings.displayTextTemplate,
        linkFormat === "quote-callout",
    );
    const calloutDom = isCallout ? (window as any).Lute?.New?.()?.Md2BlockDOM?.(calloutMarkdown) : "";
    const html = isCallout ? (calloutDom || linkHtml) : linkHtml;
    editor.insert(html, isCallout, false);

    // Protyle.insert() is synchronous for the DOM but the block transaction is committed asynchronously.
    await new Promise(resolve => setTimeout(resolve, 260));
    let target: HTMLElement | null = null;
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]"))) {
        if (element.dataset.nodeId && before.has(element.dataset.nodeId)) {
            continue;
        }
        if (element.querySelector(`[data-href="${CSS.escape(href)}"]`)) {
            target = element;
            break;
        }
    }
    if (!target) {
        // The cursor may have been inside an existing paragraph: find the block that contains our link.
        for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]"))) {
            if (element.querySelector(`[data-href="${CSS.escape(href)}"]`)) {
                target = element;
                break;
            }
        }
    }
    const blockId = target?.dataset.nodeId || "";
    const docId = String(editor.protyle.block.rootID || "");
    if (blockId && isCallout) {
        try {
            await applyPdfCalloutAttributes(blockId, calloutKind, colorId);
            target?.setAttribute("custom-callout", calloutKind);
            target?.setAttribute("custom-b", calloutKind);
            target?.setAttribute("custom-callout-mode", "small");
            target?.setAttribute("callout-mode", "small");
            target?.setAttribute("custom-pz-callout", "true");
            target?.setAttribute("custom-pz-color", colorId);
            stylePdfCalloutDom(target);
        } catch (error) {
            console.warn("[pdf-zotero] callout attrs failed", error);
            showMessage("Callout 已插入，但样式属性设置失败", 4000, "error");
        }
    }
    if (blockId && docId) {
        store.addNoteLink(annotation.id, blockId, docId);
        await store.save();
    }
    showMessage(`已插入 PDF 摘录${blockId ? `（块 ${blockId}）` : ""}`, 3000);
    return {blockId, docId, html};
}

/** Copy using PDF++ Link copy format + Display text format settings. */
export async function copyAnnotationFormatted(
    annotation: Annotation,
    book: Book | undefined,
    linkFormat: LinkCopyFormat,
    displayFormat: DisplayTextFormat,
    displayTemplate = "{{file}}, p.{{page}}",
    linkTemplate = "{{linkWithDisplay}}",
): Promise<string> {
    const text = formatAnnotationCopy(annotation, book, linkFormat, displayFormat, displayTemplate, linkTemplate);
    try {
        await navigator.clipboard.writeText(text);
        showMessage("已复制 PDF 链接（PDF++ 格式）", 2000);
    } catch {
        showMessage(`复制失败，内容：${text}`, 6000, "error");
    }
    return text;
}

/** Copy a PDF++-style quote/callout with a precise backlink. */
export async function copyAnnotationQuote(annotation: Annotation, book?: Book): Promise<string> {
    const href = annotationHref(annotation.id);
    const source = `${book?.title || "PDF"} · p.${annotation.page}`;
    const quote = `> ${annotation.text.replace(/\n+/g, " ")}\n>\n> — [${source}](${href})`;
    try {
        await navigator.clipboard.writeText(quote);
        showMessage("已复制引用（带精准链接）", 2000);
    } catch {
        showMessage(`复制失败，内容：${quote}`, 6000, "error");
    }
    return quote;
}

/** Copy the stable annotation URL. The visible text is only a hint; the ID is the identity. */
export async function copyAnnotationLink(annotation: Annotation): Promise<string> {
    const href = annotationHref(annotation.id);
    try {
        await navigator.clipboard.writeText(href);
        showMessage("已复制 PDF 精准链接", 2000);
    } catch {
        showMessage(`复制失败，链接：${href}`, 5000, "error");
    }
    return href;
}
