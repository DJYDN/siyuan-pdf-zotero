import {getActiveTab, getAllEditor, getAllTabs, openTab} from "siyuan";
import type PdfZoteroPlugin from "./index";
import {insertAnnotationNote} from "./notes";
import {requireNode} from "./runtime";
import {e2eSleep as sleep} from "./e2e-utils";

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 15000, interval = 120): Promise<T> {
    const start = Date.now();
    let lastError: any;
    while (Date.now() - start < timeoutMs) {
        try {
            const value = await fn();
            if (value) {
                return value;
            }
        } catch (error) {
            lastError = error;
        }
        await sleep(interval);
    }
    throw new Error(`等待超时（${timeoutMs}ms）${lastError ? `：${lastError.message || lastError}` : ""}`);
}

function token(): string {
    return String((window as any).siyuan?.config?.api?.token || "");
}

async function api(path: string, payload: Record<string, any>): Promise<any> {
    const response = await fetch(path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token() ? {Authorization: `Token ${token()}`} : {}),
        },
        body: JSON.stringify(payload),
    });
    const json = await response.json();
    if (json.code !== 0) {
        throw new Error(`${path} failed: code=${json.code} msg=${json.msg}`);
    }
    return json.data;
}

function setCaretToEnd(editor: any): void {
    const root = editor.protyle.wysiwyg?.element as HTMLElement | undefined;
    if (!root) {
        throw new Error("editor wysiwyg unavailable");
    }
    const blocks = root.querySelectorAll<HTMLElement>("[data-node-id]");
    const target = blocks[blocks.length - 1] || root;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    editor.focus();
}

function setCaretAfterText(editor: any, needle: string): void {
    const root = editor.protyle.wysiwyg?.element as HTMLElement | undefined;
    if (!root) {
        throw new Error("editor wysiwyg unavailable");
    }
    editor.focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const index = String(node.textContent || "").indexOf(needle);
        if (index < 0) {
            continue;
        }
        const range = document.createRange();
        range.setStart(node, index + needle.length);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
    }
    throw new Error(`caret marker not found: ${needle}`);
}

function visibleReader(attachmentId: string): HTMLElement | null {
    // When the same PDF is reopened, prefer the newest reader tab.
    return Array.from(document.querySelectorAll<HTMLElement>(".pz-reader")).reverse().find(reader => {
        if (reader.dataset.attachmentId !== attachmentId) {
            return false;
        }
        const rect = reader.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }) || null;
}

function activateTabByTitle(titlePart: string): boolean {
    const tab = getAllTabs().find(item => String(item.title || "").includes(titlePart));
    if (!tab) {
        return false;
    }
    try {
        tab.parent.switchTab(tab.headElement, false);
        return true;
    } catch {
        return false;
    }
}

function selectTextOnPage(reader: HTMLElement, pageNumber: number): string {
    const page = reader.querySelector<HTMLElement>(`.pz-page[data-page="${pageNumber}"]`);
    if (!page) {
        throw new Error(`page ${pageNumber} not rendered`);
    }
    page.scrollIntoView({block: "center"});
    const spans = Array.from(page.querySelectorAll<HTMLElement>(".pz-text-layer span")).filter(span => {
        const textNode = Array.from(span.childNodes).find(node => node.nodeType === Node.TEXT_NODE);
        return Boolean(textNode && (textNode.textContent || "").trim().length > 8);
    });
    if (spans.length < 2) {
        throw new Error(`not enough text spans on page ${pageNumber}`);
    }
    const firstNode = Array.from(spans[0].childNodes).find(node => node.nodeType === Node.TEXT_NODE)!;
    const secondNode = Array.from(spans[1].childNodes).find(node => node.nodeType === Node.TEXT_NODE)!;
    const range = document.createRange();
    range.setStart(firstNode, 0);
    range.setEnd(secondNode, Math.min(30, secondNode.textContent?.length || 1));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    reader.querySelector<HTMLElement>(".pz-pages")?.dispatchEvent(new MouseEvent("mouseup", {bubbles: true}));
    return range.toString();
}

export interface P1E2EReport {
    ok: boolean;
    at: string;
    steps: Array<{name: string; at: string; data?: any}>;
    error?: string;
}

export async function runP1E2E(
    plugin: PdfZoteroPlugin,
    onProgress?: (report: P1E2EReport) => Promise<void>,
): Promise<P1E2EReport> {
    const report: P1E2EReport = {ok: false, at: new Date().toISOString(), steps: []};
    const step = (name: string, data?: any) => {
        report.steps.push({name, at: new Date().toISOString(), data});
        void onProgress?.(JSON.parse(JSON.stringify(report)));
    };
    try {
        (window as any).__pdfZoteroForceFakeWorker = false;
        (window as any).__pdfZoteroNoStdFonts = false;
        (window as any).__pdfZoteroNoAssets = false;
        const diagnostics = await plugin.collectDiagnostics();
        step("diagnostics", diagnostics);
        if (!diagnostics.hasNodeFs) {
            throw new Error("window.require('fs') unavailable");
        }
        const notebooks = await api("/api/notebook/lsNotebooks", {});
        const opened = (notebooks.notebooks || []).filter((notebook: any) => !notebook.closed);
        if (!opened.length) {
            throw new Error("no open notebook");
        }
        const docPath = `/p1-e2e-${Date.now()}`;
        const docId = await api("/api/filetree/createDocWithMd", {
            notebook: opened[0].id,
            path: docPath,
            markdown: "P1 E2E before\n\nP1 INSERT HERE\n\nP1 E2E after\n",
        });
        const docTitle = docPath.split("/").pop() || "p1-e2e";
        step("doc-created", {docId, docTitle});
        void openTab({app: plugin.app, doc: {id: docId}, openNewTab: true, position: "right"});
        const editor = await waitFor(() => getAllEditor().find(item => item.protyle.block.rootID === docId), 15000);
        step("editor-opened", {rootID: editor.protyle.block.rootID});

        const sourcePdf = "test-fixtures/navigation.pdf";
        const uniquePdf = sourcePdf.replace(/\.pdf$/i, `-p1-${Date.now()}.pdf`);
        const fsNode = requireNode("fs");
        fsNode.copyFileSync(sourcePdf, uniquePdf);
        let closedTabs = 0;
        for (const tab of getAllTabs()) {
            const title = String(tab.title || "");
            const use = tab.headElement?.querySelector("use");
            const icon = use?.getAttribute("xlink:href") || use?.getAttribute("href") || "";
            if (icon === "#iconPdfZotero" || title.includes("navigation") || title.includes("sample-paper") || title.includes("p1-e2e")) {
                try {
                    tab.close();
                    closedTabs++;
                } catch {
                    // ignore
                }
            }
        }
        step("tabs-closed", {closedTabs, remaining: document.querySelectorAll(".pz-reader").length});
        await sleep(900);
        const attachment = await plugin.importLocalPath(uniquePdf);
        if (!attachment) {
            throw new Error("failed to import navigation.pdf");
        }
        step("pdf-imported", {attachmentId: attachment.id, path: attachment.path});
        await plugin.openAttachmentAsync(attachment, 1);
        const reader = await waitFor(() => visibleReader(attachment.id), 15000);
        await sleep(1500);
        step("reader-dom", {
            pages: reader.querySelectorAll(".pz-page").length,
            pageNumbers: Array.from(reader.querySelectorAll<HTMLElement>(".pz-page")).map(page => page.dataset.page),
            page8Spans: reader.querySelectorAll('.pz-page[data-page="5"] .pz-text-layer span').length,
            page1Spans: reader.querySelectorAll('.pz-page[data-page="1"] .pz-text-layer span').length,
            error: reader.dataset.pzReaderError || "",
            renderStage: reader.dataset.pzRenderStage || "",
            text: (reader.textContent || "").slice(0, 300),
        });
        await waitFor(() => reader.querySelector('.pz-page[data-page="5"] .pz-text-layer span'), 20000);
        step("pdf-rendered", {
            pages: reader.querySelectorAll(".pz-page").length,
            outlineTab: Boolean(reader.querySelector('[data-side="outline"]')),
            searchInput: Boolean(reader.querySelector('[data-role="search"]')),
            linkBoxes: reader.querySelectorAll(".pz-link-box").length,
        });
        const firstPage = reader.querySelector<HTMLElement>('.pz-page[data-page="1"]')!;
        const outputScale = Number(firstPage.dataset.outputScale || 0);
        if (outputScale < 1.75) throw new Error(`PDF canvas output scale is too low: ${outputScale}`);
        const zoomLabel = reader.querySelector<HTMLElement>('[data-role="zoom"]')!;
        const zoomBeforeWheel = zoomLabel.textContent || "";
        const firstPageRect = firstPage.getBoundingClientRect();
        firstPage.dispatchEvent(new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: -80,
            clientX: firstPageRect.left + firstPageRect.width / 2,
            clientY: firstPageRect.top + firstPageRect.height / 2,
        }));
        await waitFor(() => (zoomLabel.textContent || "") !== zoomBeforeWheel, 3000);
        await waitFor(() => {
            const rerenderedPage = reader.querySelector<HTMLElement>('.pz-page[data-page="1"]');
            return rerenderedPage && rerenderedPage !== firstPage && rerenderedPage.dataset.outputScale ? rerenderedPage : null;
        }, 10000);
        await waitFor(() => reader.querySelector('.pz-page[data-page="5"] .pz-text-layer span'), 20000);
        step("hidpi-wheel-zoom", {outputScale, before: zoomBeforeWheel, after: zoomLabel.textContent});
        const topbar = reader.querySelector<HTMLElement>(".pz-topbar");
        step("layout", {
            topButtons: topbar?.querySelectorAll("button").length || 0,
            topAtPaneTop: topbar ? Math.abs(topbar.getBoundingClientRect().top - reader.getBoundingClientRect().top) < 8 : false,
            hasBottomBar: Boolean(reader.querySelector(".pz-bottombar")),
        });
        const yellowCard = reader.querySelector<HTMLElement>('[data-format-color="yellow"]');
        const yellowCardBackground = yellowCard ? getComputedStyle(yellowCard).backgroundColor : "";
        step("color-card", {background: yellowCardBackground, visibleYellow: yellowCardBackground.includes("255, 208, 0")});
        if (!yellowCardBackground.includes("255, 208, 0")) {
            throw new Error("yellow color card is not rendered with its actual color");
        }

        reader.querySelector<HTMLElement>('[data-act="format-link"]')?.click();
        const linkFormatLabels = await waitFor(() => {
            const labels = Array.from(document.querySelectorAll<HTMLElement>(".pz-format-menu button")).map(item => (item.textContent || "").trim());
            return labels.some(label => label.includes("Customize")) ? labels : null;
        }, 3000);
        step("link-copy-format-menu", {labels: linkFormatLabels});
        for (const label of ["Quote", "Link", "Embed", "Callout", "Quote in a callout", "Customize"]) {
            if (!linkFormatLabels.some(item => item.includes(label))) throw new Error(`missing Link copy format option: ${label}`);
        }
        document.querySelectorAll(".pz-format-menu").forEach(item => item.remove());
        const displayFormatButton = reader.querySelector<HTMLElement>('[data-act="format-display"]');
        displayFormatButton?.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
        displayFormatButton?.click();
        const displayFormatLabels = await waitFor(() => {
            const labels = Array.from(document.querySelectorAll<HTMLElement>(".pz-format-menu button")).map(item => (item.textContent || "").trim());
            return labels.some(label => label.includes("Customize")) && labels.some(label => label.includes("Page")) ? labels : null;
        }, 3000);
        step("display-text-format-menu", {labels: displayFormatLabels});
        for (const label of ["Page", "Text", "Emoji", "None", "Customize"]) {
            if (!displayFormatLabels.some(item => item.includes(label))) throw new Error(`missing Display text format option: ${label}`);
        }
        document.querySelectorAll(".pz-format-menu").forEach(item => item.remove());

        const pageWidthBeforeSide = reader.querySelector<HTMLElement>('.pz-page[data-page="1"]')?.getBoundingClientRect().width || 0;
        reader.querySelector<HTMLElement>('[data-act="outline"]')?.click();
        await waitFor(() => reader.querySelectorAll(".pz-outline-item").length > 0, 6000).catch((): any => undefined);
        await sleep(250);
        const pageWidthWithSide = reader.querySelector<HTMLElement>('.pz-page[data-page="1"]')?.getBoundingClientRect().width || 0;
        step("overlay-side-panel", {pageWidthBeforeSide, pageWidthWithSide});
        if (Math.abs(pageWidthBeforeSide - pageWidthWithSide) > 1) throw new Error("outline panel resized the PDF reading area");
        const outlineItems = Array.from(reader.querySelectorAll<HTMLElement>(".pz-outline-item"));
        step("outline-loaded", {count: outlineItems.length, titles: outlineItems.map(item => (item.textContent || "").trim()).slice(0, 8)});
        const background = outlineItems.find(item => item.dataset.outlinePage && item.dataset.outlinePage !== "1");
        background?.click();
        await sleep(500);
        const outlinePage = reader.querySelector<HTMLInputElement>('[data-role="page"]')?.value;
        const outlineExpected = background?.dataset.outlinePage || "?";
        step("outline-navigated", {expectedPage: outlineExpected, pageInput: outlinePage});

        reader.querySelector<HTMLElement>("[data-side-close]")?.click();
        await sleep(200);
        step("side-closed", {
            open: Boolean(reader.querySelector('[data-role="side"]')?.classList.contains("is-open")),
        });

        const search = reader.querySelector<HTMLInputElement>('[data-role="search"]');
        if (!search) {
            throw new Error("search input missing");
        }
        search.value = "needle";
        search.dispatchEvent(new Event("input", {bubbles: true}));
        await waitFor(() => reader.querySelectorAll(".pz-search-hit").length > 0, 5000);
        const hitCount = reader.querySelectorAll(".pz-search-hit").length;
        const searchCount = reader.querySelector('[data-role="search-count"]')?.textContent || "";
        step("search", {hitCount, searchCount, sideItems: reader.querySelectorAll(".pz-search-item").length});

        reader.querySelector<HTMLElement>('[data-side="annotations"]')?.click();
        await sleep(200);
        const link = Array.from(reader.querySelectorAll<HTMLElement>(".pz-link-box[data-link-page]")).find(item => item.dataset.linkPage && item.dataset.linkPage !== reader.querySelector<HTMLInputElement>('[data-role="page"]')?.value);
        if (!link) {
            throw new Error("internal link box not found");
        }
        const beforeLinkPage = reader.querySelector<HTMLInputElement>('[data-role="page"]')?.value;
        link.click();
        await sleep(500);
        const afterLinkPage = reader.querySelector<HTMLInputElement>('[data-role="page"]')?.value;
        step("internal-link", {beforeLinkPage, afterLinkPage});
        const back = reader.querySelector<HTMLElement>('[data-act="back"]');
        back?.click();
        await sleep(1500);
        const afterBackPage = reader.querySelector<HTMLInputElement>('[data-role="page"]')?.value;
        step("history-back", {afterBackPage});

        const pageBeforeHover = reader.querySelector<HTMLInputElement>('[data-role="page"]')?.value;
        const previewTrigger = plugin.store.state.settings.previewTrigger;
        let hoverShown = false;
        for (let attempt = 0; attempt < 4 && !hoverShown; attempt++) {
            link.dispatchEvent(new MouseEvent("mouseenter", {
                bubbles: false,
                clientX: 90,
                clientY: 300,
                altKey: previewTrigger === "alt",
            }));
            await sleep(700);
            const el = document.querySelector<HTMLElement>(".pz-preview");
            hoverShown = Boolean(el && el.style.display !== "none" && (el.textContent || "").includes("PDF 内部链接"));
            if (!hoverShown) {
                link.dispatchEvent(new MouseEvent("mouseleave", {bubbles: false}));
                await sleep(200);
            }
        }
        const hoverPreview = document.querySelector<HTMLElement>(".pz-preview");
        step("hover-debug", {
            previewTrigger,
            linkConnected: link.isConnected,
            previewCount: document.querySelectorAll(".pz-preview").length,
            display: hoverPreview?.style.display || "",
            text: (hoverPreview?.textContent || "").slice(0, 160),
        });
        if (!hoverShown) {
            throw new Error("hover preview did not become visible");
        }
        const previewText = document.querySelector(".pz-preview")?.textContent || "";
        const pageAfterHover = reader.querySelector<HTMLInputElement>('[data-role="page"]')?.value;
        step("hover-preview", {previewText: previewText.slice(0, 120), pageBeforeHover, pageAfterHover});
        link.dispatchEvent(new MouseEvent("mouseleave", {bubbles: false}));

        // Reset to page 1 then create an annotation and hover it.
        reader.querySelector<HTMLElement>('[data-act="back"]')?.click();
        await sleep(400);
        const readerPage = visibleReader(attachment.id);
        if (!readerPage) {
            throw new Error("reader not visible for annotation");
        }
        await waitFor(() => readerPage.querySelector('.pz-page[data-page="1"] .pz-text-layer span'), 8000);
        document.querySelectorAll(".pz-float").forEach(el => el.remove());
        const selectedText = selectTextOnPage(readerPage, 1);
        const yellowAction = readerPage.querySelector<HTMLElement>('[data-format-color="yellow"]');
        if (!yellowAction) throw new Error("PDF++ yellow selection action is missing");
        yellowAction.click();
        const annotation = await waitFor(() => plugin.store.annotationsForAttachment(attachment.id).find(item => item.page === 1 && item.text.includes(selectedText.slice(0, 20))), 5000);
        step("annotation-created", {annotationId: annotation.id, page: annotation.page, rects: annotation.rects.length});
        const pageEl = readerPage.querySelector<HTMLElement>('.pz-page[data-page="1"]')!;
        const annotationElement = await waitFor(() => pageEl.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(annotation.id)}"]`), 3000);
        const annRect = annotation.rects.reduce((best, rect) =>
            rect.w * rect.h > best.w * best.h ? rect : best, annotation.rects[0]);
        const pageRect = pageEl.getBoundingClientRect();
        const targetX = pageRect.left + annRect.x * pageRect.width + 2;
        const targetY = pageRect.top + annRect.y * pageRect.height + 2;
        // Dispatch on the page/text path rather than the overlay marker to cover
        // real Electron hit-testing where the transparent text layer owns the event.
        pageEl.dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: targetX, clientY: targetY}));
        const redMenuItem = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>(".b3-menu__item, .pz-edit-menu button"))
            .find(item => item.dataset.colorId === "red" || (item.textContent || "").includes("颜色 · 红色")) || null, 3000);
        const hasDeleteAction = Array.from(document.querySelectorAll<HTMLElement>(".b3-menu__item, .pz-edit-menu button"))
            .some(item => item.getAttribute("aria-label")?.includes("删除高亮") || (item.textContent || "").includes("删除高亮"));
        redMenuItem.click();
        await waitFor(() => plugin.store.getAnnotation(annotation.id)?.color === "#ea5252", 3000);
        step("annotation-context-edit", {color: plugin.store.getAnnotation(annotation.id)?.color, hasDeleteAction});
        if (!hasDeleteAction) throw new Error("annotation context menu is missing delete synchronization action");
        // A selection float may still be open after the highlight action; mousedown
        // closes it so the subsequent mousemove can reach the annotation overlay.
        let annotationShown = false;
        for (let attempt = 0; attempt < 5 && !annotationShown; attempt++) {
            pageEl.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
            pageEl.dispatchEvent(new MouseEvent("mousemove", {
                bubbles: true,
                clientX: targetX,
                clientY: targetY,
            }));
            await sleep(700);
            const el = document.querySelector<HTMLElement>(".pz-preview");
            annotationShown = Boolean(el && el.style.display !== "none" && (el.textContent || "").includes(selectedText.slice(0, 10)));
        }
        if (!annotationShown && plugin.store.noteLinksForAnnotation(annotation.id).length) {
            const el = document.querySelector<HTMLElement>(".pz-preview");
            step("annotation-hover-debug", {
                pageRect: {left: pageRect.left, top: pageRect.top, width: pageRect.width, height: pageRect.height},
                annRect,
                targetX,
                targetY,
                floatCount: document.querySelectorAll(".pz-float").length,
                highlightCount: pageEl.querySelectorAll(".pz-highlight").length,
                previewText: (el?.textContent || "").slice(0, 200),
                previewDisplay: el?.style.display || "",
                selectedText: selectedText.slice(0, 40),
                hoverDebug: readerPage.dataset.pzHoverDebug || "",
            });
            throw new Error("annotation hover preview did not become visible");
        }
        const annotationPreview = document.querySelector(".pz-preview")?.textContent || "";
        step("annotation-preview", {previewText: annotationPreview.slice(0, 160), linkedNotes: plugin.store.noteLinksForAnnotation(annotation.id).length});
        if (!plugin.store.noteLinksForAnnotation(annotation.id).length && annotationPreview.includes(selectedText.slice(0, 10))) {
            throw new Error("unlinked PDF text must not be presented as a note preview");
        }

        // Screenshot/rect tools insert into the last focused note. P0 may have
        // left another editor active, so explicitly establish this test doc as
        // the target before returning to the PDF reader.
        void openTab({app: plugin.app, doc: {id: docId}, openNewTab: true, position: "right"});
        const insertionEditor = await waitFor(() => getAllEditor().find(item => item.protyle.block.rootID === docId), 8000);
        insertionEditor.focus();
        insertionEditor.protyle.wysiwyg?.element?.click();
        setCaretAfterText(insertionEditor, "P1 INSERT HERE");
        await sleep(150);
        if (!activateTabByTitle(attachment.fileName.replace(/\.pdf$/i, ""))) {
            throw new Error("reader tab not available before capture tests");
        }
        await waitFor(() => visibleReader(attachment.id), 5000);

        const rectButton = readerPage.querySelector<HTMLElement>('[data-act="rect-link"]');
        if (!rectButton) {
            throw new Error("rectangular selection button missing");
        }
        rectButton?.click();
        step("capture-insertion-target", JSON.parse(readerPage.dataset.pzInsertionTarget || "{}"));
        await waitFor(() => readerPage.querySelector(".pz-pages")?.classList.contains("pz-rect-mode"), 3000);
        const rectPage = readerPage.querySelector<HTMLElement>('.pz-page[data-page="1"]')!;
        const rectPageRect = rectPage.getBoundingClientRect();
        rectPage.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, clientX: rectPageRect.left + 50, clientY: rectPageRect.top + 60}));
        await waitFor(() => readerPage.querySelector(".pz-shot-box"), 3000);
        document.dispatchEvent(new MouseEvent("mousemove", {bubbles: true, clientX: rectPageRect.left + 220, clientY: rectPageRect.top + 170}));
        document.dispatchEvent(new MouseEvent("mouseup", {bubbles: true, clientX: rectPageRect.left + 220, clientY: rectPageRect.top + 170}));
        const generatedRectLink = await waitFor(() => readerPage.dataset.pzLastRectLink || "", 5000);
        let rectClipboard = "";
        try {
            rectClipboard = await navigator.clipboard.readText();
        } catch {
            rectClipboard = "";
        }
        step("rect-selection-link", {
            generated: generatedRectLink,
            clipboard: rectClipboard,
            clipboardWritten: rectClipboard === generatedRectLink,
            hasRect: generatedRectLink.includes("&rect="),
            hasColor: generatedRectLink.includes("&color="),
            hasPdf: generatedRectLink.includes("/pdf?id="),
        });
        if (!generatedRectLink.includes("&rect=") || !generatedRectLink.includes("&color=")) {
            throw new Error("rectangular selection link was not copied");
        }

        // The second capture deliberately uses another color. Both source
        // regions must remain visible on the same page without replacing one another.
        readerPage.querySelector<HTMLElement>('[data-format-color="red"]')?.click();
        const shotButton = readerPage.querySelector<HTMLElement>('[data-act="screenshot"]');
        shotButton?.click();
        await sleep(300);
        const shotPage = readerPage.querySelector<HTMLElement>('.pz-page[data-page="1"]')!;
        const shotRect = shotPage.getBoundingClientRect();
        step("screenshot-mode", {
            active: Boolean(shotButton?.classList.contains("is-active")),
            pageRect: {left: shotRect.left, top: shotRect.top, width: shotRect.width, height: shotRect.height},
        });
        shotPage.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, clientX: shotRect.left + 40, clientY: shotRect.top + 40}));
        await sleep(120);
        const boxAfterDown = readerPage.querySelector<HTMLElement>(".pz-shot-box");
        document.dispatchEvent(new MouseEvent("mousemove", {bubbles: true, clientX: shotRect.left + 180, clientY: shotRect.top + 120}));
        await sleep(120);
        step("screenshot-drag", {
            boxAfterDown: Boolean(boxAfterDown),
            boxWidth: boxAfterDown?.style.width || "",
            boxHeight: boxAfterDown?.style.height || "",
            borderColor: boxAfterDown ? getComputedStyle(boxAfterDown).borderColor : "",
        });
        if (!boxAfterDown || !getComputedStyle(boxAfterDown).borderColor.includes("234, 82, 82")) {
            throw new Error("screenshot selection frame does not match the selected red color");
        }
        document.dispatchEvent(new MouseEvent("mouseup", {bubbles: true, clientX: shotRect.left + 180, clientY: shotRect.top + 120}));
        await sleep(3000);
        const shotRows = await api("/api/query/sql", {
            stmt: `select id, root_id, markdown from blocks where root_id='${docId}' and markdown like '%assets/pz-shot-%' order by updated desc limit 3`,
        });
        const latestShot = (Array.isArray(shotRows) ? shotRows[0] : shotRows?.data?.[0]) || {};
        const shotMarkdown = JSON.stringify(latestShot.markdown || "");
        const decodedShotMarkdown = decodeURIComponent(shotMarkdown);
        step("screenshot", {
            targetDocId: latestShot.root_id || "",
            hasAsset: shotMarkdown.includes("assets/pz-shot-"),
            hasBacklink: decodedShotMarkdown.includes("/pdf?id="),
            clickableImage: shotMarkdown.includes("#pz="),
            hasSeparateTextLink: shotMarkdown.includes("](siyuan://"),
            hasPlainCaption: /\)\s+[^\n{]+p\.\d+/i.test(String(latestShot.markdown || "")),
            hasLegacyColorFrameMetadata: shotMarkdown.includes("pzc="),
            hasSourceHint: decodedShotMarkdown.includes("p.1"),
            sample: shotMarkdown.slice(0, 300),
        });
        if (!shotMarkdown.includes("assets/pz-shot-")) {
            throw new Error("screenshot asset was not inserted in the last note document");
        }
        if (!decodedShotMarkdown.includes("/pdf?id=")) {
            throw new Error("screenshot backlink to the PDF page was not inserted");
        }
        if (!shotMarkdown.includes("#pz=") || shotMarkdown.includes("](siyuan://")) {
            throw new Error("screenshot must store its back-link on the image without a separate text link");
        }
        if (/\)\s+[^\n{]+p\.\d+/i.test(String(latestShot.markdown || "")) || shotMarkdown.includes("pzc=") || !decodedShotMarkdown.includes("p.1")) {
            throw new Error("screenshot must have an image-only source hint and no document color frame");
        }
        const rootKramdown = await api("/api/block/getBlockKramdown", {id: docId});
        const rootMarkdown = String(rootKramdown?.kramdown || "");
        const markerIndex = rootMarkdown.indexOf("P1 INSERT HERE");
        const imageIndex = rootMarkdown.indexOf("assets/pz-shot-");
        const afterIndex = rootMarkdown.indexOf("P1 E2E after");
        const exactCaret = markerIndex >= 0 && imageIndex > markerIndex && afterIndex > imageIndex;
        step("screenshot-caret-position", {markerIndex, imageIndex, afterIndex, exact: exactCaret});
        if (!exactCaret) {
            throw new Error("screenshot was not inserted at the frozen note caret before the following block");
        }
        step("screenshot-mode-exited", {active: Boolean(shotButton?.classList.contains("is-active"))});
        const immediateRegions = Array.from(readerPage.querySelectorAll<HTMLElement>(".pz-screenshot-region"));
        const immediateRegionColors = immediateRegions.map(item => getComputedStyle(item).backgroundColor);
        step("screenshot-regions-immediate", {count: immediateRegions.length, colors: immediateRegionColors});
        if (immediateRegions.length < 2 || !immediateRegionColors.some(color => color.includes("255, 208, 0")) || !immediateRegionColors.some(color => color.includes("234, 82, 82"))) {
            throw new Error("screenshot source regions were not painted immediately");
        }
        immediateRegions[0].dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: 430, clientY: 280}));
        const regionMenuLabels = await waitFor(() => {
            const labels = Array.from(document.querySelectorAll<HTMLElement>(".b3-menu__item, .pz-edit-menu button")).map(item => item.getAttribute("aria-label") || (item.textContent || "").trim());
            return labels.some(label => label.includes("删除截图区域")) ? labels : null;
        }, 3000);
        step("screenshot-region-context-menu", {labels: regionMenuLabels});
        if (!regionMenuLabels.some(label => label === "Red") || !regionMenuLabels.some(label => label.includes("删除截图区域"))) {
            throw new Error("screenshot region context menu is missing color or delete actions");
        }
        readerPage.querySelector<HTMLElement>(".pz-pages")?.click();

        void openTab({app: plugin.app, doc: {id: docId}, openNewTab: true, position: "right"});
        await waitFor(() => getAllEditor().find(item => item.protyle.block.rootID === docId), 8000);
        const linkedImage = await waitFor(() => {
            const blocks = Array.from(document.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(String(latestShot.id || ""))}"]`));
            return blocks.reverse().map(block => block.querySelector<HTMLImageElement>("img")).find(Boolean) || null;
        }, 5000);
        const imageSource = linkedImage.dataset.src || linkedImage.getAttribute("src") || "";
        const linkedImageStyle = getComputedStyle(linkedImage);
        step("screenshot-image-dom", {
            hasEmbeddedBacklink: imageSource.includes("#pz="),
            colorFrameVisible: Number.parseFloat(linkedImageStyle.outlineWidth || "0") >= 1,
            outlineColor: linkedImageStyle.outlineColor,
            title: linkedImage.getAttribute("title") || linkedImage.dataset.title || "",
            imageHtml: linkedImage.parentElement?.outerHTML.slice(0, 1200) || linkedImage.outerHTML,
            blockHtml: linkedImage.closest<HTMLElement>("[data-node-id]")?.outerHTML.slice(0, 1800) || "",
        });
        if (!imageSource.includes("#pz=")) {
            throw new Error("screenshot image back-link missing from editor DOM");
        }
        if (Number.parseFloat(linkedImageStyle.outlineWidth || "0") >= 1) {
            throw new Error("inserted screenshot must not show a color frame in the note");
        }
        const readerCountBeforeJump = document.querySelectorAll(`.pz-reader[data-attachment-id="${CSS.escape(attachment.id)}"]`).length;
        linkedImage.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, view: window}));
        const imageJumpReader = await waitFor(() => {
            const candidate = visibleReader(attachment.id);
            return candidate?.querySelector(".pz-screenshot-region.is-locating") ? candidate : null;
        }, 8000);
        const persistedRegions = Array.from(imageJumpReader.querySelectorAll<HTMLElement>(".pz-screenshot-region"));
        const regionColors = persistedRegions.map(item => getComputedStyle(item).backgroundColor);
        step("screenshot-image-back-jump", {
            clickable: true,
            pageInput: imageJumpReader.querySelector<HTMLInputElement>('[data-role="page"]')?.value,
            attachmentId: imageJumpReader.dataset.attachmentId,
            regionHighlighted: Boolean(imageJumpReader.querySelector(".pz-screenshot-region.is-locating")),
            persistentRegionCount: persistedRegions.length,
            regionColors,
            readerCountBeforeJump,
            readerCountAfterJump: document.querySelectorAll(`.pz-reader[data-attachment-id="${CSS.escape(attachment.id)}"]`).length,
        });
        if (document.querySelectorAll(`.pz-reader[data-attachment-id="${CSS.escape(attachment.id)}"]`).length !== readerCountBeforeJump) {
            throw new Error("image back-jump opened a duplicate PDF reader tab");
        }
        if (persistedRegions.length < 2 || !regionColors.some(color => color.includes("255, 208, 0")) || !regionColors.some(color => color.includes("234, 82, 82"))) {
            throw new Error("same-page screenshot regions with different colors were not persisted independently");
        }

        void openTab({app: plugin.app, doc: {id: docId}, openNewTab: true, position: "right"});
        await sleep(500);
        const noteTargetEditor = await waitFor(() => getAllEditor().find(item => item.protyle.block.rootID === docId), 8000);
        noteTargetEditor.focus();
        noteTargetEditor.protyle.wysiwyg?.element?.click();
        await sleep(150);
        setCaretToEnd(noteTargetEditor);
        await sleep(150);
        const previousLinkFormat = plugin.store.state.settings.linkCopyFormat;
        const previousDisplayFormat = plugin.store.state.settings.displayTextFormat;
        plugin.store.updateSettings({linkCopyFormat: "callout", displayTextFormat: "title-page"});
        await plugin.store.save();
        const inserted = await insertAnnotationNote(plugin.store, annotation, plugin.store.getBook(attachment.bookId));
        if (!inserted) {
            throw new Error("note insertion failed");
        }
        plugin.store.updateSettings({linkCopyFormat: previousLinkFormat, displayTextFormat: previousDisplayFormat});
        await plugin.store.save();
        if (!inserted.blockId) throw new Error("callout insertion did not return a block id");
        const attrsResponse = await fetch("/api/attr/getBlockAttrs", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({id: inserted.blockId}),
        });
        const attrs = (await attrsResponse.json()).data || {};
        if (attrs["custom-pz-callout"] !== "true" || attrs["custom-pz-color"] !== "red") {
            throw new Error(`inserted callout attributes are incomplete: ${JSON.stringify(attrs)}`);
        }
        const calloutBlock = await waitFor(() => document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(inserted.blockId!)}"]`), 5000);
        const calloutParts = Array.from(calloutBlock.querySelectorAll<HTMLElement>(":scope > .p, :scope > div > .p, .callout__title, .callout__content"));
        step("callout-visual-structure", {
            className: calloutBlock.className,
            type: calloutBlock.dataset.type || "",
            html: calloutBlock.outerHTML.slice(0, 1800),
            parts: calloutParts.map(part => ({
                className: part.className,
                text: (part.textContent || "").slice(0, 80),
                background: getComputedStyle(part).backgroundImage !== "none" ? getComputedStyle(part).backgroundImage : getComputedStyle(part).backgroundColor,
                color: getComputedStyle(part).color,
            })),
        });
        step("note-inserted", inserted);
        // Protyle may reuse a paragraph containing an older E2E link; keep this
        // scenario focused on previewing a known linked note block.
        if (!plugin.store.noteLinksForAnnotation(annotation.id).some(link => link.siyuanBlockId === inserted.blockId)) {
            plugin.store.addNoteLink(annotation.id, inserted.blockId, inserted.docId);
            await plugin.store.save();
        }
        activateTabByTitle(attachment.fileName.replace(/\.pdf$/i, ""));
        await sleep(400);
        const reader2 = visibleReader(attachment.id);
        if (!reader2) {
            throw new Error("reader tab not re-activated");
        }
        const notePreviewPage = reader2.querySelector<HTMLElement>('.pz-page[data-page="1"]')!;
        const notePreviewPageRect = notePreviewPage.getBoundingClientRect();
        const linkedAnnotationElement = notePreviewPage.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(annotation.id)}"]`)!;
        linkedAnnotationElement.dispatchEvent(new MouseEvent("mousemove", {
            bubbles: true,
            clientX: notePreviewPageRect.left + annRect.x * notePreviewPageRect.width + 2,
            clientY: notePreviewPageRect.top + annRect.y * notePreviewPageRect.height + 2,
            altKey: plugin.store.state.settings.previewTrigger === "alt",
        }));
        const linkedNotePreview = await waitFor(() => {
            const preview = document.querySelector<HTMLElement>(".pz-preview");
            return preview && (preview.textContent || "").includes("关联笔记") ? preview : null;
        }, 5000).catch(() => {
            throw new Error(`linked note preview missing: ${reader2.dataset.pzNotePreviewDebug || "no-debug"}`);
        });
        step("linked-note-hover-preview", {text: (linkedNotePreview.textContent || "").slice(0, 180)});
        reader2.querySelector<HTMLElement>(".pz-pages")?.dispatchEvent(new MouseEvent("mouseleave", {bubbles: false}));
        await waitFor(() => document.querySelector(".pz-preview") ? null : true, 3000);
        reader2.querySelector<HTMLElement>('[data-side="annotations"]')?.click();
        await sleep(250);
        const noteButton = reader2.querySelector<HTMLElement>("[data-note-block]");
        step("reverse-link-present", {hasButton: Boolean(noteButton), text: noteButton?.textContent || ""});
        noteButton?.click();
        const noteEditor = await waitFor(() => getAllEditor().find(item => item.protyle.block.rootID === inserted.docId), 8000);
        const noteBlock = noteEditor.protyle.wysiwyg?.element?.querySelector(`[data-node-id="${CSS.escape(inserted.blockId)}"]`);
        step("reverse-link-opened", {blockFound: Boolean(noteBlock), noteDocId: inserted.docId});

        // Note -> PDF synchronization: deleting the image block removes only
        // its matching source region after the reconciliation pass.
        activateTabByTitle(attachment.fileName.replace(/\.pdf$/i, ""));
        const syncReader = await waitFor(() => visibleReader(attachment.id), 5000);
        const beforeNoteDelete = syncReader.querySelectorAll(".pz-screenshot-region").length;
        await api("/api/block/deleteBlock", {id: String(latestShot.id)});
        await waitFor(() => {
            const count = syncReader.querySelectorAll(".pz-screenshot-region").length;
            return count === beforeNoteDelete - 1 ? count : null;
        }, 7000);
        const afterNoteDelete = syncReader.querySelectorAll(".pz-screenshot-region").length;
        step("region-sync-note-delete", {before: beforeNoteDelete, after: afterNoteDelete});

        // PDF -> note synchronization goes through the actual region context menu.
        const remainingRegion = syncReader.querySelector<HTMLElement>(".pz-screenshot-region");
        const remainingRegionId = remainingRegion?.dataset.regionId || "";
        if (!remainingRegion) {
            throw new Error("no remaining PDF source region available for delete synchronization test");
        }
        const remainingRecord = (plugin.store.state as any).screenshotRegions?.[remainingRegionId];
        remainingRegion.dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: 260, clientY: 240}));
        const deleteMenuItem = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>(".b3-menu__item, .pz-edit-menu button"))
            .find(item => item.getAttribute("aria-label")?.includes("删除截图区域") || (item.textContent || "").includes("删除截图区域")) || null, 3000);
        deleteMenuItem.click();
        await waitFor(() => syncReader.querySelectorAll(".pz-screenshot-region").length === afterNoteDelete - 1, 5000);
        let linkedBlockExists = false;
        if (remainingRecord?.noteBlockId) {
            const escapedBlockId = String(remainingRecord.noteBlockId).replaceAll("'", "''");
            await waitFor(async () => {
                const rows = await api("/api/query/sql", {stmt: `select id from blocks where id='${escapedBlockId}'`});
                linkedBlockExists = Boolean((Array.isArray(rows) ? rows : rows?.data || []).length);
                return linkedBlockExists ? null : true;
            }, 3000);
        }
        step("region-sync-pdf-delete", {regionId: remainingRegionId, linkedBlockExists});
        if (linkedBlockExists) {
            throw new Error("deleting a PDF source region did not delete its linked note image");
        }

        const debugLogs = (window as any).__pdfZotero?.getLogs?.() || [];
        const logEvents = debugLogs.map((entry: any) => entry.event);
        step("debug-log", {count: debugLogs.length, tail: logEvents.slice(-12)});
        if (!logEvents.includes("screenshot.insert.complete") || !logEvents.includes("image.jump.request") || !logEvents.includes("region.delete.complete")) {
            throw new Error("persistent diagnostics are missing capture, jump, or synchronization events");
        }


        report.ok = true;
        step("done");
        return report;
    } catch (error: any) {
        report.error = error?.stack || error?.message || String(error);
        step("error", {message: error?.message || String(error)});
        return report;
    }
}
