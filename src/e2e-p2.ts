import {getAllEditor, openTab} from "siyuan";
import type PdfZoteroPlugin from "./index";
import {deleteCitation, insertCitation, refreshDocumentCitations, setDocumentCitationStyle, updateCitation} from "./citations";
import {e2eSleep as sleep} from "./e2e-utils";
import {fileExists} from "./runtime";

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 15000, interval = 150): Promise<T> {
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

async function api(path: string, payload: Record<string, any> = {}): Promise<any> {
    const token = String((window as any).siyuan?.config?.api?.token || "");
    const response = await fetch(path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token ? {Authorization: `Token ${token}`} : {}),
        },
        body: JSON.stringify(payload),
    });
    const json = await response.json();
    if (json.code !== 0) {
        throw new Error(`${path} failed: code=${json.code} msg=${json.msg}`);
    }
    return json.data;
}

async function docKramdown(docId: string): Promise<string> {
    const data = await api("/api/block/getBlockKramdown", {id: docId});
    return String(data?.kramdown || "");
}

function setCaretToEnd(editor: any): void {
    const root = editor.protyle.wysiwyg?.element as HTMLElement | undefined;
    if (!root) {
        throw new Error("editor unavailable");
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

export interface P2E2EReport {
    ok: boolean;
    at: string;
    steps: Array<{name: string; at: string; data?: any}>;
    error?: string;
}

export async function runP2E2E(plugin: PdfZoteroPlugin, onProgress?: (report: P2E2EReport) => Promise<void>): Promise<P2E2EReport> {
    const report: P2E2EReport = {ok: false, at: new Date().toISOString(), steps: []};
    const step = (name: string, data?: any) => {
        report.steps.push({name, at: new Date().toISOString(), data});
        void onProgress?.(JSON.parse(JSON.stringify(report)));
    };
    try {
        await plugin.refreshZotero(true);
        const items = plugin.store.state.zotero.items.filter(item => item.csl);
        if (items.length < 2) {
            throw new Error(`Zotero 缓存不足（csl items=${items.length}）`);
        }
        const first = items.find(item => item.key === "K3WY8RWM") || items[0];
        const second = items.find(item => item.key !== first.key)!;
        step("zotero-cache", {
            items: items.length,
            collections: plugin.store.state.zotero.collections.length,
            first: {key: first.key, title: first.title, type: first.csl?.type},
            second: {key: second.key, title: second.title, type: second.csl?.type},
        });

        const notebooks = await api("/api/notebook/lsNotebooks", {});
        const opened = (notebooks.notebooks || []).filter((notebook: any) => !notebook.closed);
        const docPath = `/p2-e2e-${Date.now()}`;
        const docId = await api("/api/filetree/createDocWithMd", {
            notebook: opened[0].id,
            path: docPath,
            markdown: "这是一段用于 P2 引文测试的正文。\n",
        });
        const docTitle = docPath.split("/").pop() || "p2-e2e";
        step("doc-created", {docId, docTitle});
        void openTab({app: plugin.app, doc: {id: docId}, openNewTab: true, position: "right"});
        const editor = await waitFor(() => getAllEditor().find(item => item.protyle.block.rootID === docId), 15000);
        step("editor-opened", {rootID: editor.protyle.block.rootID});

        plugin.openCitationDialog();
        plugin.openCitationDialog();
        const dialog = await waitFor(() => document.querySelector<HTMLElement>(".pz-citation-dialog"), 5000);
        step("citation-dialog", {
            dialogCount: document.querySelectorAll(".pz-citation-dialog").length,
            resultCount: dialog.querySelectorAll(".pz-citation-result").length,
            styleOptions: dialog.querySelectorAll('[data-role="citation-style"] option').length,
            hasSearch: Boolean(dialog.querySelector('[data-role="citation-search"]')),
            hasLocator: Boolean(dialog.querySelector('[data-role="citation-locator"]')),
        });
        if (document.querySelectorAll(".pz-citation-dialog").length !== 1) {
            throw new Error("repeated citation commands opened stacked dialogs");
        }
        dialog.closest<HTMLElement>(".b3-dialog")?.querySelector<HTMLElement>('[data-act="citation-cancel"]')?.click();
        await waitFor(() => document.querySelectorAll(".pz-citation-dialog").length === 0, 3000);

        const zoteroOffline = Boolean(plugin.store.state.zotero.lastError);
        const multiAttachmentItem = plugin.store.state.zotero.items.find(item => item.key === "B68RNBTV");
        if (multiAttachmentItem && !zoteroOffline) {
            void plugin.openZoteroItem(multiAttachmentItem.key);
            const choices = await waitFor(() => {
                const nodes = document.querySelectorAll<HTMLElement>("[data-attachment-choice]");
                return nodes.length ? nodes : null;
            }, 8000);
            step("multi-attachment-chooser", {
                key: multiAttachmentItem.key,
                choiceCount: choices.length,
            });
            if (choices.length < 2) {
                throw new Error(`expected >=2 attachment choices, got ${choices.length}`);
            }
            choices[0].click();
            const openedAttachment = await waitFor(() => Object.values(plugin.store.state.attachments)
                .find(attachment => attachment.zotero?.itemKey === multiAttachmentItem.key), 15000);
            const openedReader = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>(".pz-reader"))
                .find(reader => reader.dataset.attachmentId === openedAttachment.id && reader.querySelector(".pz-page")) || null, 30000);
            step("zotero-pdf-opened", {
                attachmentId: openedAttachment.id,
                path: openedAttachment.path,
                pages: openedReader.querySelectorAll(".pz-page").length,
            });
            void openTab({app: plugin.app, doc: {id: docId}, openNewTab: true, position: "right"});
            await waitFor(() => getAllEditor().find(item => item.protyle.block.rootID === docId), 8000);
            editor.focus();
            editor.protyle.wysiwyg?.element?.click();
            await sleep(200);
        } else if (zoteroOffline) {
            const cachedAttachment = Object.values(plugin.store.state.attachments)
                .find(attachment => attachment.source === "zotero" && fileExists(attachment.path));
            step("zotero-offline-cache", {
                status: cachedAttachment ? "passed" : "not-testable",
                error: plugin.store.state.zotero.lastError,
                cachedItems: items.length,
                cachedCollections: plugin.store.state.zotero.collections.length,
                localPdfAvailable: Boolean(cachedAttachment),
                attachmentId: cachedAttachment?.id || "",
                reason: cachedAttachment ? "" : "当前缓存中没有仍存在的已关联 Zotero PDF，需在 Zotero 在线时先打开一次附件",
            });
        }

        setCaretToEnd(editor);
        const c1 = await insertCitation(plugin.store, [first.key], "gbt7714", {locator: "12"});
        if (!c1) {
            throw new Error("insert first citation failed");
        }
        await sleep(700);
        let kramdown = await docKramdown(docId);
        step("citation-1", {
            id: c1.id,
            visible: plugin.store.state.citations[c1.id]?.visibleHtml,
            hasHref: kramdown.includes("citation?id="),
            hasReferences: kramdown.includes("参考文献"),
            sample: kramdown.slice(0, 600),
        });

        setCaretToEnd(editor);
        const c2 = await insertCitation(plugin.store, [second.key], "gbt7714", {});
        if (!c2) {
            throw new Error("insert second citation failed");
        }
        await sleep(800);
        kramdown = await docKramdown(docId);
        step("citation-2", {
            id: c2.id,
            visible: plugin.store.state.citations[c2.id]?.visibleHtml,
            hrefCount: (kramdown.match(/citation\?id=/g) || []).length,
        });

        const refreshed = await refreshDocumentCitations(plugin.store, docId);
        kramdown = await docKramdown(docId);
        step("refresh-gbt", {
            citationCount: refreshed.citationCount,
            style: refreshed.style,
            refs: refreshed.references.slice(0, 2),
            hasTitle1: kramdown.includes(String(first.csl?.title || first.title).slice(0, 20)),
            unresolved: kramdown.includes("[?]"),
            debug: refreshed.debug,
        });
        if (refreshed.citationCount !== 2) {
            throw new Error(`expected 2 citations, got ${refreshed.citationCount}`);
        }
        if (kramdown.includes("[?]")) {
            throw new Error("citation visible text still contains [?] after refresh");
        }
        if (!refreshed.references.some(entry => entry.includes(String(first.csl?.title || first.title).slice(0, 12)))) {
            throw new Error("GB/T bibliography missing first item title");
        }

        await setDocumentCitationStyle(plugin.store, docId, "apa");
        await sleep(900);
        const apaKramdown = await docKramdown(docId);
        const apaVisible = Object.values(plugin.store.state.citations).filter(c => c.siyuanDocId === docId).map(c => c.visibleHtml);
        step("style-apa", {
            visible: apaVisible,
            hasParen: apaKramdown.includes("("),
            refsContainsAuthor: apaKramdown.includes("Valipour") || apaKramdown.includes("Foudazi"),
            unresolved: apaKramdown.includes("[?]"),
            sample: apaKramdown.slice(0, 700),
        });
        if (apaKramdown.includes("[?]")) {
            throw new Error("APA refresh left [?] in document");
        }
        if (!apaVisible.some(text => text.includes("Valipour"))) {
            throw new Error("APA visible citation missing author");
        }

        await updateCitation(plugin.store, c1.id, {
            options: {locator: "12", prefix: "see", suffix: "for details", suppressAuthor: false},
        });
        await refreshDocumentCitations(plugin.store, docId);
        await sleep(500);
        const optionsVisible = plugin.store.state.citations[c1.id]?.visibleHtml || "";
        step("citation-options", {visible: optionsVisible});
        if (!optionsVisible.includes("see") || !optionsVisible.includes("for details")) {
            throw new Error(`prefix/suffix not rendered: ${optionsVisible}`);
        }

        await updateCitation(plugin.store, c1.id, {
            options: {prefix: "", suffix: "", suppressAuthor: true},
        });
        await refreshDocumentCitations(plugin.store, docId);
        await sleep(500);
        const suppressedVisible = plugin.store.state.citations[c1.id]?.visibleHtml || "";
        step("citation-suppress-author", {visible: suppressedVisible});
        if (suppressedVisible.includes("Valipour")) {
            throw new Error(`suppress-author failed: ${suppressedVisible}`);
        }

        await setDocumentCitationStyle(plugin.store, docId, "ieee");
        await sleep(800);
        let ieeeKramdown = await docKramdown(docId);
        const ieeeVisible = Object.values(plugin.store.state.citations).filter(c => c.siyuanDocId === docId).map(c => c.visibleHtml);
        step("style-ieee", {
            visible: ieeeVisible,
            refsContainsSoftMatter: ieeeKramdown.includes("Soft Matter"),
            unresolved: ieeeKramdown.includes("[?]"),
        });
        if (ieeeKramdown.includes("[?]")) {
            throw new Error("IEEE refresh left [?] in document");
        }
        if (!ieeeVisible.some(text => /\[1[,\]]/.test(text))) {
            throw new Error(`IEEE numeric citation missing: ${ieeeVisible.join(" | ")}`);
        }

        setCaretToEnd(editor);
        const c3 = await insertCitation(plugin.store, [first.key, second.key], "ieee", {});
        if (!c3) {
            throw new Error("insert multi-item citation failed");
        }
        await refreshDocumentCitations(plugin.store, docId);
        await sleep(700);
        const multiVisible = plugin.store.state.citations[c3.id]?.visibleHtml || "";
        step("citation-multi-item", {
            visible: multiVisible,
            citationCount: Object.values(plugin.store.state.citations).filter(c => c.siyuanDocId === docId).length,
        });
        if (!multiVisible.includes("1") || !multiVisible.includes("2")) {
            throw new Error(`multi-item numeric citation missing numbers: ${multiVisible}`);
        }

        await deleteCitation(plugin.store, c3.id);
        await deleteCitation(plugin.store, c2.id);
        await sleep(900);
        const afterDelete = await docKramdown(docId);
        const hrefCount = (afterDelete.match(/citation\?id=/g) || []).length;
        step("delete-citation", {
            remainingCitations: Object.values(plugin.store.state.citations).filter(c => c.siyuanDocId === docId).length,
            hrefCount,
        });
        if (hrefCount !== 1) {
            throw new Error(`expected 1 citation link after delete, got ${hrefCount}`);
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
