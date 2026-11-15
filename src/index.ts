import {Dialog, getActiveEditor, getFrontend, getAllEditor, getAllTabs, openTab, Plugin, Setting, showMessage} from "siyuan";
import {parsePluginUrl} from "./anchor";
import {DOCK_TYPE, HIGHLIGHT_COLORS, PLUGIN_DISPLAY_NAME, PLUGIN_NAME, TAB_TYPE, VERSION} from "./constants";
import {applyPdfCalloutAttributes, stylePdfCalloutDom} from "./notes";
import {PreviewManager} from "./ui/preview";
import {openCitationDialog} from "./ui/citation-dialog";
import {insertCitation, refreshDocumentCitations} from "./citations";
import type {NoteInsertionTarget, PluginHost} from "./host";
import {detectZoteroDataDir, fileExists, hasNodeFs, pluginAssetUrl, readFileBytes, requireNode} from "./runtime";
import {openSettings, renderDock} from "./ui/dock";
import {PdfReader} from "./ui/reader";
import {CSS} from "./ui/styles";
import {PdfZoteroService} from "./service";
import {Store} from "./storage";
import type {PdfAttachment, ReaderOpenData} from "./types";
import {pickPdfFile} from "./pdf/source";
import {pdfjsLib} from "./pdf/pdfjs";
import {ZoteroClient} from "./zotero/client";
import {syncTranslationHistory} from "./translation/history";
import {readClipboardImage} from "./ocr/capture";
import {recognizeImage} from "./ocr/client";
import {ensureOcrServer} from "./ocr/service";
import {openOcrResultDialog} from "./ui/ocr-dialog";
import {applyQaBlockTheme, repairQaBlockAttributes} from "./qa/theme";
import {NotebookAutomation} from "./automation/service";

const ICON_ID = "iconPdfZotero";
const STYLE_ID = "pdf-zotero-style";

/**
 * One-shot maintenance before a plugin reload.
 *
 * The kernel releases the workspace when the plugin unloads, so a journaled-asset
 * sweep queued here runs while files are still accessible and survives the reload.
 */
const MAINTENANCE_KEY = "asset-sweep-requested";

async function runQueuedAssetSweep(plugin: PdfZoteroPlugin): Promise<void> {
    try {
        const flag = await plugin.loadData(MAINTENANCE_KEY);
        if (!flag?.run) {
            return;
        }
        await plugin.removeData(MAINTENANCE_KEY).catch((): void => undefined);
        const {sweepUnreferencedAssets, writeAssetJournal} = await import("./asset-journal");
        const result = await sweepUnreferencedAssets();
        await writeAssetJournal(result.skipped);
        await plugin.saveData("asset-sweep-report", {
            at: new Date().toISOString(),
            removed: result.removed,
            skipped: result.skipped,
        });
    } catch (error: any) {
        console.warn("[pdf-zotero] asset sweep failed", error?.message || error);
    }
}

export default class PdfZoteroPlugin extends Plugin implements PluginHost {
    store!: Store;
    private service!: PdfZoteroService;
    private dockElement: HTMLElement | null = null;
    private registeredDock: any = null;
    private styleElement: HTMLStyleElement | null = null;
    private notePreview = new PreviewManager();
    private citationDialog: Dialog | null = null;
    private citationDialogId = "";
    private attachmentDialog: Dialog | null = null;
    private zoteroRefreshPromise: Promise<void> | null = null;
    private zoteroOpenItems = new Set<string>();
    private automation: NotebookAutomation | null = null;
    private unloading = false;
    private readonly onBeforeUnload = (): void => {
        this.unloading = true;
    };
    private lastNotePreviewHref = "";
    private readers = new Set<PdfReader>();
    private activeReaderAttachmentId = "";
    private toolbarHostAttachmentId = "";
    private readerRestorePromise: Promise<void> | null = null;
    private openingAttachmentIds = new Set<string>();
    private lastNoteDocId = "";
    private lastNoteRange: Range | null = null;
    private lastNoteBlockId = "";
    private lastNoteTextOffset = 0;
    private lastNoteTrackedHandle: {readonly id: string} | null = null;
    private lastNoteTrackedEditor: any = null;
    private debugLogs: Array<{at: string; level: string; event: string; data: Record<string, unknown>}> = [];
    private calloutObserver: MutationObserver | null = null;
    private calloutStyleTimer = 0;
    private citationRefreshTimer = 0;
    private citationRefreshGuardUntil = 0;
    private readonly onPastePdfCallout = (event: ClipboardEvent): void => {
        const markdown = event.clipboardData?.getData("text/plain") || "";
        if (!/^> \[!PDF\|/m.test(markdown)) return;
        const match = markdown.match(/siyuan:\/\/plugins\/siyuan-pdf-zotero\/annotation\?id=([^\s)]+)/);
        if (!match) return;
        const annotationId = decodeURIComponent(match[1]);
        const annotation = this.store.getAnnotation(annotationId);
        if (!annotation) return;
        const editor = getActiveEditor() || getAllEditor()[0];
        const root = editor?.protyle?.wysiwyg?.element as HTMLElement | undefined;
        if (!root) return;
        const before = new Set(Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]")).map(item => item.dataset.nodeId || ""));
        window.setTimeout((): void => {
            void (async () => {
                const href = `siyuan://plugins/${this.name}/annotation?id=${encodeURIComponent(annotationId)}`;
                const link = Array.from(root.querySelectorAll<HTMLElement>(`[data-href="${window.CSS.escape(href)}"]`)).at(-1);
                if (!link) return;
                let block = link.closest<HTMLElement>('[data-type="NodeCallout"],.bq');
                const containing = link.closest<HTMLElement>("[data-node-id]");
                if (!block && containing?.dataset.nodeId && !before.has(containing.dataset.nodeId)) {
                    const response = await fetch("/api/block/updateBlock", {
                        method: "POST",
                        headers: {"Content-Type": "application/json"},
                        body: JSON.stringify({id: containing.dataset.nodeId, dataType: "markdown", data: markdown}),
                    });
                    const result = await response.json();
                    if (!response.ok || result.code !== 0) return;
                    await new Promise(resolve => setTimeout(resolve, 180));
                    const refreshed = root.querySelector<HTMLElement>(`[data-node-id="${window.CSS.escape(containing.dataset.nodeId)}"]`);
                    block = refreshed?.matches('[data-type="NodeCallout"],.bq') ? refreshed : refreshed?.querySelector('[data-type="NodeCallout"],.bq') || null;
                }
                block ||= containing;
                const blockId = block?.dataset.nodeId || "";
                if (!blockId) return;
                const colorId = HIGHLIGHT_COLORS.find(item => item.value.toLowerCase() === annotation.color.toLowerCase())?.id || "yellow";
                const kind = /\n>\s*>/.test(markdown) ? "quote" : "PDF";
                await applyPdfCalloutAttributes(blockId, kind, colorId);
                block?.setAttribute("custom-pz-callout", "true");
                block?.setAttribute("custom-pz-color", colorId);
                block?.setAttribute("custom-callout", kind);
                const docId = String(editor.protyle.block.rootID || "");
                if (docId) {
                    this.store.addNoteLink(annotationId, blockId, docId);
                    await this.store.save();
                }
                this.logDebug("callout.paste.upgraded", {annotationId, blockId, colorId, kind});
            })();
        }, 320);
    };
    private rememberNoteSelection(): void {
        const selection = document.getSelection();
        if (!selection?.rangeCount) {
            return;
        }
        const range = selection.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
        const owner = getAllEditor().find(editor =>
            Boolean(element && editor.protyle?.wysiwyg?.element?.contains(element)));
        const docId = String(owner?.protyle?.block?.rootID || "");
        if (docId) {
            if (this.lastNoteTrackedHandle && this.lastNoteTrackedEditor) {
                try {
                    this.lastNoteTrackedEditor.protyle.releaseTrackedRange(this.lastNoteTrackedHandle);
                } catch {
                    // The previous editor may already have been destroyed.
                }
            }
            this.lastNoteDocId = docId;
            this.lastNoteRange = range.cloneRange();
            try {
                this.lastNoteTrackedHandle = owner.trackRange(range, {owner: this, affinity: "after"});
                this.lastNoteTrackedEditor = owner;
            } catch {
                this.lastNoteTrackedHandle = null;
                this.lastNoteTrackedEditor = null;
            }
            const block = element?.closest<HTMLElement>("[data-node-id]");
            this.lastNoteBlockId = block?.dataset.nodeId || "";
            this.lastNoteTextOffset = 0;
            if (block) {
                try {
                    const prefix = document.createRange();
                    prefix.selectNodeContents(block);
                    prefix.setEnd(range.startContainer, range.startOffset);
                    this.lastNoteTextOffset = prefix.toString().length;
                } catch {
                    this.lastNoteTextOffset = 0;
                }
            }
        }
    }
    private readonly onFocusIn = (event: FocusEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target?.closest?.(".protyle")) {
            return;
        }
        // getActiveEditor() can lag while switching tabs; locate the editor that
        // actually contains the focus target.
        const owner = getAllEditor().find(editor =>
            Boolean(editor.protyle?.wysiwyg?.element?.contains(target)));
        const docId = String(owner?.protyle?.block?.rootID
            || getActiveEditor()?.protyle?.block?.rootID
            || "");
        if (docId) {
            this.lastNoteDocId = docId;
            queueMicrotask(() => this.rememberNoteSelection());
        }
    };

    async onload(): Promise<void> {
        const report: any = {
            stage: "onload-start",
            at: new Date().toISOString(),
            href: window.location.href,
            frontend: getFrontend(),
        };
        try {
            if (getFrontend() === "mobile" || getFrontend() === "browser-mobile") {
                showMessage("PDF × Zotero P0 仅支持桌面端");
                report.stage = "mobile-skip";
                return;
            }
            this.addIcons(`<symbol id="${ICON_ID}" viewBox="0 0 32 32">
<path d="M6 3h13l7 7v19H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"></path>
<path d="M19 3v7h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"></path>
<path d="M10 17h7M10 21h10M10 25h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
</symbol>`);
            this.store = new Store(this);
            await this.store.load();
            await this.loadDebugLogs();
            report.storageLoaded = true;
            try {
                const hardReload = await this.loadData("hard-reload");
                if (hardReload?.run) {
                    await this.removeData("hard-reload");
                    report.stage = "hard-reload";
                    await this.saveReport("p0-load-report", report);
                    window.setTimeout(() => window.location.reload(), 300);
                    return;
                }
            } catch {
                // no hard reload requested
            }
            const detected = this.store.state.settings.zoteroDataDir || detectZoteroDataDir();
            if (detected && !this.store.state.settings.zoteroDataDir) {
                this.store.updateSettings({zoteroDataDir: detected});
                await this.store.save();
            }
            this.service = new PdfZoteroService(this);
            // Register a Setting instance so SiYuan shows the settings button in
            // the plugin management list. The actual UI is the plugin dialog.
            this.setting = new Setting({});
            this.injectStyles();
            this.registerTab();
            this.registerDock();
            this.registerCommands();
            this.eventBus.on("open-siyuan-url-plugin", this.handlePluginUrl);
            this.eventBus.on("ws-main", this.onWsMain);
            this.eventBus.on("loaded-protyle-static", this.onProtyleLoaded);
            this.exposeDiagnostics();
            report.stage = "onload-ok";
            report.dockRegistered = Boolean(this.registeredDock);
            report.tabRegistered = true;
        } catch (error: any) {
            report.stage = "onload-error";
            report.error = error?.stack || error?.message || String(error);
            console.error("[pdf-zotero] onload failed", error);
            throw error;
        } finally {
            await this.saveReport("p0-load-report", report);
        }
    }

    async onLayoutReady(): Promise<void> {
        try {
            this.removeOrphanCitationDialogs();
            this.addTopBar({
                id: "pdf-zotero-open",
                icon: ICON_ID,
                title: `${PLUGIN_DISPLAY_NAME} · 打开本地 PDF`,
                position: "right",
                callback: () => {
                    void this.importLocalPdfFromPicker();
                },
            });
            document.addEventListener("mouseover", this.onNoteLinkHover);
            document.addEventListener("mouseout", this.onNoteLinkOut);
            document.addEventListener("focusin", this.onFocusIn, true);
            document.addEventListener("click", this.onLinkedImageClick, true);
            document.addEventListener("click", this.onFocusIn, true);
            document.addEventListener("selectionchange", this.rememberNoteSelectionBound);
            document.addEventListener("paste", this.onPastePdfCallout, true);
            document.addEventListener("click", this.onSharedToolbarClick, true);
            window.addEventListener("beforeunload", this.onBeforeUnload);
            const initialEditor = getActiveEditor() || getAllEditor()[0];
            this.lastNoteDocId = String(initialEditor?.protyle?.block?.rootID || "");
            void this.upgradeExistingPdfCallouts();
            this.startCalloutObserver();
            this.restartAutomation();
            this.refreshDock();
            const diagnostics = await this.collectDiagnostics();
            await this.saveReport("p0-ready-report", {
                at: new Date().toISOString(),
                diagnostics,
                dockElementPresent: Boolean(this.dockElement),
                store: {
                    books: Object.keys(this.store.state.books).length,
                    attachments: Object.keys(this.store.state.attachments).length,
                    annotations: Object.keys(this.store.state.annotations).length,
                },
            });
            window.setTimeout((): void => void this.restoreLastReaderWorkspace(), 900);
        } catch (error: any) {
            await this.saveReport("p0-ready-report", {
                at: new Date().toISOString(),
                stage: "layout-ready-error",
                error: error?.stack || error?.message || String(error),
            });
        }
        // Zotero is optional at runtime: never block startup or show an error when
        // its Local API is unavailable. Backfill attachment paths from the local
        // Zotero database read-only so cached items remain openable without Zotero.
        void this.service.hydrateOfflineAttachments().then(count => {
            if (count > 0) this.refreshDock();
        });
        applyQaBlockTheme(this.store.state.settings);
        void repairQaBlockAttributes(this.store.state.settings.qaTitle || "PDF 问答");
        void syncTranslationHistory(this);
        this.maybeRunE2E();
        this.maybeRunZoteroCheck();
        this.maybeRunP1E2E();
        this.maybeRunP2E2E();
        this.maybeRunP3E2E();
        void runQueuedAssetSweep(this);
        this.maybeRunAutomationE2E();
    }

    private async maybeRunAutomationE2E(): Promise<void> {
        let run = false;
        try {
            const flag = await this.loadData("automation-e2e-flag");
            run = Boolean(flag && flag.run);
            if (run) {
                try {
                    await this.removeData("automation-e2e-flag");
                } catch {
                    // best effort
                }
            }
        } catch {
            return;
        }
        if (!run) {
            return;
        }
        void (async () => {
            try {
                const {runAutomationE2E} = await import("./e2e-automation");
                const report = await runAutomationE2E(this, async progress => {
                    await this.saveReport("automation-e2e-progress", progress);
                });
                await this.saveReport("automation-e2e-report", report);
            } catch (error: any) {
                await this.saveReport("automation-e2e-report", {
                    ok: false,
                    at: new Date().toISOString(),
                    error: error?.stack || error?.message || String(error),
                });
            }
        })();
    }

    async removeGeneratedAsset(assetPath: string): Promise<void> {
        const {removeAsset} = await import("./siyuan");
        await removeAsset(assetPath);
    }

    private async cleanupE2EResources(report: any): Promise<void> {
        const resources = report?.resources;
        if (!resources) {
            return;
        }
        const {cleanupE2EArtifacts} = await import("./e2e-cleanup");
        report.cleanup = await cleanupE2EArtifacts(this as any, {
            docIds: resources.docIds || [],
            attachmentIds: resources.attachmentIds || [],
            bookIds: resources.bookIds || [],
            testPaths: ["test-fixtures/navigation-p1-", "test-fixtures/sample-paper-e2e-", "test-fixtures/sample-paper.pdf"],
            closeReaderTabs: true,
        });
    }

    private async maybeRunP3E2E(): Promise<void> {
        let run = false;
        try {
            const flag = await this.loadData("p3-e2e-flag");
            run = Boolean(flag && flag.run);
            if (run) {
                try {
                    await this.removeData("p3-e2e-flag");
                } catch {
                    // best effort
                }
            }
        } catch {
            return;
        }
        if (!run) {
            return;
        }
        void (async () => {
            try {
                const {runP3E2E} = await import("./e2e-p3");
                const report = await runP3E2E(this, async progress => {
                    await this.saveReport("p3-e2e-progress", progress);
                });
                await this.cleanupE2EResources(report).catch((): void => undefined);
                await this.saveReport("p3-e2e-report", report);
            } catch (error: any) {
                await this.saveReport("p3-e2e-report", {
                    ok: false,
                    at: new Date().toISOString(),
                    error: error?.stack || error?.message || String(error),
                });
            }
        })();
    }

    private async maybeRunP2E2E(): Promise<void> {
        let run = false;
        try {
            const flag = await this.loadData("p2-e2e-flag");
            run = Boolean(flag && flag.run);
            if (run) {
                try {
                    await this.removeData("p2-e2e-flag");
                } catch {
                    // best effort
                }
            }
        } catch {
            return;
        }
        if (!run) {
            return;
        }
        void (async () => {
            try {
                const {runP2E2E} = await import("./e2e-p2");
                const report = await runP2E2E(this, async progress => {
                    await this.saveReport("p2-e2e-progress", progress);
                });
                await this.cleanupE2EResources(report).catch((): void => undefined);
                await this.saveReport("p2-e2e-report", report);
            } catch (error: any) {
                await this.saveReport("p2-e2e-report", {
                    ok: false,
                    at: new Date().toISOString(),
                    error: error?.stack || error?.message || String(error),
                });
            }
        })();
    }

    private async maybeRunP1E2E(): Promise<void> {
        let run = false;
        try {
            const running = await this.loadData("p1-e2e-running");
            const flag = await this.loadData("p1-e2e-flag");
            run = Boolean(running?.run || flag?.run);
            if (run) {
                try {
                    await this.removeData("p1-e2e-flag");
                } catch {
                    // best effort
                }
                await this.saveData("p1-e2e-running", {run: true});
            }
        } catch {
            return;
        }
        if (!run) {
            return;
        }
        void (async () => {
            try {
                const {runP1E2E} = await import("./e2e-p1");
                const report = await runP1E2E(this, async progress => {
                    await this.saveReport("p1-e2e-progress", progress);
                });
                await this.cleanupE2EResources(report).catch((): void => undefined);
                await this.saveReport("p1-e2e-report", report);
            } catch (error: any) {
                await this.saveReport("p1-e2e-report", {
                    ok: false,
                    at: new Date().toISOString(),
                    error: error?.stack || error?.message || String(error),
                });
            } finally {
                try {
                    await this.removeData("p1-e2e-running");
                } catch {
                    // best effort
                }
            }
        })();
    }

    private async maybeRunZoteroCheck(): Promise<void> {
        let run = false;
        try {
            const flag = await this.loadData("zotero-check");
            run = Boolean(flag && flag.run);
            if (run) {
                try {
                    await this.removeData("zotero-check");
                } catch {
                    // best effort
                }
            }
        } catch {
            return;
        }
        if (!run) {
            return;
        }
        try {
            await this.refreshZotero(true);
            const settings = this.store.state.settings;
            const dataDir = settings.zoteroDataDir || detectZoteroDataDir();
            const client = new ZoteroClient(settings.zoteroBaseUrl, settings.zoteroLibraryId || 0);
            const cache = this.store.state.zotero;
            const report: any = {
                ok: false,
                at: new Date().toISOString(),
                baseUrl: settings.zoteroBaseUrl,
                dataDir,
                ping: await client.ping(),
                cacheItems: cache.items.length,
                cacheError: cache.lastError,
            };
            const item = cache.items.find(entry => entry.key === "K3WY8RWM") || cache.items[0];
            if (item) {
                report.item = item;
                const attachments = await client.listPdfAttachments(item.key, dataDir);
                report.attachments = attachments.map(attachment => ({
                    attachmentKey: attachment.attachmentKey,
                    filename: attachment.filename,
                    path: attachment.path,
                    exists: fileExists(attachment.path),
                    size: fileExists(attachment.path) ? undefined : 0,
                }));
                const pdf = attachments[0];
                if (pdf && fileExists(pdf.path)) {
                    const bytes = await readFileBytes(pdf.path);
                    report.attachmentProbe = {
                        path: pdf.path,
                        bytes: bytes.length,
                        header: String.fromCharCode(...bytes.slice(0, 5)),
                        isPdf: String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-",
                    };
                    const imported = await this.service.importZoteroItem(item.key);
                    if (imported) {
                        await this.openAttachmentAsync(imported, 1);
                        const book = this.store.getBook(imported.bookId);
                        try {
                            const tab = getAllTabs().find(entry => String(entry.title || "").includes(book?.title || imported.fileName));
                            tab?.parent.switchTab(tab.headElement, false);
                        } catch {
                            // tab may already be active
                        }
                        const reader = await this.waitForReader(imported.id, 60000);
                        report.openedInReader = {
                            attachmentId: imported.id,
                            path: imported.path,
                            pages: reader?.querySelectorAll(".pz-page").length || 0,
                            hasTextLayer: Boolean(reader?.querySelector(".pz-text-layer")),
                            visible: reader ? reader.getBoundingClientRect().width > 0 : false,
                        };
                    }
                    report.ok = report.ping.ok
                        && report.attachmentProbe.isPdf
                        && Boolean(report.openedInReader?.pages);
                }
            }
            await this.saveReport("p0-zotero-report", report);
        } catch (error: any) {
            await this.saveReport("p0-zotero-report", {
                ok: false,
                at: new Date().toISOString(),
                error: error?.stack || error?.message || String(error),
            });
        }
    }

    private async waitForReader(attachmentId: string, timeoutMs: number): Promise<HTMLElement | null> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const reader = Array.from(document.querySelectorAll<HTMLElement>(".pz-reader")).find(item => {
                const rect = item.getBoundingClientRect();
                return item.dataset.attachmentId === attachmentId && rect.width > 0
                    && Boolean(item.querySelector(".pz-page"));
            });
            if (reader) {
                return reader;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return null;
    }

    private async saveReport(name: string, data: any): Promise<void> {
        try {
            await this.saveData(name, data);
        } catch (error) {
            console.error(`[pdf-zotero] saveReport ${name} failed`, error);
        }
    }

    /**
     * The plugin writes its own structured state frequently (annotations, reading progress).
     * SiYuan reloads a plugin on private-data changes unless this hook is overridden; reloading
     * mid-annotation would destroy the reader tab. Other frontends re-read on their next action.
     */
    async onDataChanged(): Promise<void> {
        // Intentionally no-op for the P0 single-window prototype.
    }

    async onunload(): Promise<void> {
        this.unloading = true;
        window.removeEventListener("beforeunload", this.onBeforeUnload);
        this.eventBus.off("open-siyuan-url-plugin", this.handlePluginUrl);
        this.eventBus.off("ws-main", this.onWsMain);
        this.eventBus.off("loaded-protyle-static", this.onProtyleLoaded);
        window.clearTimeout(this.citationRefreshTimer);
        document.removeEventListener("mouseover", this.onNoteLinkHover);
        document.removeEventListener("mouseout", this.onNoteLinkOut);
        document.removeEventListener("focusin", this.onFocusIn, true);
        document.removeEventListener("click", this.onLinkedImageClick, true);
        document.removeEventListener("click", this.onFocusIn, true);
        document.removeEventListener("selectionchange", this.rememberNoteSelectionBound);
        document.removeEventListener("paste", this.onPastePdfCallout, true);
        document.removeEventListener("click", this.onSharedToolbarClick, true);
        this.calloutObserver?.disconnect();
        this.calloutObserver = null;
        window.clearTimeout(this.calloutStyleTimer);
        this.automation?.stop();
        this.automation = null;
        this.notePreview.hide();
        this.citationDialog?.destroy();
        this.citationDialog = null;
        this.citationDialogId = "";
        this.attachmentDialog?.destroy();
        this.attachmentDialog = null;
        await Promise.all(Array.from(this.readers).map(reader => reader.destroyAsync(true)));
        this.readers.clear();
        this.styleElement?.remove();
        this.styleElement = null;
        this.dockElement = null;
        delete (window as any).__pdfZotero;
    }

    private startCalloutObserver(): void {
        if (this.calloutObserver) {
            return;
        }
        const schedule = () => {
            window.clearTimeout(this.calloutStyleTimer);
            this.calloutStyleTimer = window.setTimeout(() => {
                document.querySelectorAll<HTMLElement>('[custom-pz-callout="true"]').forEach(stylePdfCalloutDom);
            }, 120);
        };
        this.calloutObserver = new MutationObserver(schedule);
        this.calloutObserver.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["custom-pz-callout", "custom-pz-color"],
        });
        schedule();
    }

    restartAutomation(): void {
        this.automation?.stop();
        this.automation = new NotebookAutomation(this, this);
        this.automation.start();
    }

    private async upgradeExistingPdfCallouts(): Promise<void> {
        document.querySelectorAll<HTMLElement>('[custom-pz-callout="true"]').forEach(stylePdfCalloutDom);
        for (const link of Object.values(this.store.state.noteLinks)) {
            const annotation = this.store.getAnnotation(link.annotationId);
            if (!annotation || !link.siyuanBlockId) continue;
            const colorId = HIGHLIGHT_COLORS.find(item => item.value.toLowerCase() === annotation.color.toLowerCase())?.id || "yellow";
            try {
                const attrsResponse = await fetch("/api/attr/getBlockAttrs", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({id: link.siyuanBlockId}),
                });
                const attrsResult = await attrsResponse.json();
                const kind = attrsResult.data?.["custom-callout"] === "quote" ? "quote" : "PDF";
                await applyPdfCalloutAttributes(link.siyuanBlockId, kind, colorId);
                const domBlock = document.querySelector<HTMLElement>(`[data-node-id="${window.CSS.escape(link.siyuanBlockId)}"]`);
                const callout = domBlock?.matches('[data-type="NodeCallout"],.bq') ? domBlock : domBlock?.closest<HTMLElement>('[data-type="NodeCallout"],.bq');
                callout?.setAttribute("custom-pz-callout", "true");
                callout?.setAttribute("custom-pz-color", colorId);
                stylePdfCalloutDom(callout);
            } catch (error: any) {
                this.logDebug("callout.upgrade.failed", {blockId: link.siyuanBlockId, message: error?.message || String(error)}, "warn");
            }
        }
    }

    private injectStyles(): void {
        if (document.getElementById(STYLE_ID)) {
            return;
        }
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.append(style);
        this.styleElement = style;
    }

    private registerTab(): void {
        const plugin = this;
        this.addTab({
            type: TAB_TYPE,
            init(custom) {
                const data = custom.data as ReaderOpenData;
                const previousReader = Array.from(plugin.readers).find(reader => reader.attachmentId === data.attachmentId);
                if (previousReader) {
                    const previousTab = getAllTabs().find(tab => {
                        const panel = tab.panelElement as HTMLElement | undefined;
                        return Boolean(panel && (panel === previousReader.rootElement || panel.contains(previousReader.rootElement)));
                    });
                    if (previousTab && previousTab !== custom.tab) {
                        // SiYuan clones custom tabs when users split them. Treat that clone as
                        // a move: preserve the session, dispose the old reader, then close only
                        // the source tab so the source pane becomes available immediately.
                        plugin.readers.delete(previousReader);
                        if (plugin.toolbarHostAttachmentId === previousReader.attachmentId) {
                            plugin.toolbarHostAttachmentId = "";
                        }
                        void previousReader.destroyAsync(true);
                        previousTab.close();
                        plugin.logDebug("reader.tab.moved-to-split", {
                            attachmentId: data.attachmentId,
                            fromTabId: previousTab.id,
                            toTabId: custom.tab.id,
                        });
                    }
                }
                const reader = new PdfReader(custom.element as HTMLElement, plugin, data);
                plugin.readers.add(reader);
                (custom as any).__pdfZoteroReader = reader;
                plugin.ensureToolbarHost();
                reader.mount().catch(error => {
                    console.error("[pdf-zotero] reader mount failed", error);
                    showMessage(`PDF 阅读器初始化失败：${error?.message || String(error)}`, 7000, "error");
                });
            },
            destroy() {
                const reader = (this as any).__pdfZoteroReader as PdfReader | undefined;
                if (reader) {
                    plugin.readers.delete(reader);
                    if (plugin.toolbarHostAttachmentId === reader.attachmentId) {
                        plugin.toolbarHostAttachmentId = "";
                    }
                    void reader.destroyAsync(plugin.unloading);
                    if (plugin.activeReaderAttachmentId === reader.attachmentId) {
                        const fallback = Array.from(plugin.readers).at(-1);
                        plugin.activeReaderAttachmentId = "";
                        if (fallback) plugin.activateReader(fallback.attachmentId);
                    }
                    plugin.ensureToolbarHost();
                }
            },
        });
    }

    private registerDock(): void {
        const plugin = this;
        this.registeredDock = this.addDock({
            config: {
                position: "RightBottom",
                size: {width: 340, height: 0},
                icon: ICON_ID,
                title: PLUGIN_DISPLAY_NAME,
            },
            data: {},
            type: DOCK_TYPE,
            init(dock) {
                plugin.dockElement = dock.element as HTMLElement;
                renderDock(plugin, dock.element as HTMLElement);
            },
            destroy() {
                plugin.dockElement = null;
            },
        });
    }

    private registerCommands(): void {
        this.addCommand({
            langKey: "openLocalPdf",
            langText: "打开本地 PDF",
            hotkey: "⌥⌘P",
            execute: () => {
                void this.importLocalPdfFromPicker();
            },
        });
        this.addCommand({
            langKey: "refreshZotero",
            langText: "刷新 Zotero 文献",
            execute: () => {
                void this.refreshZotero();
            },
        });
        this.addCommand({
            langKey: "insertZoteroCitation",
            langText: "插入 Zotero 引文",
            hotkey: "⌥⌘C",
            execute: () => {
                this.openCitationDialog();
            },
        });
        this.addCommand({
            langKey: "ocrClipboard",
            langText: "OCR 识别剪贴板图片",
            execute: () => {
                this.ocrClipboardImage();
            },
        });
        this.addCommand({
            langKey: "refreshZoteroCitations",
            langText: "刷新当前文档参考文献",
            execute: () => {
                const editor = getActiveEditor() || getAllEditor()[0];
                const docId = String(editor?.protyle.block.rootID || "");
                if (!docId) {
                    showMessage("请先打开一个思源文档");
                    return;
                }
                void refreshDocumentCitations(this.store, docId).then(result => {
                    showMessage(`参考文献已刷新（${result.citationCount} 条引文）`);
                }).catch(error => {
                    showMessage(`刷新参考文献失败：${error?.message || String(error)}`, 6000, "error");
                });
            },
        });
        this.addCommand({
            langKey: "focusPdfZoteroDock",
            langText: "显示 PDF × Zotero 面板",
            execute: () => {
                const dock = this.docks[DOCK_TYPE];
                if (dock) {
                    showMessage("请点击右侧栏的 PDF × Zotero 图标");
                }
            },
        });
    }

    private readonly onProtyleLoaded = (event: any): void => {
        const docId = String(event?.protyle?.block?.rootID || "");
        if (!docId) return;
        const hasCitations = Object.values(this.store.state.citations).some(record => record.siyuanDocId === docId)
            || Boolean(this.store.state.references[docId]);
        if (!hasCitations) return;
        window.setTimeout(() => {
            if (Date.now() < this.citationRefreshGuardUntil) return;
            this.citationRefreshGuardUntil = Date.now() + 2500;
            void refreshDocumentCitations(this.store, docId).catch(error => {
                this.logDebug("citation.open-refresh.failed", {docId, error: String(error?.message || error)});
            });
        }, 450);
    };

    private readonly onWsMain = (event: any): void => {
        if (event?.cmd !== "transactions") return;
        const rawData = event.data;
        const transactions = Array.isArray(rawData)
            ? rawData
            : (Array.isArray(rawData?.transactions) ? rawData.transactions : [rawData].filter(Boolean));
        const hasOperations = transactions.some((transaction: any) =>
            (Array.isArray(transaction?.doOperations) && transaction.doOperations.length > 0)
            || (Array.isArray(transaction?.operations) && transaction.operations.length > 0));
        if (!hasOperations) return;
        const editor = getActiveEditor() || getAllEditor()[0];
        const docId = String(editor?.protyle?.block?.rootID || "");
        if (!docId) return;
        const hasCitations = Object.values(this.store.state.citations).some(record => record.siyuanDocId === docId)
            || Boolean(this.store.state.references[docId]);
        if (!hasCitations) return;
        if (Date.now() < this.citationRefreshGuardUntil) return;
        window.clearTimeout(this.citationRefreshTimer);
        this.citationRefreshTimer = window.setTimeout(() => {
            this.citationRefreshGuardUntil = Date.now() + 2500;
            void refreshDocumentCitations(this.store, docId).catch(error => {
                this.logDebug("citation.auto-refresh.failed", {docId, error: String(error?.message || error)});
            });
        }, 700);
    };

    ocrClipboardImage(): void {
        void this.ocrClipboardImageInternal();
    }

    private async ocrClipboardImageInternal(): Promise<void> {
        try {
            const blob = await readClipboardImage();
            const settings = this.store.state.settings;
            if (!settings.ocrServerPath?.trim()) {
                showMessage("请先在设置 → OCR 中选择本地服务目录", 4000, "error");
                return;
            }
            const server = await ensureOcrServer(settings);
            if (!server.ok) throw new Error(server.error || "OCR 服务不可用");
            const result = await recognizeImage(settings, blob, {mode: settings.ocrDefaultMode, source: "clipboard"});
            if (!result.items.length && !result.markdown.trim()) throw new Error("OCR 没有返回内容");
            openOcrResultDialog(this, result, {
                imageBlob: blob,
                source: "clipboard",
                insertionTarget: this.captureNoteInsertionTarget(),
            });
        } catch (error: any) {
            showMessage(`OCR 失败：${error?.message || String(error)}`, 6000, "error");
        }
    }

    openSetting(): void {
        openSettings(this);
    }

    openDoc(docId: string): void {
        if (!docId) return;
        void openTab({app: this.app, doc: {id: docId}, openNewTab: true, position: "right"});
    }

    openCitationDialog(citationId?: string, initialItemKeys: string[] = []): void {
        const requestedId = citationId || "";
        if (this.citationDialog?.element.isConnected && this.citationDialogId === requestedId && !initialItemKeys.length) {
            this.logDebug("citation.dialog.reused", {citationId: requestedId});
            this.citationDialog.element.querySelector<HTMLInputElement>('[data-role="citation-search"]')?.focus();
            return;
        }
        if (this.citationDialog?.element.isConnected) {
            this.citationDialog.destroy();
        }
        this.citationDialog = null;
        this.citationDialogId = "";
        this.removeOrphanCitationDialogs();
        this.citationDialog = openCitationDialog({
            store: this.store,
            citation: citationId ? this.store.state.citations[citationId] : undefined,
            initialItemKeys,
        });
        this.citationDialogId = requestedId;
        this.logDebug("citation.dialog.opened", {citationId: requestedId});
    }

    private removeOrphanCitationDialogs(): void {
        for (const content of Array.from(document.querySelectorAll<HTMLElement>(".pz-citation-dialog"))) {
            content.closest<HTMLElement>(".b3-dialog")?.remove();
        }
    }

    getLastNoteDocId(): string {
        return this.lastNoteDocId;
    }

    private readonly rememberNoteSelectionBound = () => this.rememberNoteSelection();

    captureNoteInsertionTarget(): NoteInsertionTarget {
        const editor = getAllEditor().find(item => item.protyle.block.rootID === this.lastNoteDocId);
        let trackedHandle: {readonly id: string} | undefined;
        if (editor && this.lastNoteTrackedHandle) {
            try {
                const resolved = editor.protyle.resolveTrackedRange(this.lastNoteTrackedHandle);
                if (resolved.status === "resolved") {
                    trackedHandle = editor.trackRange(resolved.range, {owner: this, affinity: "after"});
                }
            } catch {
                trackedHandle = undefined;
            }
        }
        let blockId = this.lastNoteBlockId;
        let textOffset = this.lastNoteTextOffset;
        if ((!blockId || blockId === this.lastNoteDocId) && this.lastNoteRange) {
            const node = this.lastNoteRange.startContainer;
            const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
            const block = element?.closest<HTMLElement>("[data-node-id]");
            if (block?.dataset.nodeId && block.dataset.nodeId !== this.lastNoteDocId) {
                blockId = block.dataset.nodeId;
                try {
                    const prefix = document.createRange();
                    prefix.selectNodeContents(block);
                    prefix.setEnd(this.lastNoteRange.startContainer, this.lastNoteRange.startOffset);
                    textOffset = prefix.toString().length;
                } catch {
                    textOffset = 0;
                }
            }
        }
        return {
            docId: this.lastNoteDocId,
            ...(this.lastNoteRange ? {range: this.lastNoteRange.cloneRange()} : {}),
            ...(blockId ? {blockId, textOffset} : {}),
            ...(trackedHandle ? {trackedHandle} : {}),
        };
    }

    private async loadDebugLogs(): Promise<void> {
        try {
            const stored = await this.loadData("debug-log-v1");
            this.debugLogs = Array.isArray(stored) ? stored.slice(-400) : [];
        } catch {
            this.debugLogs = [];
        }
    }

    logDebug(event: string, data: Record<string, unknown> = {}, level: "debug" | "info" | "warn" | "error" = "info"): void {
        const entry = {at: new Date().toISOString(), level, event, data};
        this.debugLogs.push(entry);
        this.debugLogs = this.debugLogs.slice(-400);
        const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
        consoleMethod(`[pdf-zotero] ${event}`, data);
        void this.saveData("debug-log-v1", this.debugLogs).catch((): void => undefined);
    }

    private readonly onNoteLinkHover = (event: MouseEvent) => {
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-type="a"][data-href]');
        if (!target || !target.dataset.href) {
            return;
        }
        const href = target.dataset.href;
        if (href === this.lastNotePreviewHref) {
            return;
        }
        const trigger = this.store.state.settings.previewTrigger;
        if (trigger === "alt" && !event.altKey) {
            this.notePreview.hide();
            return;
        }
        this.lastNotePreviewHref = href;
        if (href.startsWith(`siyuan://plugins/${this.name}/`)) {
            const parsed = parsePluginUrl(href, this.name);
            if (parsed?.route === "annotation" && parsed.id) {
                const annotation = this.store.getAnnotation(parsed.id);
                if (!annotation) {
                    return;
                }
                const attachment = this.store.getAttachment(annotation.attachmentId);
                const book = attachment ? this.store.getBook(attachment.bookId) : undefined;
                this.notePreview.showAnnotation({
                    text: annotation.text,
                    page: annotation.page,
                    bookTitle: book?.title || "PDF 标注",
                    noteCount: this.store.noteLinksForAnnotation(annotation.id).length,
                    anchor: target.getBoundingClientRect(),
                });
            } else if (parsed?.route === "citation" && parsed.id) {
                const citation = this.store.state.citations[parsed.id];
                if (citation) {
                    const titles = citation.items.map(item => String(item.csl.title || item.itemKey)).join("; ");
                    this.notePreview.showHtml(
                        `<div class="pz-preview-title">Zotero 引文</div><div class="pz-preview-text">${titles}</div>`,
                        target.getBoundingClientRect(),
                    );
                }
            }
        } else if (href.startsWith("siyuan://blocks/")) {
            const blockId = href.slice("siyuan://blocks/".length).split(/[?#]/)[0];
            if (blockId) {
                // Public plugin API; SiYuan renders the standard block-ref preview.
                this.addFloatLayer({
                    refDefs: [{refID: blockId}],
                    targetElement: target,
                    isBacklink: false,
                });
            }
        }
    };

    private readonly onNoteLinkOut = (event: MouseEvent) => {
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-type="a"][data-href]');
        if (!target) {
            return;
        }
        const related = event.relatedTarget as Node | null;
        if (related && target.contains(related)) {
            return;
        }
        this.lastNotePreviewHref = "";
        this.notePreview.hide();
    };

    private readonly onLinkedImageClick = (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target || target.tagName !== "IMG") {
            return;
        }
        const image = target as HTMLImageElement;
        const source = image.dataset.src || image.getAttribute("src") || "";
        const encoded = source.match(/#pz=([^&\s]+)/)?.[1] || "";
        if (!encoded) {
            return;
        }
        let href = "";
        try {
            href = decodeURIComponent(encoded);
        } catch {
            return;
        }
        if (!parsePluginUrl(href, this.name)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.handlePluginUrl({detail: {url: href}} as CustomEvent<{url: string}>);
    };

    private readonly handlePluginUrl = ({detail}: CustomEvent<{url: string}>) => {
        const parsed = parsePluginUrl(detail.url, this.name);
        if (!parsed) {
            return;
        }
        if (parsed.route === "pdf" && parsed.id) {
            const attachment = this.store.getAttachment(parsed.id);
            if (!attachment) {
                showMessage("截图对应的 PDF 记录不存在", 5000, "error");
                return;
            }
            this.logDebug("image.jump.request", {attachmentId: parsed.id, page: parsed.page || 1, regionId: parsed.regionId || ""});
            void this.openAttachmentAsync(attachment, parsed.page || 1, "", parsed.rect, parsed.color, parsed.regionId);
            return;
        }
        if (parsed.route === "citation" && parsed.id) {
            if (!this.store.state.citations[parsed.id]) {
                showMessage("链接对应的引文记录不存在", 5000, "error");
                return;
            }
            this.openCitationDialog(parsed.id);
            return;
        }
        if (parsed.route === "automation-column" && parsed.id) {
            void this.automation?.toggleIndexColumn(Number.parseInt(parsed.id, 10) || 0);
            return;
        }
        if (parsed.route !== "annotation" || !parsed.id) {
            showMessage(`未知的 PDF × Zotero 链接：${parsed.route}`, 5000, "error");
            return;
        }
        const annotation = this.store.getAnnotation(parsed.id);
        if (!annotation) {
            showMessage("链接对应的 PDF 标注不存在（可能已删除插件数据）", 6000, "error");
            return;
        }
        const attachment = this.store.getAttachment(annotation.attachmentId);
        if (!attachment) {
            showMessage("链接对应的 PDF 记录不存在，无法回跳", 6000, "error");
            return;
        }
        void this.openAttachmentAsync(attachment, annotation.page, annotation.id);
    };

    // ---- PluginHost implementation ----

    openAttachment(attachment: PdfAttachment, page?: number, annotationId?: string): void {
        void this.openAttachmentAsync(attachment, page, annotationId);
    }

    private readonly onSharedToolbarClick = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null;
        const toolbar = target?.closest<HTMLElement>(".pz-topbar.pz-shared-toolbar");
        if (!toolbar) return;
        const host = Array.from(this.readers).find(reader => reader.toolbarElement === toolbar);
        const active = Array.from(this.readers).find(reader => reader.attachmentId === this.activeReaderAttachmentId);
        if (!host || !active || host === active) return;
        const colorButton = target?.closest<HTMLElement>("[data-format-color]");
        if (colorButton) {
            event.preventDefault();
            event.stopImmediatePropagation();
            active.applyToolbarColor(colorButton.dataset.formatColor || "yellow");
            active.syncToolbarSelection(toolbar);
            return;
        }
        const actionButton = target?.closest<HTMLElement>("button[data-act]");
        if (actionButton) {
            event.preventDefault();
            event.stopImmediatePropagation();
            active.runToolbarAction(actionButton.dataset.act || "", actionButton);
        }
    };

    activateReader(attachmentId: string): void {
        if (!attachmentId) return;
        const changed = this.activeReaderAttachmentId !== attachmentId;
        this.activeReaderAttachmentId = attachmentId;
        for (const reader of this.readers) {
            reader.setWorkspaceActive(reader.attachmentId === attachmentId);
        }
        // Keep the host toolbar mounted permanently; activation only updates state
        // and compact/full classes in this same event turn.
        if (!this.toolbarHostAttachmentId) this.ensureToolbarHost();
        this.placeSharedReaderToolbar();
        if (changed) {
            this.store.state.lastReaderAttachmentId = attachmentId;
            this.store.state.readerSession.activeAttachmentId = attachmentId;
            void this.store.save();
            this.logDebug("reader.workspace.activate", {attachmentId, readers: this.readers.size});
        }
    }

    private ensureToolbarHost(): void {
        const readers = Array.from(this.readers).filter(reader => reader.rootElement.isConnected);
        if (!readers.length) {
            this.toolbarHostAttachmentId = "";
            return;
        }
        if (readers.some(reader => reader.attachmentId === this.toolbarHostAttachmentId)) {
            this.placeSharedReaderToolbar();
            return;
        }
        this.toolbarHostAttachmentId = this.pickToolbarHost(readers).attachmentId;
        this.logDebug("reader.toolbar-host.selected", {attachmentId: this.toolbarHostAttachmentId});
        this.placeSharedReaderToolbar();
    }

    private pickToolbarHost(readers: PdfReader[]): PdfReader {
        const visible = readers.filter(reader => {
            const rect = reader.rootElement.getBoundingClientRect();
            return rect.width > 100 && rect.height > 80;
        });
        return (visible.length ? visible : readers)
            .sort((a, b) => a.rootElement.getBoundingClientRect().top - b.rootElement.getBoundingClientRect().top)[0];
    }

    private placeSharedReaderToolbar(): void {
        const readers = Array.from(this.readers).filter(reader => reader.rootElement.isConnected);
        if (!readers.length) return;
        // Host is always the visually topmost reader, never the active one.
        // Re-resolve it after a split/reorder so a lower reader cannot keep the
        // full toolbar while the top pane is reduced to a compact caption.
        const host = this.pickToolbarHost(readers);
        this.toolbarHostAttachmentId = host.attachmentId;
        // The top host keeps one persistent full color toolbar. Non-host readers
        // only keep a compact title line, so no toolbar DOM has to move on click.
        for (const reader of readers) {
            const toolbar = reader.toolbarElement;
            if (!toolbar) continue;
            if (toolbar.parentElement !== reader.rootElement) reader.restoreToolbar();
            toolbar.classList.remove("pz-shared-toolbar", "pz-compact-toolbar", "pz-host-caption");
            toolbar.style.removeProperty("display");
            if (reader !== host) toolbar.classList.add("pz-compact-toolbar");
        }
        const hostToolbar = host.toolbarElement;
        if (hostToolbar) {
            // Invariant: the host is always the full toolbar, never compact.
            hostToolbar.classList.remove("pz-compact-toolbar");
            hostToolbar.classList.add("pz-shared-toolbar");
            hostToolbar.style.removeProperty("display");
        }
        this.logDebug("reader.shared-toolbar.placed", {
            activeAttachmentId: this.activeReaderAttachmentId,
            hostAttachmentId: host.attachmentId,
            hostFull: Boolean(hostToolbar?.classList.contains("pz-shared-toolbar")),
            persistent: true,
        });
    }

    async openAttachmentAsync(
        attachment: PdfAttachment,
        page?: number,
        annotationId?: string,
        targetRect?: [number, number, number, number],
        targetColor?: string,
        targetRegionId?: string,
    ): Promise<void> {
        if (this.openingAttachmentIds.has(attachment.id)) {
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline) {
                const pendingReader = Array.from(this.readers).find(reader => reader.attachmentId === attachment.id);
                if (pendingReader) {
                    this.activateReader(attachment.id);
                    await pendingReader.revealTarget(page, annotationId, targetRect, targetColor, targetRegionId);
                    this.logDebug("reader.tab.pending-reused", {attachmentId: attachment.id, page: page || 0});
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 80));
            }
            this.logDebug("reader.tab.pending-timeout", {attachmentId: attachment.id}, "warn");
            return;
        }
        const book = this.store.getBook(attachment.bookId);
        const title = book?.title || attachment.fileName;
        this.store.touchRecent(attachment.id);
        this.store.state.lastReaderAttachmentId = attachment.id;
        await this.store.save();
        const existingReader = Array.from(this.readers).find(reader => reader.attachmentId === attachment.id);
        if (existingReader) {
            this.activateReader(attachment.id);
            const existingTab = getAllTabs().find(tab => {
                const panel = (tab as any).panelElement as HTMLElement | undefined;
                return Boolean(panel && (panel === existingReader.rootElement || panel.contains(existingReader.rootElement)));
            });
            existingTab?.parent.switchTab(existingTab.headElement, false);
            await existingReader.revealTarget(page, annotationId, targetRect, targetColor, targetRegionId);
            this.logDebug("reader.tab.reused", {
                attachmentId: attachment.id,
                page: page || 0,
                annotationId: annotationId || "",
                regionId: targetRegionId || "",
            });
            this.refreshDock();
            return;
        }
        const existingElement = Array.from(document.querySelectorAll<HTMLElement>(".pz-reader"))
            .find(element => element.dataset.attachmentId === attachment.id && element.querySelector(".pz-page"));
        if (existingElement) {
            const existingTab = getAllTabs().find(tab => {
                const panel = (tab as any).panelElement as HTMLElement | undefined;
                return Boolean(panel && (panel === existingElement || panel.contains(existingElement)));
            });
            existingTab?.parent.switchTab(existingTab.headElement, false);
            existingElement.dispatchEvent(new CustomEvent("pz-reveal-target", {detail: {
                page,
                annotationId: annotationId || "",
                targetRect,
                targetColor,
                targetRegionId,
            }}));
            this.logDebug("reader.tab.dom-reused", {attachmentId: attachment.id, page: page || 0, regionId: targetRegionId || ""});
            this.refreshDock();
            return;
        }
        // Do not await openTab(): custom tabs resolve only when the host finishes tab creation,
        // and awaiting here can deadlock an automated call sequence.
        const readerTabs = getAllTabs().filter(tab => {
            const panel = (tab as any).panelElement as HTMLElement | undefined;
            return Boolean(panel && Array.from(this.readers).some(reader =>
                panel === reader.rootElement || panel.contains(reader.rootElement),
            ));
        });
        const targetReaderTab = readerTabs.find(tab => {
            const panel = (tab as any).panelElement as HTMLElement | undefined;
            const activeReader = Array.from(this.readers).find(reader => reader.attachmentId === this.activeReaderAttachmentId);
            return Boolean(panel && activeReader && (panel === activeReader.rootElement || panel.contains(activeReader.rootElement)));
        }) || readerTabs[0];
        const targetWndId = targetReaderTab?.parent?.id || "";
        if (targetReaderTab) {
            targetReaderTab.parent.switchTab(targetReaderTab.headElement, false);
            this.logDebug("reader.tab.target-group-selected", {
                attachmentId: attachment.id,
                targetTabId: targetReaderTab.id,
                targetWndId,
            });
        }
        this.openingAttachmentIds.add(attachment.id);
        void openTab({
            app: this.app,
            custom: {
                id: this.name + TAB_TYPE,
                icon: ICON_ID,
                title,
                data: {
                    attachmentId: attachment.id,
                    page,
                    annotationId: annotationId || "",
                    targetRect,
                    targetColor,
                    targetRegionId,
                } satisfies ReaderOpenData,
            },
            openNewTab: true,
            ...(targetReaderTab ? {} : {position: "right" as const}),
        }).then(openedTab => {
            this.logDebug("reader.tab.opened", {
                attachmentId: attachment.id,
                tabId: openedTab.id,
                targetWndId,
                actualWndId: openedTab.parent?.id || "",
                reusedPdfGroup: Boolean(targetReaderTab),
            });
        }).catch(error => {
            console.error("[pdf-zotero] openTab failed", error);
            showMessage(`打开 PDF 标签页失败：${error?.message || String(error)}`, 7000, "error");
        });
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && !Array.from(this.readers).some(reader => reader.attachmentId === attachment.id)) {
            await new Promise(resolve => setTimeout(resolve, 80));
        }
        this.openingAttachmentIds.delete(attachment.id);
        this.refreshDock();
    }

    refreshDock(): void {
        if (this.dockElement) {
            renderDock(this, this.dockElement);
        }
    }

    async importLocalPdfFromPicker(): Promise<void> {
        const picked = await pickPdfFile();
        if (!picked) {
            return;
        }
        if (!picked.path) {
            showMessage("无法获得所选 PDF 的本地路径，P0 不能为该文件建立可重启回跳的锚点。请使用桌面端并从文件选择器打开。", 8000, "error");
            return;
        }
        const attachment = await this.service.importPicked(picked);
        await this.openAttachmentAsync(attachment);
    }

    async importLocalPath(filePath: string): Promise<PdfAttachment | null> {
        try {
            const attachment = await this.service.importPath(filePath);
            return attachment;
        } catch (error: any) {
            showMessage(`导入 PDF 失败：${error?.message || String(error)}`, 7000, "error");
            return null;
        }
    }

    async refreshZotero(silent = false): Promise<void> {
        if (this.zoteroRefreshPromise) {
            if (!silent) showMessage("Zotero 正在刷新，请稍候…", 2000);
            return this.zoteroRefreshPromise;
        }
        this.zoteroRefreshPromise = this.service.refreshZotero(silent).finally(() => {
            this.zoteroRefreshPromise = null;
        });
        return this.zoteroRefreshPromise;
    }

    async openZoteroItem(itemKey: string): Promise<void> {
        if (this.zoteroOpenItems.has(itemKey)) {
            showMessage("该 Zotero 条目正在打开，请稍候…", 2000);
            return;
        }
        this.zoteroOpenItems.add(itemKey);
        try {
        let attachments;
        try {
            attachments = await this.service.listZoteroPdfAttachments(itemKey);
        } catch (error: any) {
            showMessage(`读取 Zotero 附件失败：${error?.message || String(error)}`, 7000, "error");
            return;
        }
        if (!attachments.length) {
            showMessage("该 Zotero 条目没有 PDF 附件", 5000, "error");
            return;
        }
        let attachmentKey = attachments[0].attachmentKey;
        if (attachments.length > 1) {
            const chosen = await this.chooseZoteroAttachment(attachments);
            if (!chosen) {
                return;
            }
            attachmentKey = chosen;
        }
        const attachment = await this.service.importZoteroItem(itemKey, attachmentKey);
        if (attachment) {
            await this.openAttachmentAsync(attachment);
        }
        } finally {
            this.zoteroOpenItems.delete(itemKey);
        }
    }

    private chooseZoteroAttachment(attachments: Array<{attachmentKey: string; attachmentTitle: string; filename: string}>): Promise<string | null> {
        return new Promise(resolve => {
            this.attachmentDialog?.destroy();
            let settled = false;
            const finish = (key: string | null) => {
                if (!settled) {
                    settled = true;
                    resolve(key);
                }
            };
            const dialog = new Dialog({
                title: "选择 Zotero 附件",
                width: "560px",
                content: `<div class="b3-dialog__content"><div class="pz-muted" style="margin-bottom:8px">该条目有 ${attachments.length} 个 PDF，请选择要打开的附件。</div>
${attachments.map(item => `<button class="pz-list-item" data-attachment-choice="${this.escapeAttr(item.attachmentKey)}"><div class="pz-item-title">${this.escapeAttr(item.attachmentTitle || item.filename)}</div><div class="pz-item-meta">${this.escapeAttr(item.filename)}</div></button>`).join("")}</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="attachment-cancel">取消</button></div>`,
            });
            this.attachmentDialog = dialog;
            dialog.element.querySelectorAll<HTMLElement>("[data-attachment-choice]").forEach(button => {
                button.addEventListener("click", () => {
                    finish(button.dataset.attachmentChoice || null);
                    dialog.destroy();
                    this.attachmentDialog = null;
                });
            });
            dialog.element.querySelector('[data-act="attachment-cancel"]')?.addEventListener("click", () => {
                finish(null);
                dialog.destroy();
                this.attachmentDialog = null;
            });
        });
    }

    private async restoreLastReaderWorkspace(): Promise<void> {
        if (this.readerRestorePromise) {
            await this.readerRestorePromise;
            return;
        }
        this.readerRestorePromise = this.restoreLastReaderWorkspaceOnce();
        try {
            await this.readerRestorePromise;
        } finally {
            this.readerRestorePromise = null;
        }
    }

    private async restoreLastReaderWorkspaceOnce(): Promise<void> {
        const staleTabs = getAllTabs().filter(tab => {
            const panel = (tab as any).panelElement as HTMLElement | undefined;
            return Boolean(panel?.querySelector?.(".pz-reader-stale,[data-pz-destroyed='true']")
                || (panel?.querySelector?.(".pz-reader") && !panel.querySelector?.(".pz-reader .pz-body")));
        });
        if (staleTabs.length) {
            this.logDebug("reader.stale-tabs.close", {count: staleTabs.length, tabIds: staleTabs.map(tab => tab.id)});
            for (const tab of staleTabs) {
                try { tab.close(); } catch (error: any) {
                    this.logDebug("reader.stale-tab.close-failed", {tabId: tab.id, message: error?.message || String(error)}, "warn");
                }
            }
            // Tab.close() removes SiYuan layout nodes asynchronously. Opening a replacement
            // in the same tick leaves both the old shell and the new tab in the tab bar.
            const deadline = Date.now() + 2500;
            while (Date.now() < deadline && getAllTabs().some(tab => staleTabs.includes(tab))) {
                await new Promise(resolve => setTimeout(resolve, 80));
            }
        }
        if (this.readers.size || getAllTabs().some(tab => Boolean((tab as any).panelElement?.querySelector?.(".pz-reader .pz-body")))) {
            return;
        }
        const session = this.store.state.readerSession;
        if (!session.open || !session.readerAttachmentIds.length) {
            return;
        }
        const attachments = session.readerAttachmentIds
            .map(id => this.store.getAttachment(id))
            .filter((attachment): attachment is PdfAttachment => Boolean(attachment?.path && fileExists(attachment.path)));
        if (!attachments.length) {
            return;
        }
        const activeId = session.activeAttachmentId;
        const ordered = [
            ...attachments.filter(attachment => attachment.id !== activeId),
            ...attachments.filter(attachment => attachment.id === activeId),
        ];
        this.logDebug("reader.session.restore", {attachmentIds: ordered.map(item => item.id), activeId});
        for (const attachment of ordered) {
            await this.openAttachmentAsync(attachment, attachment.lastPage || 1);
        }
    }

    private escapeAttr(text: string): string {
        return String(text || "").replace(/[&<>"']/g, ch => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[ch] as string));
    }

    async relinkAttachment(attachmentId: string): Promise<void> {
        const attachment = this.store.getAttachment(attachmentId);
        if (!attachment) {
            showMessage("附件记录不存在", 5000, "error");
            return;
        }
        const picked = await pickPdfFile();
        if (!picked) {
            return;
        }
        try {
            const updated = await this.service.relinkAttachment(attachmentId, picked.path);
            showMessage(`已重新关联 PDF：${updated.fileName}；标注与笔记链接保留`);
            await this.openAttachmentAsync(updated, updated.lastPage);
        } catch (error: any) {
            showMessage(`重新关联失败：${error?.message || String(error)}`, 7000, "error");
        }
    }

    async openNoteBlock(docId: string, blockId: string): Promise<void> {
        if (!docId) {
            showMessage("笔记链接缺少文档 ID", 5000, "error");
            return;
        }
        await openTab({
            app: this.app,
            doc: {id: docId},
            openNewTab: true,
            position: "right",
        });
        const editor = await this.waitForEditor(docId, 12000);
        if (!editor) {
            showMessage("已打开文档，但未找到目标块；请手动定位", 5000, "error");
            return;
        }
        const root = editor.protyle.wysiwyg?.element as HTMLElement | undefined;
        const element = root?.querySelector(`[data-node-id="${globalThis.CSS.escape(blockId)}"]`) as HTMLElement | null;
        if (element) {
            editor.focusBlock(element, true);
            element.scrollIntoView({block: "center"});
        } else {
            editor.focus();
        }
    }

    private async waitForEditor(rootId: string, timeoutMs: number): Promise<any | null> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const editor = getAllEditor().find(item => item.protyle.block.rootID === rootId);
            if (editor) {
                return editor;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return null;
    }

    async collectDiagnostics(): Promise<any> {
        const settings = this.store.state.settings;
        const client = new ZoteroClient(settings.zoteroBaseUrl, settings.zoteroLibraryId || 0);
        return {
            frontend: getFrontend(),
            node: (globalThis as any).process?.versions?.node || "",
            chrome: (globalThis as any).process?.versions?.chrome || "",
            electron: (globalThis as any).process?.versions?.electron || "",
            hasRequire: typeof (window as any).require === "function",
            hasNodeFs: hasNodeFs(),
            hasElectronWebUtils: Boolean(requireNode("electron")?.webUtils?.getPathForFile),
            pdfjsVersion: pdfjsLib.version,
            workerSrc: pdfjsLib.GlobalWorkerOptions.workerSrc,
            assetUrl: pluginAssetUrl("pdf.min.mjs"),
            editors: getAllEditor().length,
            zotero: await client.ping(),
            zoteroDataDir: settings.zoteroDataDir || detectZoteroDataDir(),
            storageKey: "state-v1",
        };
    }

    // ---- Diagnostics exposed for automated P0 verification ----
    private exposeDiagnostics(): void {
        const plugin = this;
        (window as any).__pdfZotero = {
            pluginName: PLUGIN_NAME,
            version: VERSION,
            getState: () => JSON.parse(JSON.stringify(plugin.store.state)),
            getAttachment: (id: string) => plugin.store.getAttachment(id),
            getAnnotation: (id: string) => plugin.store.getAnnotation(id),
            importLocalPath: async (filePath: string) => (await plugin.importLocalPath(filePath))?.id || null,
            openAttachment: async (id: string, page?: number, annotationId?: string) => {
                const attachment = plugin.store.getAttachment(id);
                if (!attachment) {
                    throw new Error(`attachment not found: ${id}`);
                }
                await plugin.openAttachmentAsync(attachment, page, annotationId);
            },
            refreshZotero: (silent?: boolean) => plugin.refreshZotero(Boolean(silent)),
            openZoteroItem: (key: string) => plugin.openZoteroItem(key),
            insertCitation: (keys: string[], style?: any, options?: any) => insertCitation(plugin.store, keys, style || "gbt7714", options || {}),
            relinkAttachmentPath: async (id: string, path: string) => (await plugin.service.relinkAttachment(id, path))?.id || null,
            refreshCitations: (docId: string) => refreshDocumentCitations(plugin.store, docId),
            getCitations: () => JSON.parse(JSON.stringify(plugin.store.state.citations)),
            getReferences: () => JSON.parse(JSON.stringify(plugin.store.state.references)),
            runE2E: () => plugin.runE2E(),
            diagnostics: () => plugin.collectDiagnostics(),
            getLogs: () => JSON.parse(JSON.stringify(plugin.debugLogs)),
            clearLogs: async () => {
                plugin.debugLogs = [];
                await plugin.saveData("debug-log-v1", []);
            },
        };
    }

    private async maybeRunE2E(): Promise<void> {
        let run = false;
        try {
            run = localStorage.getItem("pdf-zotero-e2e") === "1";
        } catch {
            // localStorage can be unavailable in read-only contexts
        }
        if (!run) {
            try {
                const flag = await this.loadData("e2e-flag");
                run = Boolean(flag && flag.run);
                if (run) {
                    try {
                        await this.removeData("e2e-flag");
                    } catch {
                        // flag removal is best-effort
                    }
                }
            } catch {
                // no flag
            }
        }
        if (!run) {
            return;
        }
        window.setTimeout(() => {
            void this.runE2E().catch(async error => {
                await this.saveReport("p0-e2e-report", {
                    ok: false,
                    at: new Date().toISOString(),
                    stage: "uncaught",
                    error: error?.stack || error?.message || String(error),
                });
            });
        }, 800);
    }

    private async runE2E(): Promise<void> {
        const {runP0E2E} = await import("./e2e");
        const report = await runP0E2E(this, async progress => {
            await this.saveReport("p0-e2e-progress", progress);
        });
        await this.cleanupE2EResources(report).catch((): void => undefined);
        await this.saveReport("p0-e2e-report", report);
    }
}
