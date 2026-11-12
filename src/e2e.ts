import {getActiveTab, getAllEditor, getAllTabs, openTab} from "siyuan";
import {annotationHref} from "./anchor";
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

/** The active custom tab is the only reader with non-zero layout size. */
function visibleReader(attachmentId: string): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>(".pz-reader")).find(reader => {
        if (reader.dataset.attachmentId !== attachmentId) {
            return false;
        }
        const rect = reader.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }) || null;
}

function tabDiagnostics(): any {
    let activeTitle = "";
    try {
        activeTitle = getActiveTab()?.title || "";
    } catch {
        // ignore
    }
    return {
        activeTitle,
        documentReaders: Array.from(document.querySelectorAll<HTMLElement>(".pz-reader")).map(reader => {
            const rect = reader.getBoundingClientRect();
            return {attachmentId: reader.dataset.attachmentId, width: Math.round(rect.width), height: Math.round(rect.height)};
        }),
    };
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
    const spans = Array.from(page.querySelectorAll<HTMLElement>(".pz-text-layer span"))
        .filter(span => {
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
    range.setEnd(secondNode, Math.min(40, secondNode.textContent?.length || 1));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const pages = reader.querySelector<HTMLElement>(".pz-pages");
    pages?.dispatchEvent(new MouseEvent("mouseup", {bubbles: true, clientX: 100, clientY: 100}));
    return range.toString();
}

export interface P0E2EReport {
    ok: boolean;
    at: string;
    steps: Array<{name: string; at: string; data?: any}>;
    error?: string;
}

export async function runP0E2E(
    plugin: PdfZoteroPlugin,
    onProgress?: (report: P0E2EReport) => Promise<void>,
): Promise<P0E2EReport> {
    const report: P0E2EReport = {ok: false, at: new Date().toISOString(), steps: []};
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
            throw new Error("window.require('fs') unavailable: cannot read external PDF");
        }

        const notebooks = await api("/api/notebook/lsNotebooks", {});
        const opened = (notebooks.notebooks || []).filter((notebook: any) => !notebook.closed);
        if (!opened.length) {
            throw new Error("no open notebook");
        }
        const notebookId = opened[0].id;
        const docPath = `/p0-e2e-${Date.now()}`;
        const docId = await api("/api/filetree/createDocWithMd", {
            notebook: notebookId,
            path: docPath,
            markdown: "P0 E2E target document\n",
        });
        const docTitle = docPath.split("/").pop() || "p0-e2e";
        step("doc-created", {docId, notebookId, docTitle});
        void openTab({app: plugin.app, doc: {id: docId}, openNewTab: true, position: "right"});
        const editor = await waitFor(() => getAllEditor().find(item => item.protyle.block.rootID === docId), 15000);
        step("editor-opened", {rootID: editor.protyle.block.rootID});

        const pdfPath = localStorage.getItem("pdf-zotero-e2e-pdf")
            || "F:\\study\\VStudio\\SiYuanArticleManger\\test-fixtures\\sample-paper.pdf";
        // Unique path/attachment per run: old reader tabs from prior runs must not shadow the new one.
        const uniquePath = pdfPath.replace(/\.pdf$/i, `-e2e-${Date.now()}.pdf`);
        const fs = requireNode("fs");
        if (!fs?.copyFileSync) {
            throw new Error("Node fs unavailable for E2E fixture copy");
        }
        fs.copyFileSync(pdfPath, uniquePath);
        // Old reader tabs hold PDF.js documents/workers; close them so this run has one clean reader.
        let closedReaders = 0;
        for (const tab of getAllTabs()) {
            if (String(tab.title || "").includes("sample-paper")) {
                try {
                    tab.close();
                    closedReaders++;
                } catch {
                    // keep going
                }
            }
        }
        await sleep(500);
        step("readers-closed", {closedReaders, remaining: document.querySelectorAll(".pz-reader").length});
        const attachment = await plugin.importLocalPath(uniquePath);
        if (!attachment) {
            throw new Error(`failed to import PDF: ${pdfPath}`);
        }
        step("pdf-imported", {
            attachmentId: attachment.id,
            path: attachment.path,
            size: attachment.size,
            fingerprint: attachment.fingerprint,
        });
        await plugin.openAttachmentAsync(attachment, 1);
        await sleep(600);
        step("tab-diagnostics", tabDiagnostics());
        const reader = await waitFor(() => visibleReader(attachment.id), 15000);
        const readerTabActivated = Boolean(reader);
        await sleep(300);
        await waitFor(() => reader.querySelector(".pz-page"), 20000);
        let selectionPage = 2;
        try {
            await waitFor(() => reader.querySelector('.pz-page[data-page="2"] .pz-text-layer span'), 8000);
        } catch {
            selectionPage = 1;
        }
        step("pdf-rendered", {
            pages: reader.querySelectorAll(".pz-page").length,
            hasTextLayer: Boolean(reader.querySelector(".pz-text-layer")),
            page2SpanCount: reader.querySelectorAll('.pz-page[data-page="2"] .pz-text-layer span').length,
            page1SpanCount: reader.querySelectorAll('.pz-page[data-page="1"] .pz-text-layer span').length,
            selectionPage,
            readerTabActivated,
        });

        document.querySelectorAll(".pz-float").forEach(element => element.remove());
        step("selection-begin", {readerTabActive: document.visibilityState, selectionPage});
        const selectedText = selectTextOnPage(reader, selectionPage);
        step("selection-dispatched", {selectedText: selectedText.slice(0, 80), debug: reader.dataset.pzSelectionDebug || ""});
        const float = await waitFor(
            () => document.querySelector<HTMLElement>(`.pz-float[data-attachment-id="${CSS.escape(attachment.id)}"]`),
            5000,
        );
        step("text-selected", {selectedText: selectedText.slice(0, 120), floatVisible: Boolean(float)});
        const highlightButton = float.querySelector<HTMLElement>('[data-act="highlight"]');
        if (!highlightButton) {
            throw new Error("highlight button missing in floating toolbar");
        }
        highlightButton.click();
        let annotation;
        try {
            annotation = await waitFor(() => {
                const list = plugin.store.annotationsForAttachment(attachment.id);
                return list.find(item => item.page === selectionPage && item.text.includes(selectedText.slice(0, 20)));
            }, 5000);
        } catch (error) {
            throw new Error(`highlight click did not create annotation; float=${Boolean(document.querySelector(".pz-float"))}, count=${plugin.store.annotationsForAttachment(attachment.id).length}, selectionDebug=${reader.dataset.pzSelectionDebug || "empty"}`);
        }
        step("annotation-created", {
            annotationId: annotation.id,
            page: annotation.page,
            rects: annotation.rects,
            color: annotation.color,
        });

        const docTabActivated = activateTabByTitle(docTitle);
        await sleep(400);
        setCaretToEnd(editor);
        await sleep(200);
        const inserted = await insertAnnotationNote(plugin.store, annotation, plugin.store.getBook(attachment.bookId));
        if (!inserted) {
            throw new Error("insertAnnotationNote returned null");
        }
        step("note-inserted", {...inserted, docTabActivated});
        const href = annotationHref(annotation.id);
        const kramdown = await api("/api/block/getBlockKramdown", {id: inserted.blockId});
        const kramdownText = String(kramdown.kramdown || "");
        step("note-link-verified", {href, blockId: inserted.blockId, containsHref: kramdownText.includes(href)});
        if (!kramdownText.includes(href)) {
            throw new Error("inserted note block does not contain structured annotation link");
        }

        const stored = await plugin.loadData("state-v1");
        const persistedAnnotation = stored?.annotations?.[annotation.id];
        const persistedLink = Object.values(stored?.noteLinks || {}).find((link: any) => link.annotationId === annotation.id);
        step("persistence-readback", {
            annotationFound: Boolean(persistedAnnotation),
            linkFound: Boolean(persistedLink),
            page: persistedAnnotation?.page,
        });
        if (!persistedAnnotation || !persistedLink) {
            throw new Error("plugin storage readback missing annotation or note link");
        }

        const readersBefore = document.querySelectorAll(".pz-reader").length;
        activateTabByTitle(docTitle);
        await sleep(300);
        setCaretToEnd(editor);
        await sleep(150);
        const anchor = document.querySelector<HTMLElement>(`[data-href="${CSS.escape(href)}"]`);
        if (!anchor) {
            throw new Error("inserted annotation anchor not found in editor DOM");
        }
        anchor.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, view: window}));
        let clickTriggered = true;
        try {
            await waitFor(() => document.querySelectorAll(".pz-reader").length > readersBefore, 4000);
        } catch {
            clickTriggered = false;
            plugin.eventBus.emit("open-siyuan-url-plugin", {url: href});
        }
        await sleep(1500);
        step("back-jump-after-click", {
            clickTriggered,
            activeTitle: (() => {
                try {
                    return getActiveTab()?.title || "";
                } catch {
                    return "";
                }
            })(),
            readers: Array.from(document.querySelectorAll<HTMLElement>(".pz-reader")).map(item => {
                const rect = item.getBoundingClientRect();
                return {
                    attachmentId: item.dataset.attachmentId,
                    visible: rect.width > 0 && rect.height > 0,
                    pageInput: item.querySelector<HTMLInputElement>('[data-role="page"]')?.value,
                };
            }),
        });
        const jumped = await waitFor(() => {
            const readers = Array.from(document.querySelectorAll<HTMLElement>(".pz-reader"));
            return readers.find(item => {
                const pageInput = item.querySelector<HTMLInputElement>('[data-role="page"]');
                return item.dataset.attachmentId === attachment.id && pageInput?.value === String(selectionPage);
            });
        }, 20000);
        const jumpedRect = jumped.getBoundingClientRect();
        step("back-jump", {
            clickTriggered,
            openedReaderCount: document.querySelectorAll(".pz-reader").length,
            expectedPage: selectionPage,
            pageInput: jumped.querySelector<HTMLInputElement>('[data-role="page"]')?.value,
            visible: jumpedRect.width > 0 && jumpedRect.height > 0,
            hasExpectedPage: Boolean(jumped.querySelector(`.pz-page[data-page="${selectionPage}"]`)),
        });

        report.ok = true;
        step("done");
        return report;
    } catch (error: any) {
        report.error = error?.stack || error?.message || String(error);
        step("error", {message: error?.message || String(error)});
        return report;
    }
}
