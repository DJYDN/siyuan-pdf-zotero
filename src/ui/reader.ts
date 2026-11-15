import {Dialog, showMessage} from "siyuan";
import {DEFAULT_COLOR, DEFAULT_ZOOM, HIGHLIGHT_COLORS} from "../constants";
import {annotationHref, normalizeClientRect, pdfPageHref, rectsFromSelection} from "../anchor";
import {displayTextForScreenshot, formatHrefCopy} from "../link-format";
import {copyAnnotationFormatted, copyAnnotationQuote, insertAnnotationNote} from "../notes";
import {
    colorToRgba,
    openPdfDocument,
    paintPageAnnotations,
    type PdfDocument,
    type RenderedPageInfo,
    renderPage,
} from "../pdf/pdfjs";
import {getLinkBoxes, loadOutline, type OutlineEntry} from "../pdf/links";
import {searchPages, type SearchHit} from "../pdf/search";
import {loadAttachmentBytes} from "../pdf/source";
import {fileExists, getPathForFile, openExternalUrl, requireNode} from "../runtime";
import {insertImageAtCursor, insertMarkdownAtCursor, uploadPngAsset} from "../siyuan";
import {newId} from "../storage";
import type {Annotation, DisplayTextFormat, LinkCopyFormat, QaAttachment, QaMessage, QaThread, ReaderOpenData, ScreenshotRegion, SelectionAnchor} from "../types";
import {chatWithSiyuanAIStream} from "../automation/provider";
import {applyQaBlockTheme} from "../qa/theme";
import {renderQaMarkdown} from "../qa/render";
import {activeTranslationService} from "../translation/defaults";
import {translateText} from "../translation/service";
import {choosePdf2zhOutput, ensurePdf2zhServer, Pdf2zhClient, translationOutputPath, writeTranslationPdf} from "../translation/pdf2zh";
import {checkDoc2xEnvironment, doc2xOutputPath, translateWithDoc2x} from "../translation/doc2x";
import type {NoteInsertionTarget, PluginHost} from "../host";
import {PreviewManager} from "./preview";
import {ScreenshotTool} from "./screenshot";
import {RectSelectTool, type RectSelection} from "./rect-select";
import {Pdf2zhHud} from "./pdf2zh-hud";
import {recognizeImage, type OcrResult} from "../ocr/client";
import {openOcrResultDialog} from "./ocr-dialog";
import {ensureOcrServer} from "../ocr/service";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
function qaSessionGroup(timestamp: number): string {
    const date = new Date(Number(timestamp) || Date.now());
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const value = date.getTime();
    if (value >= dayStart) return "今天";
    if (value >= dayStart - 24 * 60 * 60 * 1000) return "昨天";
    if (value >= dayStart - 7 * 24 * 60 * 60 * 1000) return "7天内";
    return "更早";
}

function formatRelativeTime(timestamp: number): string {
    const value = Number(timestamp) || 0;
    if (!value) return "未知时间";
    const diff = Date.now() - value;
    if (diff < 60_000) return "刚刚";
    if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
    const date = new Date(value);
    return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch] as string));
}

function pointerInPage(event: MouseEvent, page: HTMLElement): {x: number; y: number} {
    const rect = page.getBoundingClientRect();
    return {x: event.clientX - rect.left, y: event.clientY - rect.top};
}

type SideTab = "annotations" | "outline" | "search" | "backlinks";
type ViewMode = "actual" | "page" | "width" | "height" | "visible" | "custom";

interface HistoryEntry {
    page: number;
    scrollTop: number;
}

export class PdfReader {
    private pages: RenderedPageInfo[] = [];
    private annotations: Annotation[] = [];
    private screenshotRegions: ScreenshotRegion[] = [];
    private outline: OutlineEntry[] = [];
    private pdf: PdfDocument | null = null;
    private destroyPdf: (() => Promise<void>) | null = null;
    private zoom = DEFAULT_ZOOM;
    private currentPage = 1;
    private selectedColor = DEFAULT_COLOR;
    private selection: SelectionAnchor | null = null;
    private selectionRect: DOMRect | null = null;
    private translationPopup: HTMLElement | null = null;
    private translationAnchor: {page: number; x: number; y: number; w: number; h: number} | null = null;
    private translationTimer = 0;
    private translationOutsideHandler: ((event: PointerEvent) => void) | null = null;
    private translationSeq = 0;
    private readonly translationCache = new Map<string, string>();
    private qaPanel: HTMLElement | null = null;
    private qaMessagesElement: HTMLElement | null = null;
    private qaSessionsElement: HTMLElement | null = null;
    private qaTurnRailElement: HTMLElement | null = null;
    private qaInput: HTMLTextAreaElement | null = null;
    private qaAttachmentsElement: HTMLElement | null = null;
    private qaAttachments: QaAttachment[] = [];
    private qaBusy = false;
    private qaFloating = false;
    private qaSessionsOpen = false;
    private qaSelectionMode = false;
    private qaSelectedThreadIds = new Set<string>();
    private qaRenamingThreadId = "";
    private qaContextMenu: HTMLElement | null = null;
    private liveSelectionOverlay: HTMLElement | null = null;
    private liveSelectionFrame = 0;
    private clearLiveSelection = (): void => {
        this.liveSelectionOverlay?.remove();
        this.liveSelectionOverlay = null;
    };
    private onPagesScrollForSelection = (): void => {
        // The selection overlay uses viewport coordinates. Once the page moves,
        // keeping it would leave blue rectangles floating over unrelated content.
        this.clearLiveSelection();
    };
    private paintLiveSelection = (): void => {
        if (this.liveSelectionFrame) return;
        this.liveSelectionFrame = requestAnimationFrame(() => {
            this.liveSelectionFrame = 0;
            const selection = window.getSelection();
            const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
            const node = range?.commonAncestorContainer;
            const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
            const textLayer = element?.closest?.(".pz-text-layer");
            if (!range || !textLayer || selection?.isCollapsed || !this.element.contains(textLayer)) {
                this.clearLiveSelection();
                return;
            }
            let overlay = this.liveSelectionOverlay;
            if (!overlay) {
                overlay = document.createElement("div");
                overlay.className = "pz-live-selection";
                document.body.append(overlay);
                this.liveSelectionOverlay = overlay;
            }
            overlay.innerHTML = "";
            const page = textLayer.closest<HTMLElement>(".pz-page");
            const pageRect = page?.getBoundingClientRect();
            for (const rect of Array.from(range.getClientRects())) {
                if (!pageRect || rect.width <= 0 || rect.height <= 0) continue;
                const left = Math.max(rect.left, pageRect.left);
                const top = Math.max(rect.top, pageRect.top);
                const right = Math.min(rect.right, pageRect.right);
                const bottom = Math.min(rect.bottom, pageRect.bottom);
                if (right <= left || bottom <= top) continue;
                const item = document.createElement("div");
                item.className = "pz-live-selection-rect";
                item.style.left = `${left}px`;
                item.style.top = `${top}px`;
                item.style.width = `${right - left}px`;
                item.style.height = `${bottom - top}px`;
                overlay.append(item);
            }
        });
    };
    private qaTextMenu: HTMLElement | null = null;
    private closeQaMenuOnPointer = (event: PointerEvent): void => {
        const target = event.target as Node;
        if (this.qaContextMenu && !this.qaContextMenu.contains(target)) this.closeQaContextMenu();
        if (this.qaTextMenu && !this.qaTextMenu.contains(target)) this.closeQaTextMenu();
    };
    private floatEl: HTMLElement | null = null;
    private preview = new PreviewManager();
    private screenshot: ScreenshotTool | null = null;
    private rectSelect: RectSelectTool | null = null;
    private ocrRectSelect: RectSelectTool | null = null;
    private destroyed = false;
    private scrollRaf = 0;
    private savePositionTimer = 0;
    private sideTab: SideTab = "annotations";
    private bookTitle = "";
    private searchQuery = "";
    private searchHits: SearchHit[] = [];
    private searchIndex = -1;
    private searchTimer = 0;
    private history: HistoryEntry[] = [];
    private historyIndex = -1;
    private hoveredAnnotationId = "";
    private insertionTarget: NoteInsertionTarget = {docId: ""};
    private reconcileTimer: any = 0;
    private regionMissingChecks = new Map<string, number>();
    private annotationMissingChecks = new Map<string, number>();
    private wheelZoomTimer = 0;
    private pendingWheelZoom = 0;
    private pendingWheelAnchor: {page: number; x: number; y: number; viewportX: number; viewportY: number} | null = null;
    private zoomGeneration = 0;
    private suppressScrollTrackingUntil = 0;
    private qualityRenderingPages = new Set<number>();
    private notePreviewCache = new Map<string, string>();
    private noteMutationObserver: MutationObserver | null = null;
    private noteMutationTimer = 0;
    private progressiveRenderTimer = 0;
    private renderGeneration = 0;
    private viewMode: ViewMode = "width";
    private resizeObserver: ResizeObserver | null = null;
    private resizeFitTimer = 0;
    private dismissPreview = (): void => {
        this.hoveredAnnotationId = "";
        this.preview.hide();
    };
    private dismissPreviewWhenHidden = (): void => {
        if (this.element.ownerDocument.hidden) this.dismissPreview();
    };
    private onSidePanelOutsidePointerDown = (event: PointerEvent): void => {
        if (!this.sideElement?.classList.contains("is-open")) return;
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (this.sideElement.contains(target)) return;
        // Let the toolbar button perform its normal toggle instead of closing
        // here and immediately reopening on click.
        if (target.closest?.('[data-act="panel"]')) return;
        this.sideElement.classList.remove("is-open");
    };

    private pagesElement!: HTMLElement;
    private sideElement!: HTMLElement;
    private titleElement!: HTMLElement;
    private pageInput!: HTMLInputElement;
    private pageTotal!: HTMLElement;
    private zoomLabel!: HTMLElement;
    private searchInput!: HTMLInputElement;
    private searchCount!: HTMLElement;
    private compactMeta!: HTMLElement;

    constructor(
        private readonly element: HTMLElement,
        private readonly host: PluginHost,
        private readonly data: ReaderOpenData,
    ) {
    }

    get attachmentId(): string {
        return this.data.attachmentId;
    }

    get rootElement(): HTMLElement {
        return this.element;
    }

    get toolbarElement(): HTMLElement | null {
        const owner = CSS.escape(this.attachmentId);
        return this.element.querySelector<HTMLElement>(`:scope > .pz-topbar[data-owner-attachment="${owner}"]`)
            || document.querySelector<HTMLElement>(`.pz-topbar[data-owner-attachment="${owner}"]`);
    }

    restoreToolbar(): void {
        const toolbar = this.toolbarElement;
        const body = this.element.querySelector<HTMLElement>(":scope > .pz-body");
        if (!toolbar || !body) return;
        toolbar.classList.remove("pz-shared-toolbar", "pz-host-caption");
        toolbar.style.removeProperty("display");
        toolbar.dataset.ownerAttachment = this.attachmentId;
        this.element.insertBefore(toolbar, body);
    }

    setWorkspaceActive(active: boolean): void {
        this.element.classList.toggle("is-workspace-active", active);
        this.element.classList.toggle("is-workspace-inactive", !active);
        this.element.setAttribute("aria-current", active ? "true" : "false");
        this.updateCompactMeta();
        if (!active) {
            this.sideElement?.classList.remove("is-open");
            this.hideFloat();
            this.dismissPreview();
        }
    }

    async revealTarget(
        page?: number,
        annotationId?: string,
        targetRect?: [number, number, number, number],
        targetColor?: string,
        targetRegionId?: string,
    ): Promise<void> {
        this.annotations = this.host.store.annotationsForAttachment(this.data.attachmentId);
        this.screenshotRegions = this.host.store.screenshotRegionsForAttachment(this.data.attachmentId);
        this.paintAll();
        const annotation = annotationId ? this.host.store.getAnnotation(annotationId) : undefined;
        if (annotation) {
            this.scrollToAnnotation(annotation, true);
            return;
        }
        const region = targetRegionId ? this.screenshotRegions.find(item => item.id === targetRegionId) : undefined;
        if (region) {
            this.scrollToScreenshotRegion(region);
            return;
        }
        if (targetRect) {
            this.scrollToPdfTarget(page || 1, targetRect, targetColor);
            return;
        }
        this.scrollToPage(page || this.currentPage, false, false);
    }

    async mount(): Promise<void> {
        this.element.classList.add("pz-reader");
        this.element.innerHTML = `
<div class="pz-toolbar pz-topbar">
  <span class="pz-reader-active-dot" aria-hidden="true"></span>
  <span class="pz-title" data-role="title">PDF</span>
  <span class="pz-compact-meta" data-role="compact-meta">p.1</span>
  <button data-act="outline" class="pz-tool-icon" title="目录" aria-label="目录"><svg viewBox="0 0 24 24"><path d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11"/></svg></button>
  <button data-act="ocr" class="pz-tool-icon" title="框选区域 OCR 识别公式/文字" aria-label="框选区域 OCR 识别"><svg viewBox="0 0 24 24"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9zM12 9v6"/></svg></button>
  <button data-act="pdf2zh" class="pz-tool-icon" title="整篇 PDF 翻译" aria-label="整篇 PDF 翻译"><svg viewBox="0 0 24 24"><path d="M4 5h10M9 5v14M4 19h10M16 8h4M18 6v4M16 16h4M18 14v4"/></svg></button>
  <button data-act="qa" class="pz-tool-icon" title="PDF AI 问答" aria-label="PDF AI 问答"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4zM8 9h8M8 12h5"/></svg></button>
  <button data-act="panel" class="pz-tool-icon" title="标注、搜索与反链" aria-label="标注、搜索与反链"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM9 5v14"/></svg></button>
  <span class="pz-sep"></span>
  <div class="pz-formatbar">
    ${HIGHLIGHT_COLORS.map(color => `<button class="pz-format-color${color.id === "none" ? " is-none" : ""}${this.selectedColor === color.id ? " is-active" : ""}" data-format-color="${color.id}" title="${color.label}" style="--pz-color:${color.value}"></button>`).join("")}
    <button data-act="format-link" class="pz-format-trigger" title="Link copy format" aria-label="Link copy format"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></svg><span class="pz-format-state"></span><span class="pz-format-caret">⌄</span></button>
    <button data-act="format-display" class="pz-format-trigger" title="Display text format" aria-label="Display text format"><svg viewBox="0 0 24 24"><path d="M5 5h14M12 5v14M8 19h8"/></svg><span class="pz-format-state"></span><span class="pz-format-caret">⌄</span></button>
    <button data-act="rect-link" class="pz-tool-icon pz-rect-btn" title="框选区域并插入/复制（截图 + PDF 区域链接）" aria-label="框选区域并插入或复制"><svg viewBox="0 0 24 24"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 9h8v6H8z"/></svg></button>
    <button data-act="write-file" class="pz-tool-icon pz-write-file" title="将高亮写入 PDF 文件" aria-label="将高亮写入 PDF 文件"><svg viewBox="0 0 24 24"><path d="M4 20l4.5-1 10-10-3.5-3.5-10 10zM13.5 7l3.5 3.5"/></svg></button>
  </div>
</div>
<div class="pz-body">
  <aside class="pz-side" data-role="side"></aside>
  <div class="pz-main">
    <div class="pz-pages" data-role="pages"></div>
    <div class="pz-bottombar">
      <button data-act="back" title="返回上一处">←</button>
      <button data-act="forward" title="前进">→</button>
      <button data-act="prev" title="上一页">上一页</button>
      <input class="pz-page-input" data-role="page" value="1" />
      <span class="pz-muted" data-role="total">/ 0</span>
      <button data-act="next" title="下一页">下一页</button>
      <span class="pz-sep"></span>
      <div class="pz-search-wrap">
        <input class="pz-search-input" data-role="search" placeholder="搜索 PDF" />
        <span class="pz-search-count" data-role="search-count"></span>
      </div>
      <span class="pz-sep"></span>
      <button data-act="zoom-out" title="缩小">−</button>
      <span data-role="zoom" style="min-width:44px;text-align:center">115%</span>
      <button data-act="zoom-in" title="放大">+</button>
      <button data-act="view-mode" class="pz-view-mode" title="页面显示模式"><span data-role="view-mode-label">适合宽度</span><span class="pz-format-caret">⌄</span></button>
    </div>
  </div>
</div>
<div class="pz-qa-panel" data-role="qa" hidden>
  <div class="pz-qa-resizer" data-role="qa-resizer" title="拖动调整宽度"></div>
  <div class="pz-qa-resize-handle is-n" data-qa-resize="n"></div>
  <div class="pz-qa-resize-handle is-e" data-qa-resize="e"></div>
  <div class="pz-qa-resize-handle is-s" data-qa-resize="s"></div>
  <div class="pz-qa-resize-handle is-w" data-qa-resize="w"></div>
  <div class="pz-qa-resize-handle is-ne" data-qa-resize="ne"></div>
  <div class="pz-qa-resize-handle is-nw" data-qa-resize="nw"></div>
  <div class="pz-qa-resize-handle is-se" data-qa-resize="se"></div>
  <div class="pz-qa-resize-handle is-sw" data-qa-resize="sw"></div>
  <div class="pz-qa-head" data-role="qa-head">
    <div><strong>PDF 问答</strong><small data-role="qa-title"></small><small data-role="qa-model"></small></div>
    <div class="pz-qa-head-actions">
      <button data-qa-act="threads" title="会话列表">会话</button>
      <button data-qa-act="new-thread" title="新建独立会话">新对话</button>
      <button data-qa-act="float" title="浮动/停靠">◫</button>
      <button data-qa-act="close" title="关闭">×</button>
    </div>
  </div>
  <div class="pz-qa-session-list" data-role="qa-sessions" hidden></div>
  <div class="pz-qa-turn-rail" data-role="qa-turn-rail" hidden></div>
  <div class="pz-qa-messages" data-role="qa-messages"></div>
  <div class="pz-qa-attachments" data-role="qa-attachments"></div>
  <div class="pz-qa-composer">
    <textarea data-role="qa-input" placeholder="针对这篇 PDF 提问，Enter 发送，Shift+Enter 换行"></textarea>
    <div class="pz-qa-composer-actions">
      <button data-qa-act="attach">附件</button>
      <select data-role="qa-mode">
        <option value="auto">选区/当前页 + 上下文</option>
        <option value="full">问全文</option>
      </select>
      <button data-qa-act="send" class="pz-primary">发送</button>
    </div>
  </div>
</div>`;
        this.pagesElement = this.element.querySelector<HTMLElement>('[data-role="pages"]')!;
        this.sideElement = this.element.querySelector<HTMLElement>('[data-role="side"]')!;
        this.titleElement = this.element.querySelector<HTMLElement>('[data-role="title"]')!;
        this.pageInput = this.element.querySelector<HTMLInputElement>('[data-role="page"]')!;
        this.pageTotal = this.element.querySelector<HTMLElement>('[data-role="total"]')!;
        this.zoomLabel = this.element.querySelector<HTMLElement>('[data-role="zoom"]')!;
        this.searchInput = this.element.querySelector<HTMLInputElement>('[data-role="search"]')!;
        this.searchCount = this.element.querySelector<HTMLElement>('[data-role="search-count"]')!;
        this.compactMeta = this.element.querySelector<HTMLElement>('[data-role="compact-meta"]')!;
        this.qaPanel = this.element.querySelector<HTMLElement>('[data-role="qa"]');
        this.qaMessagesElement = this.element.querySelector<HTMLElement>('[data-role="qa-messages"]');
        this.qaSessionsElement = this.element.querySelector<HTMLElement>('[data-role="qa-sessions"]');
        this.qaTurnRailElement = this.element.querySelector<HTMLElement>('[data-role="qa-turn-rail"]');
        this.qaInput = this.element.querySelector<HTMLTextAreaElement>('[data-role="qa-input"]');
        this.qaAttachmentsElement = this.element.querySelector<HTMLElement>('[data-role="qa-attachments"]');
        const bodyElement = this.element.querySelector<HTMLElement>(".pz-body");
        if (bodyElement && this.qaPanel) bodyElement.append(this.qaPanel);
        this.bindQaEvents();
        this.element.querySelector<HTMLElement>(":scope > .pz-topbar")!.dataset.ownerAttachment = this.attachmentId;
        this.updateFormatButtonLabels();
        this.updateWriteFileUi();
        this.updateColorUi();
        this.bindEvents();
        this.bindAutoFit();
        this.bindNoteMutationSync();
        await this.load();
    }

    destroy(): void {
        void this.destroyAsync();
    }

    async destroyAsync(preserveSession = false): Promise<void> {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.restoreToolbar();
        this.savePositionNow();
        if (!preserveSession) {
            const session = this.host.store.state.readerSession;
            session.readerAttachmentIds = (session.readerAttachmentIds || []).filter(id => id !== this.data.attachmentId);
            if (!session.readerAttachmentIds.length) {
                session.open = false;
                session.activeAttachmentId = "";
            } else if (session.activeAttachmentId === this.data.attachmentId) {
                session.activeAttachmentId = session.readerAttachmentIds[session.readerAttachmentIds.length - 1];
            }
            void this.host.store.save();
        }
        this.hideFloat();
        this.closeTranslationPopup();
        window.removeEventListener("resize", this.positionTranslationPopup);
        this.pagesElement.removeEventListener("scroll", this.positionTranslationPopup);
        this.preview.hide();
        this.screenshot?.destroy();
        this.rectSelect?.destroy();
        window.clearTimeout(this.wheelZoomTimer);
        window.clearTimeout(this.noteMutationTimer);
        window.clearTimeout(this.progressiveRenderTimer);
        window.clearTimeout(this.resizeFitTimer);
        this.renderGeneration++;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.noteMutationObserver?.disconnect();
        this.noteMutationObserver = null;
        this.element.ownerDocument.removeEventListener("pointerdown", this.dismissPreview, true);
        this.element.ownerDocument.removeEventListener("pointerdown", this.onSidePanelOutsidePointerDown, true);
        this.element.ownerDocument.removeEventListener("selectionchange", this.paintLiveSelection);
        this.pagesElement?.removeEventListener("scroll", this.onPagesScrollForSelection);
        this.clearLiveSelection();
        if (this.liveSelectionFrame) cancelAnimationFrame(this.liveSelectionFrame);
        this.element.ownerDocument.removeEventListener("pointerdown", this.closeQaMenuOnPointer, true);
        this.qaPanel?.removeEventListener("contextmenu", this.onQaTextContextMenu);
        this.closeQaContextMenu();
        this.closeQaTextMenu();
        this.element.ownerDocument.removeEventListener("visibilitychange", this.dismissPreviewWhenHidden);
        window.removeEventListener("blur", this.dismissPreview);
        document.querySelectorAll(".pz-edit-menu").forEach(item => item.remove());
        const clearIntervalFn = requireNode("timers")?.clearInterval || globalThis.clearInterval;
        clearIntervalFn(this.reconcileTimer);
        this.element.ownerDocument.removeEventListener("keydown", this.onKeyDown);
        if (this.destroyPdf) {
            await this.destroyPdf();
            this.destroyPdf = null;
        }
        this.pdf = null;
        this.element.classList.remove("pz-reader", "is-workspace-active", "is-workspace-inactive");
        this.element.classList.add("pz-reader-stale");
        this.element.dataset.pzDestroyed = "true";
        this.element.innerHTML = "";
    }

    private bindEvents(): void {
        this.element.ownerDocument.addEventListener("pointerdown", this.dismissPreview, true);
        this.element.ownerDocument.addEventListener("pointerdown", this.onSidePanelOutsidePointerDown, true);
        this.element.ownerDocument.addEventListener("selectionchange", this.paintLiveSelection);
        this.pagesElement.addEventListener("scroll", this.onPagesScrollForSelection, {passive: true});
        this.element.ownerDocument.addEventListener("visibilitychange", this.dismissPreviewWhenHidden);
        window.addEventListener("blur", this.dismissPreview);
        this.element.addEventListener("pointerdown", (event) => {
            // Clicking the shared toolbar must act on the active reader, not make
            // the host (top) reader active just because its toolbar was clicked.
            if ((event.target as HTMLElement).closest(".pz-topbar.pz-shared-toolbar")) return;
            this.host.activateReader(this.data.attachmentId);
        }, {capture: true});
        this.element.addEventListener("pz-reveal-target", ((event: CustomEvent) => {
            const detail = event.detail || {};
            void this.revealTarget(detail.page, detail.annotationId, detail.targetRect, detail.targetColor, detail.targetRegionId);
        }) as EventListener);
        this.element.querySelector(".pz-formatbar")?.addEventListener("click", (event) => {
            const colorButton = (event.target as HTMLElement).closest<HTMLElement>("[data-format-color]");
            if (!colorButton) {
                return;
            }
            this.applyToolbarColor(colorButton.dataset.formatColor || "yellow");
        });
        this.element.querySelectorAll(".pz-toolbar, .pz-bottombar").forEach(toolbar => {
            toolbar.addEventListener("click", (event) => {
                const target = (event.target as HTMLElement).closest<HTMLElement>("button[data-act]");
                if (!target) {
                    return;
                }
                this.runToolbarAction(target.dataset.act || "", target);
            });
        });
        this.pageInput.addEventListener("change", () => {
            const page = Number.parseInt(this.pageInput.value, 10);
            if (Number.isFinite(page)) {
                this.navigateToPage(clamp(page, 1, Math.max(1, this.pages.length)), true, true);
            }
        });
        this.searchInput.addEventListener("input", () => {
            window.clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => this.runSearch(this.searchInput.value), 260);
        });
        this.searchInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) {
                    this.stepSearch(-1);
                } else {
                    this.stepSearch(1);
                }
            } else if (event.key === "Escape") {
                this.searchInput.value = "";
                this.runSearch("");
            }
        });
        this.pagesElement.addEventListener("mouseup", (event) => {
            if ((event.target as HTMLElement).closest(".pz-float")) {
                return;
            }
            if (this.screenshot?.isActive()) {
                return;
            }
            // Read the selection synchronously: hidden/occluded Electron windows throttle timers.
            this.captureSelection();
        });
        this.pagesElement.addEventListener("mousedown", () => {
            if (!this.screenshot?.isActive()) {
                this.hideFloat();
            }
        });
        this.pagesElement.addEventListener("mousemove", (event) => this.onPagesMouseMove(event), {passive: true});
        this.pagesElement.addEventListener("mouseleave", this.dismissPreview);
        this.pagesElement.addEventListener("click", (event) => this.onPagesClick(event));
        this.pagesElement.addEventListener("contextmenu", (event) => this.onContextMenu(event));
        this.pagesElement.addEventListener("scroll", () => {
            this.dismissPreview();
            this.onScroll();
        }, {passive: true});
        this.pagesElement.addEventListener("wheel", event => this.onWheelZoom(event), {passive: false});
        this.sideElement.addEventListener("click", (event) => {
            if ((event.target as HTMLElement).closest("[data-side-close]")) {
                this.sideElement.classList.remove("is-open");
                return;
            }
            const sideButton = (event.target as HTMLElement).closest<HTMLElement>("[data-side]");
            if (sideButton) {
                this.sideTab = sideButton.dataset.side as SideTab;
                this.renderSide();
                return;
            }
            const noteButton = (event.target as HTMLElement).closest<HTMLElement>("[data-note-block]");
            if (noteButton) {
                void this.host.openNoteBlock(noteButton.dataset.noteDoc || "", noteButton.dataset.noteBlock || "");
                return;
            }
            const outlineButton = (event.target as HTMLElement).closest<HTMLElement>("[data-outline-page]");
            if (outlineButton) {
                this.navigateToPage(Number(outlineButton.dataset.outlinePage), true, true);
                return;
            }
            const searchButton = (event.target as HTMLElement).closest<HTMLElement>("[data-search-index]");
            if (searchButton) {
                this.goToSearchHit(Number(searchButton.dataset.searchIndex));
                return;
            }
            const button = (event.target as HTMLElement).closest<HTMLElement>("button[data-ann]");
            if (button) {
                void this.onAnnotationAction(button.dataset.act || "", button.dataset.ann!);
            }
        });
        this.element.ownerDocument.addEventListener("keydown", this.onKeyDown);
        this.screenshot = new ScreenshotTool(this.pagesElement, capture => {
            void this.onScreenshot(capture);
        });
        this.screenshot.bind();
        this.rectSelect = new RectSelectTool(this.pagesElement, selection => {
            void this.onRectSelection(selection);
        });
        this.rectSelect.bind();
        this.ocrRectSelect = new RectSelectTool(this.pagesElement, selection => {
            void this.onOcrSelection(selection);
        });
        this.ocrRectSelect.bind();
        window.addEventListener("resize", this.positionTranslationPopup);
        this.pagesElement.addEventListener("scroll", this.positionTranslationPopup, {passive: true});
    }

    private bindAutoFit(): void {
        this.resizeObserver = new ResizeObserver(entries => {
            this.positionTranslationPopup();
            const rect = entries[0]?.contentRect;
            if (!rect || rect.width < 160 || rect.height < 160 || this.viewMode === "custom") return;
            window.clearTimeout(this.resizeFitTimer);
            this.resizeFitTimer = window.setTimeout((): void => {
                void this.applyViewMode(false);
            }, 120);
        });
        this.resizeObserver.observe(this.pagesElement);
    }

    private bindNoteMutationSync(): void {
        this.noteMutationObserver = new MutationObserver(records => {
            if (!records.some(record => (record.target as HTMLElement).closest?.(".protyle-wysiwyg"))) return;
            window.clearTimeout(this.noteMutationTimer);
            this.noteMutationTimer = window.setTimeout((): void => {
                void this.reconcileScreenshotRegionsFromOpenNotes();
            }, 60);
        });
        this.noteMutationObserver.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ["src", "data-src"]});
    }

    private async reconcileScreenshotRegionsFromOpenNotes(): Promise<void> {
        const removed: ScreenshotRegion[] = [];
        for (const region of this.screenshotRegions.filter(item => item.noteBlockId)) {
            // Protyle inserts the block before its image DOM is fully hydrated.
            if (Date.now() - region.createdAt < 1500) continue;
            const blocks = Array.from(document.querySelectorAll<HTMLElement>(`[data-node-id="${CSS.escape(region.noteBlockId)}"]`));
            if (!blocks.length) continue;
            const assetName = region.assetPath.split(/[\\/]/).pop() || region.assetPath;
            const stillPresent = blocks.some(block => Array.from(block.querySelectorAll<HTMLImageElement>("img")).some(image => {
                const source = image.dataset.src || image.getAttribute("src") || "";
                return source.includes(assetName) || source.includes(region.id);
            }));
            if (!stillPresent) removed.push(region);
        }
        if (!removed.length) return;
        for (const region of removed) {
            this.host.store.removeScreenshotRegion(region.id);
            this.host.logDebug("region.sync.dom-deleted", {regionId: region.id, noteBlockId: region.noteBlockId});
        }
        this.screenshotRegions = this.host.store.screenshotRegionsForAttachment(this.data.attachmentId);
        await this.host.store.save();
        this.paintAll();
    }

    private readonly onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            this.hideFloat();
            this.preview.hide();
            if (this.screenshot?.isActive()) {
                this.screenshot.setActive(false);
                this.updateScreenshotButton();
            }
            this.rectSelect?.setActive(false);
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
            if (this.element.contains(document.activeElement) || this.element.offsetParent) {
                event.preventDefault();
                this.searchInput.focus();
            }
        }
    };

    private async load(): Promise<void> {
        const loadStarted = performance.now();
        const attachment = this.host.store.getAttachment(this.data.attachmentId);
        if (!attachment) {
            this.pagesElement.innerHTML = `<div class="pz-empty-reader">找不到 PDF 记录。请从左侧文献列表重新打开。</div>`;
            return;
        }
        this.host.store.state.lastReaderAttachmentId = attachment.id;
        const session = this.host.store.state.readerSession;
        session.readerAttachmentIds = Array.from(new Set([...(session.readerAttachmentIds || []), attachment.id]));
        session.activeAttachmentId = attachment.id;
        session.open = true;
        void this.host.store.save();
        const book = this.host.store.getBook(attachment.bookId);
        this.bookTitle = book?.title || attachment.fileName;
        const title = this.bookTitle;
        this.titleElement.textContent = title;
        this.element.dataset.attachmentId = attachment.id;
        this.host.activateReader(attachment.id);
        this.pageTotal.textContent = "/ …";
        this.pagesElement.innerHTML = `<div class="pz-empty-reader">正在读取 PDF：${escapeHtml(attachment.path || attachment.fileName)}</div>`;

        let loaded;
        try {
            loaded = await loadAttachmentBytes(attachment);
        } catch (error: any) {
            this.showLoadError("PDF 读取失败", error);
            return;
        }
        if (loaded.changed) {
            attachment.fingerprint = loaded.fingerprint;
            attachment.size = loaded.size;
            attachment.mtimeMs = loaded.mtimeMs;
            await this.host.store.save();
            showMessage("警告：PDF 内容已变化，旧标注可能发生偏移；不会自动跳到未经验证的位置。", 6000, "error");
        }
        this.pagesElement.innerHTML = "";
        try {
            const opened = await openPdfDocument(loaded.bytes);
            this.pdf = opened.pdf;
            this.destroyPdf = opened.destroy;
        } catch (error: any) {
            this.showLoadError("PDF.js 加载失败", error);
            return;
        }
        this.pageTotal.textContent = `/ ${this.pdf.numPages}`;
        this.annotations = this.host.store.annotationsForAttachment(attachment.id);
        this.screenshotRegions = this.host.store.screenshotRegionsForAttachment(attachment.id);
        await this.reconcileScreenshotRegions();
        const targetPage = clamp(this.data.page || attachment.lastPage || 1, 1, this.pdf.numPages);
        try {
            await this.renderAll(targetPage);
            await this.applyViewMode(false);
        } catch (error: any) {
            this.element.dataset.pzReaderError = error?.stack || error?.message || String(error);
            this.showLoadError("PDF 页面渲染失败", error);
            return;
        }
        this.host.logDebug("reader.load.complete", {
            attachmentId: attachment.id,
            pages: this.pdf.numPages,
            regions: this.screenshotRegions.length,
            durationMs: Math.round(performance.now() - loadStarted),
        });
        this.outline = await loadOutline(this.pdf);
        this.renderSide();
        const setIntervalFn = requireNode("timers")?.setInterval || globalThis.setInterval;
        this.reconcileTimer = setIntervalFn((): void => {
            void this.reconcileScreenshotRegions();
            void this.reconcileAnnotationNotes();
        }, 2000);
        const annotation = this.data.annotationId ? this.host.store.getAnnotation(this.data.annotationId) : undefined;
        if (annotation) {
            this.scrollToAnnotation(annotation, true);
            this.pushHistory(annotation.page);
            return;
        }
        if (this.data.targetRegionId) {
            const region = this.screenshotRegions.find(item => item.id === this.data.targetRegionId);
            if (region) {
                this.scrollToScreenshotRegion(region);
                this.pushHistory(this.currentPage);
                return;
            }
        }
        if (this.data.targetRect) {
            this.scrollToPdfTarget(targetPage, this.data.targetRect, this.data.targetColor);
            this.pushHistory(this.currentPage);
            return;
        }
        this.scrollToPage(targetPage, false, false);
        if (attachment.scrollRatio) {
            const info = this.pages[targetPage - 1];
            if (info) {
                this.pagesElement.scrollTop += attachment.scrollRatio * info.height;
            }
        }
        this.pushHistory(this.currentPage);
    }

    private async renderAll(priorityPage = 1): Promise<void> {
        if (!this.pdf) {
            return;
        }
        const pdf = this.pdf;
        const generation = ++this.renderGeneration;
        this.pagesElement.innerHTML = "";
        this.pages = [];
        const sample = await pdf.getPage(priorityPage);
        const sampleViewport = sample.getViewport({scale: this.zoom});
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const element = document.createElement("div");
            element.className = "pz-page pz-page-placeholder";
            element.dataset.page = String(pageNumber);
            element.style.width = `${sampleViewport.width}px`;
            element.style.height = `${sampleViewport.height}px`;
            element.style.setProperty("--total-scale-factor", String(this.zoom));
            element.dataset.layoutScale = this.zoom.toFixed(4);
            element.dataset.baseWidth = (sampleViewport.width / this.zoom).toFixed(4);
            element.dataset.baseHeight = (sampleViewport.height / this.zoom).toFixed(4);
            element.innerHTML = `<div class="pz-page-loading">${pageNumber === priorityPage ? "正在渲染…" : pageNumber}</div><div class="pz-overlay"></div><div class="pz-search-layer"></div><div class="pz-links"></div><div class="pz-page-label">${pageNumber}</div>`;
            const placeholder: RenderedPageInfo = {
                element,
                pageNumber,
                width: sampleViewport.width,
                height: sampleViewport.height,
                rotation: sample.rotate || 0,
                viewport: sampleViewport,
            };
            this.pages.push(placeholder);
            this.pagesElement.append(element);
        }
        await this.renderProgressivePage(priorityPage, generation);
        this.updateZoomLabel();
        const remaining = Array.from({length: pdf.numPages}, (_, index) => index + 1)
            .filter(page => page !== priorityPage)
            .sort((a, b) => Math.abs(a - priorityPage) - Math.abs(b - priorityPage));
        this.scheduleProgressivePages(remaining, generation);
    }

    private scheduleProgressivePages(queue: number[], generation: number): void {
        window.clearTimeout(this.progressiveRenderTimer);
        const next = async (): Promise<void> => {
            if (this.destroyed || generation !== this.renderGeneration || !queue.length) {
                if (this.searchQuery && generation === this.renderGeneration) this.runSearch(this.searchQuery, false);
                return;
            }
            const pageNumber = queue.shift()!;
            await this.renderProgressivePage(pageNumber, generation);
            this.progressiveRenderTimer = window.setTimeout((): void => { void next(); }, 60);
        };
        this.progressiveRenderTimer = window.setTimeout((): void => { void next(); }, 60);
    }

    private async renderProgressivePage(pageNumber: number, generation: number): Promise<void> {
        if (!this.pdf || this.destroyed || generation !== this.renderGeneration) return;
        const old = this.pages[pageNumber - 1];
        if (!old?.element.classList.contains("pz-page-placeholder")) return;
        try {
            const pageScale = await this.viewScaleForPage(pageNumber);
            const info = await renderPage(this.pdf, pageNumber, {
                scale: pageScale,
                onStage: stage => { this.element.dataset.pzRenderStage = stage; },
            });
            if (this.destroyed || generation !== this.renderGeneration || !old.element.isConnected) return;
            old.element.replaceWith(info.element);
            this.pages[pageNumber - 1] = info;
            this.paintPage(info);
            await this.renderPageLinks(info);
        } catch (error: any) {
            old.element.querySelector<HTMLElement>(".pz-page-loading")!.textContent = "加载失败，滚动到此页重试";
            this.host.logDebug("reader.page.progressive-failed", {page: pageNumber, message: error?.message || String(error)}, "warn");
        }
    }

    private async renderPageLinks(info: RenderedPageInfo): Promise<void> {
        if (!this.pdf) {
            return;
        }
        const layer = info.element.querySelector<HTMLElement>(".pz-links");
        if (!layer) {
            return;
        }
        layer.innerHTML = "";
        try {
            const page = await this.pdf.getPage(info.pageNumber);
            const boxes = await getLinkBoxes(this.pdf, page, info.pageNumber, info.viewport);
            for (const box of boxes) {
                const button = document.createElement("button");
                button.className = "pz-link-box";
                button.style.left = `${box.rect.x * info.width}px`;
                button.style.top = `${box.rect.y * info.height}px`;
                button.style.width = `${box.rect.w * info.width}px`;
                button.style.height = `${box.rect.h * info.height}px`;
                button.title = box.title;
                button.dataset.linkPage = box.page ? String(box.page) : "";
                button.dataset.linkUrl = box.url || "";
                button.addEventListener("mouseenter", (event) => {
                    const trigger = this.host.store.state.settings.previewTrigger;
                    if (trigger === "alt" && !event.altKey) {
                        this.preview.hide();
                        return;
                    }
                    if (box.page && this.pdf) {
                        this.preview.showPage(this.pdf, box.page, button.getBoundingClientRect(), "PDF 内部链接");
                    } else if (box.url) {
                        this.preview.showHtml(`<div class="pz-preview-title">外部链接</div><div class="pz-preview-url">${escapeHtml(box.url)}</div>`, button.getBoundingClientRect());
                    }
                });
                button.addEventListener("mouseleave", () => this.preview.hide());
                button.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.preview.hide();
                    if (box.page) {
                        this.navigateToPage(box.page, true, true);
                    } else if (box.url) {
                        if (!openExternalUrl(box.url)) {
                            showMessage(`无法打开链接：${box.url}`, 5000, "error");
                        }
                    }
                });
                layer.append(button);
            }
        } catch {
            // Link annotations are optional.
        }
    }

    private paintPage(info: RenderedPageInfo): void {
        paintPageAnnotations(info, this.annotations.filter(a => a.page === info.pageNumber));
        const overlay = info.element.querySelector<HTMLElement>(".pz-overlay");
        if (!overlay) {
            return;
        }
        for (const region of this.screenshotRegions.filter(item => item.page === info.pageNumber)) {
            const marker = document.createElement("div");
            marker.className = "pz-screenshot-region";
            marker.dataset.regionId = region.id;
            marker.title = `${region.label}（右键可删除）`;
            marker.style.left = `${region.rect.x * info.width}px`;
            marker.style.top = `${region.rect.y * info.height}px`;
            marker.style.width = `${region.rect.w * info.width}px`;
            marker.style.height = `${region.rect.h * info.height}px`;
            marker.style.backgroundColor = colorToRgba(region.color, 0.28);
            overlay.append(marker);
        }
    }

    private paintAll(): void {
        for (const page of this.pages) {
            this.paintPage(page);
        }
    }

    private updateZoomLabel(): void {
        this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
        this.updateCompactMeta();
    }

    private async onToolbar(action: string, anchor?: HTMLElement): Promise<void> {
        if (action === "prev") {
            this.navigateToPage(this.currentPage - 1, true, true);
        } else if (action === "next") {
            this.navigateToPage(this.currentPage + 1, true, true);
        } else if (action === "back") {
            this.historyBack();
        } else if (action === "forward") {
            this.historyForward();
        } else if (action === "zoom-in") {
            await this.setZoom(this.zoom * 1.15);
        } else if (action === "zoom-out") {
            await this.setZoom(this.zoom / 1.15);
        } else if (action === "view-mode") {
            this.showViewModeMenu();
        } else if (action === "panel") {
            this.sideElement.classList.toggle("is-open");
            if (this.sideElement.classList.contains("is-open")) {
                this.renderSide();
            }
        } else if (action === "outline") {
            if (this.sideElement.classList.contains("is-open") && this.sideTab === "outline") {
                this.sideElement.classList.remove("is-open");
                return;
            }
            this.sideTab = "outline";
            this.sideElement.classList.add("is-open");
            this.renderSide();
        } else if (action === "format-link") {
            this.showFormatMenu("link", anchor);
        } else if (action === "format-display") {
            this.showFormatMenu("display", anchor);
        } else if (action === "customize-formats") {
            this.openFormatCustomize();
        } else if (action === "write-file") {
            const enabled = !this.host.store.state.settings.writePdfAnnotations;
            this.host.store.updateSettings({writePdfAnnotations: enabled});
            await this.host.store.save();
            this.updateWriteFileUi();
            showMessage(enabled ? "写入 PDF 标注模式已开启" : "写入 PDF 标注模式已关闭", 2500);
        } else if (action === "rect-link") {
            this.insertionTarget = this.host.captureNoteInsertionTarget();
            this.element.dataset.pzInsertionTarget = JSON.stringify({
                docId: this.insertionTarget.docId,
                blockId: this.insertionTarget.blockId || "",
                textOffset: this.insertionTarget.textOffset ?? -1,
                tracked: Boolean(this.insertionTarget.trackedHandle),
            });
            this.screenshot?.setActive(false);
            this.updateScreenshotButton();
            this.rectSelect?.setActive(true);
            showMessage("拖拽 PDF 矩形区域：插入截图并复制区域链接", 3000);
        } else if (action === "ocr") {
            this.screenshot?.setActive(false);
            this.rectSelect?.setActive(false);
            this.insertionTarget = this.host.captureNoteInsertionTarget();
            this.element.dataset.pzInsertionTarget = JSON.stringify({
                docId: this.insertionTarget.docId,
                blockId: this.insertionTarget.blockId || "",
                textOffset: this.insertionTarget.textOffset ?? -1,
                tracked: Boolean(this.insertionTarget.trackedHandle),
            });
            if (!this.host.store.state.settings.ocrServerPath?.trim()) {
                showMessage("请先在设置 → OCR 中选择本地服务目录", 4000, "error");
                return;
            }
            this.ocrRectSelect?.setActive(true);
            showMessage("拖拽框选公式或文本区域，松开后识别", 3000);
        } else if (action === "pdf2zh") {
            void this.translateWholePdf();
        } else if (action === "qa") {
            this.toggleQaPanel();
        } else if (action === "screenshot") {
            this.rectSelect?.setActive(false);
            const active = !this.screenshot?.isActive();
            if (active) {
                this.insertionTarget = this.host.captureNoteInsertionTarget();
                this.element.dataset.pzInsertionTarget = JSON.stringify({
                    docId: this.insertionTarget.docId,
                    blockId: this.insertionTarget.blockId || "",
                    textOffset: this.insertionTarget.textOffset ?? -1,
                    tracked: Boolean(this.insertionTarget.trackedHandle),
                });
            }
            this.screenshot?.setActive(active);
            this.updateScreenshotButton();
            if (active) {
                showMessage("截图模式：在 PDF 页面上拖动框选区域", 3000);
            }
        }
    }

    private updateScreenshotButton(): void {
        const button = this.element.querySelector<HTMLElement>('[data-act="screenshot"]');
        button?.classList.toggle("is-active", Boolean(this.screenshot?.isActive()));
    }

    private showViewModeMenu(): void {
        const button = this.element.querySelector<HTMLElement>('[data-act="view-mode"]');
        const rect = button?.getBoundingClientRect();
        document.querySelectorAll(".pz-view-menu").forEach(item => item.remove());
        const options: Array<[ViewMode, string, string]> = [
            ["actual", "1:1", "实际大小"],
            ["page", "▣", "缩放到页面级别"],
            ["width", "↔", "适合宽度"],
            ["height", "↕", "适合高度"],
            ["visible", "□", "适合可见区域"],
        ];
        const menu = document.createElement("div");
        menu.className = "pz-format-menu pz-view-menu";
        menu.innerHTML = options.map(([value, icon, label]) => `<button data-view-mode="${value}" class="${this.viewMode === value ? "is-active" : ""}"><span>${this.viewMode === value ? "✓" : icon}</span>${label}</button>`).join("");
        menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 210, rect?.left || 80))}px`;
        menu.style.top = `${Math.max(8, (rect?.top || 80) - 190)}px`;
        menu.addEventListener("click", event => {
            const target = (event.target as HTMLElement).closest<HTMLElement>("[data-view-mode]");
            if (!target) return;
            this.viewMode = target.dataset.viewMode as ViewMode;
            menu.remove();
            this.updateViewModeLabel();
            void this.applyViewMode(true);
        });
        document.body.append(menu);
        window.setTimeout((): void => {
            document.addEventListener("pointerdown", event => {
                if (!menu.contains(event.target as Node) && event.target !== button) menu.remove();
            }, {once: true, capture: true});
        }, 0);
    }

    private updateViewModeLabel(): void {
        const labels: Record<ViewMode, string> = {
            actual: "实际大小", page: "适合页面", width: "适合宽度", height: "适合高度", visible: "适合可见", custom: "自定义",
        };
        const label = this.element.querySelector<HTMLElement>('[data-role="view-mode-label"]');
        if (label) label.textContent = labels[this.viewMode];
    }

    applyToolbarColor(colorId: string): void {
        this.selectedColor = colorId || "yellow";
        this.updateColorUi();
        if (this.selection) {
            const settings = this.host.store.state.settings;
            void this.executeSelectionProduct(this.selectedColor, settings.linkCopyFormat, settings.displayTextFormat);
        }
    }

    runToolbarAction(action: string, anchor?: HTMLElement): void {
        void this.onToolbar(action, anchor);
    }

    syncToolbarSelection(toolbar: HTMLElement): void {
        toolbar.querySelectorAll<HTMLElement>(".pz-format-color").forEach(item => {
            item.classList.toggle("is-active", item.dataset.formatColor === this.selectedColor);
        });
        this.updateFormatButtonLabels();
    }

    private updateColorUi(): void {
        const color = HIGHLIGHT_COLORS.find(item => item.id === this.selectedColor);
        const value = color?.value || "#ffd000";
        const selectionColor = value === "transparent" ? "#888" : value;
        this.pagesElement.style.setProperty("--pz-selection-color", selectionColor);
        this.pagesElement.style.setProperty(
            "--pz-selection-fill",
            value === "transparent" ? "rgba(128,128,128,.08)" : colorToRgba(value, 0.18),
        );
        this.element.querySelectorAll<HTMLElement>(".pz-format-color").forEach(item => {
            item.classList.toggle("is-active", item.dataset.formatColor === this.selectedColor);
        });
    }

    private updateFormatButtonLabels(): void {
        const settings = this.host.store.state.settings;
        const linkLabels: Record<LinkCopyFormat, string> = {
            quote: "Quote", link: "Link", embed: "Embed", callout: "Callout", "quote-callout": "Quote in a callout", custom: "Custom",
        };
        const displayLabels: Record<DisplayTextFormat, string> = {
            "title-page": "Title & page", page: "Page", text: "Text", emoji: "Emoji", none: "None", custom: "Custom",
        };
        const linkButton = this.element.querySelector<HTMLElement>('[data-act="format-link"]');
        const displayButton = this.element.querySelector<HTMLElement>('[data-act="format-display"]');
        if (linkButton) {
            linkButton.title = `Link copy format · ${linkLabels[settings.linkCopyFormat]}`;
            linkButton.setAttribute("aria-label", linkButton.title);
            const state = linkButton.querySelector<HTMLElement>(".pz-format-state");
            if (state) state.textContent = linkLabels[settings.linkCopyFormat];
        }
        if (displayButton) {
            displayButton.title = `Display text format · ${displayLabels[settings.displayTextFormat]}`;
            displayButton.setAttribute("aria-label", displayButton.title);
            const state = displayButton.querySelector<HTMLElement>(".pz-format-state");
            if (state) state.textContent = displayLabels[settings.displayTextFormat];
        }
    }

    private updateWriteFileUi(): void {
        const enabled = this.host.store.state.settings.writePdfAnnotations;
        const button = this.element.querySelector<HTMLElement>('[data-act="write-file"]');
        button?.classList.toggle("is-active", enabled);
        if (button) {
            button.title = enabled ? "写入 PDF 文件：开启" : "写入 PDF 文件：关闭";
            button.setAttribute("aria-pressed", String(enabled));
        }
    }

    private showFormatMenu(kind: "link" | "display", anchor?: HTMLElement): void {
        const settings = this.host.store.state.settings;
        const button = anchor || this.element.querySelector<HTMLElement>(`[data-act="format-${kind}"]`);
        const rect = button?.getBoundingClientRect();
        document.querySelectorAll(".pz-format-menu").forEach(item => item.remove());
        const options: Array<[string, LinkCopyFormat | DisplayTextFormat]> = kind === "link"
            ? [
                ["Quote", "quote"],
                ["Link", "link"],
                ["Embed", "embed"],
                ["Callout", "callout"],
                ["Quote in a callout", "quote-callout"],
            ]
            : [
                ["Title & page", "title-page"],
                ["Page", "page"],
                ["Text", "text"],
                ["Emoji", "emoji"],
                ["None", "none"],
            ];
        const active = kind === "link" ? settings.linkCopyFormat : settings.displayTextFormat;
        const menu = document.createElement("div");
        menu.className = "pz-format-menu";
        menu.dataset.formatMenu = kind;
        menu.innerHTML = options.map(([label, value]) => `<button data-format-value="${value}" class="${active === value ? "is-active" : ""}"><span>${active === value ? "✓" : ""}</span>${label}</button>`).join("")
            + `<button data-format-customize><span>⚙</span>Customize…</button>`;
        menu.style.left = `${Math.max(8, rect?.left || 80)}px`;
        menu.style.top = `${(rect?.bottom || 40) + 4}px`;
        menu.addEventListener("click", event => {
            const target = (event.target as HTMLElement).closest<HTMLElement>("button");
            if (!target) return;
            event.preventDefault();
            event.stopPropagation();
            if (target.hasAttribute("data-format-customize")) {
                menu.remove();
                this.openFormatCustomize(kind);
                return;
            }
            const value = target.dataset.formatValue;
            if (!value) return;
            if (kind === "link") this.host.store.updateSettings({linkCopyFormat: value as LinkCopyFormat});
            else this.host.store.updateSettings({displayTextFormat: value as DisplayTextFormat});
            void this.host.store.save();
            this.updateFormatButtonLabels();
            menu.remove();
        });
        document.body.append(menu);
        this.host.logDebug("format.menu.open", {kind, options: [...options.map(item => item[0]), "Customize…"]});
        window.setTimeout((): void => {
            document.addEventListener("pointerdown", event => {
                if (!menu.contains(event.target as Node) && event.target !== button) menu.remove();
            }, {once: true, capture: true});
        }, 0);
    }

    private openFormatCustomize(kind?: "link" | "display"): void {
        const settings = this.host.store.state.settings;
        const dialog = new Dialog({
            title: kind === "display" ? "PDF++ · Customize display text format" : kind === "link" ? "PDF++ · Customize link copy format" : "PDF++ · Customize formats",
            width: "620px",
            content: `<div class="b3-dialog__content">
  <div class="pz-muted" style="margin-bottom:10px">使用 {{linkWithDisplay}}、{{link}}、{{display}}、{{text}}、{{title}}、{{page}}、{{file}}、{{pageLabel}} 占位符。</div>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px">
    <span>Display text template</span>
    <textarea class="b3-text-field fn__block" data-field="displayTemplate" rows="2">${settings.displayTextTemplate}</textarea>
  </label>
  <label class="fn__flex" style="flex-direction:column;gap:4px">
    <span>Link copy template</span>
    <textarea class="b3-text-field fn__block" data-field="linkTemplate" rows="5">${settings.linkCopyTemplate}</textarea>
  </label>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="save">保存</button></div>`,
        });
        dialog.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => dialog.destroy());
        dialog.element.querySelector('[data-act="save"]')?.addEventListener("click", async () => {
            const displayTemplate = dialog.element.querySelector<HTMLTextAreaElement>('[data-field="displayTemplate"]')?.value || "";
            const linkTemplate = dialog.element.querySelector<HTMLTextAreaElement>('[data-field="linkTemplate"]')?.value || "";
            this.host.store.updateSettings({
                displayTextTemplate: displayTemplate.trim() || "{{file}}, p.{{page}}",
                linkCopyTemplate: linkTemplate.trim() || "{{linkWithDisplay}}",
                ...(kind !== "link" ? {displayTextFormat: "custom" as const} : {}),
                ...(kind !== "display" ? {linkCopyFormat: "custom" as const} : {}),
            });
            await this.host.store.save();
            this.updateFormatButtonLabels();
            dialog.destroy();
            showMessage("已保存自定义 PDF++ 格式", 3000);
        });
    }

    private async setZoom(zoom: number, anchor?: {page: number; x: number; y: number; viewportX: number; viewportY: number}, manual = true): Promise<void> {
        if (manual) {
            this.viewMode = "custom";
            this.updateViewModeLabel();
        }
        const page = anchor?.page || this.currentPage;
        this.applyZoomLayout(zoom, anchor);
        await this.refreshPageQuality(page, this.zoomGeneration);
    }

    private applyZoomLayout(zoom: number, anchor?: {page: number; x: number; y: number; viewportX: number; viewportY: number}): void {
        const previousZoom = this.zoom;
        const nextZoom = clamp(zoom, 0.5, 3.5);
        if (!Number.isFinite(nextZoom) || Math.abs(nextZoom - previousZoom) < 0.0001) return;
        const ratio = nextZoom / previousZoom;
        this.zoom = nextZoom;
        this.clearLiveSelection();
        this.zoomGeneration++;
        this.suppressScrollTrackingUntil = performance.now() + 650;
        for (const info of this.pages) {
            info.width *= ratio;
            info.height *= ratio;
            if (typeof info.viewport?.clone === "function") {
                info.viewport = info.viewport.clone({scale: nextZoom});
            }
            info.element.style.width = `${info.width}px`;
            info.element.style.height = `${info.height}px`;
            info.element.dataset.layoutScale = nextZoom.toFixed(4);
            info.element.style.setProperty("--total-scale-factor", String(nextZoom));
            const canvas = info.element.querySelector<HTMLCanvasElement>(".pz-canvas");
            if (canvas) {
                canvas.style.width = `${info.width}px`;
                canvas.style.height = `${info.height}px`;
            }
            const textLayer = info.element.querySelector<HTMLElement>(".pz-text-layer");
            if (textLayer) {
                textLayer.style.width = `${info.width}px`;
                textLayer.style.height = `${info.height}px`;
            }
            info.element.querySelectorAll<HTMLElement>(".pz-link-box").forEach(link => {
                for (const property of ["left", "top", "width", "height"] as const) {
                    const value = Number.parseFloat(link.style[property] || "0");
                    link.style[property] = `${value * ratio}px`;
                }
            });
            this.paintPage(info);
        }
        this.updateZoomLabel();
        if (anchor) {
            const target = this.pages[anchor.page - 1];
            if (target) {
                this.currentPage = anchor.page;
                this.pageInput.value = String(anchor.page);
                this.pagesElement.scrollLeft = Math.max(0, target.element.offsetLeft + anchor.x * target.width - anchor.viewportX);
                this.pagesElement.scrollTop = Math.max(0, target.element.offsetTop + anchor.y * target.height - anchor.viewportY);
            }
        } else {
            this.scrollToPage(this.currentPage, false, false);
        }
        if (this.searchQuery) {
            this.runSearch(this.searchQuery, false);
        }
    }

    private async refreshPageQuality(pageNumber: number, generation: number): Promise<void> {
        if (!this.pdf || this.destroyed || generation !== this.zoomGeneration || this.qualityRenderingPages.has(pageNumber)) return;
        const old = this.pages[pageNumber - 1];
        if (!old) return;
        const pageScale = await this.viewScaleForPage(pageNumber);
        if (Math.abs(Number(old.element.dataset.renderedZoom || 0) - pageScale) < 0.001) {
            if (pageNumber === this.currentPage) { this.zoom = pageScale; this.updateZoomLabel(); }
            return;
        }
        this.qualityRenderingPages.add(pageNumber);
        try {
            const fresh = await renderPage(this.pdf, pageNumber, {scale: pageScale});
            if (this.destroyed || generation !== this.zoomGeneration) return;
            old.element.replaceWith(fresh.element);
            this.pages[pageNumber - 1] = fresh;
            if (pageNumber === this.currentPage) { this.zoom = pageScale; this.updateZoomLabel(); }
            this.paintPage(fresh);
            await this.renderPageLinks(fresh);
            if (this.searchQuery) this.paintSearchHits();
        } catch (error: any) {
            this.host.logDebug("reader.zoom.quality-failed", {page: pageNumber, message: error?.message || String(error)}, "warn");
        } finally {
            this.qualityRenderingPages.delete(pageNumber);
        }
    }

    private onWheelZoom(event: WheelEvent): void {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        event.stopPropagation();
        this.viewMode = "custom";
        this.updateViewModeLabel();
        const pageElement = (event.target as HTMLElement).closest<HTMLElement>(".pz-page");
        const containerRect = this.pagesElement.getBoundingClientRect();
        if (pageElement) {
            const rect = pageElement.getBoundingClientRect();
            this.pendingWheelAnchor = {
                page: Number(pageElement.dataset.page || this.currentPage),
                x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
                y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
                viewportX: event.clientX - containerRect.left,
                viewportY: event.clientY - containerRect.top,
            };
        }
        const nextZoom = clamp(this.zoom * Math.exp(-event.deltaY * 0.0015), 0.5, 3.5);
        this.pendingWheelZoom = nextZoom;
        this.applyZoomLayout(nextZoom, this.pendingWheelAnchor || undefined);
        window.clearTimeout(this.wheelZoomTimer);
        this.wheelZoomTimer = window.setTimeout((): void => {
            const anchor = this.pendingWheelAnchor || undefined;
            this.pendingWheelZoom = 0;
            this.pendingWheelAnchor = null;
            const generation = this.zoomGeneration;
            void this.refreshPageQuality(anchor?.page || this.currentPage, generation).then(() => {
                this.host.logDebug("reader.wheel-zoom", {zoom: Number(this.zoom.toFixed(3)), page: anchor?.page || this.currentPage});
            });
        }, 180);
    }

    private scaleForDimensions(baseWidth: number, baseHeight: number): number {
        const width = Math.max(160, this.pagesElement.clientWidth);
        const height = Math.max(160, this.pagesElement.clientHeight);
        const widthScale = (width - 32) / baseWidth;
        const heightScale = (height - 36) / baseHeight;
        return this.viewMode === "actual" ? 1
            : this.viewMode === "width" ? widthScale
            : this.viewMode === "height" ? heightScale
            : this.viewMode === "visible" ? Math.min((width - 12) / baseWidth, (height - 12) / baseHeight)
            : Math.min(widthScale, heightScale);
    }

    private async viewScaleForPage(pageNumber: number): Promise<number> {
        if (!this.pdf || this.viewMode === "custom") return this.zoom;
        const page = await this.pdf.getPage(pageNumber);
        const base = page.getViewport({scale: 1});
        return clamp(this.scaleForDimensions(base.width, base.height), 0.5, 3.5);
    }

    private resizePageLayout(info: RenderedPageInfo, targetScale: number): void {
        const currentScale = Number(info.element.dataset.layoutScale || info.element.dataset.renderedZoom || this.zoom) || this.zoom;
        const ratio = targetScale / currentScale;
        if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.0001) return;
        info.width *= ratio;
        info.height *= ratio;
        if (typeof info.viewport?.clone === "function") info.viewport = info.viewport.clone({scale: targetScale});
        info.element.dataset.layoutScale = targetScale.toFixed(4);
        info.element.style.width = `${info.width}px`;
        info.element.style.height = `${info.height}px`;
        info.element.style.setProperty("--total-scale-factor", String(targetScale));
        const canvas = info.element.querySelector<HTMLCanvasElement>(".pz-canvas");
        if (canvas) { canvas.style.width = `${info.width}px`; canvas.style.height = `${info.height}px`; }
        const textLayer = info.element.querySelector<HTMLElement>(".pz-text-layer");
        if (textLayer) { textLayer.style.width = `${info.width}px`; textLayer.style.height = `${info.height}px`; }
        info.element.querySelectorAll<HTMLElement>(".pz-link-box").forEach(link => {
            for (const property of ["left", "top", "width", "height"] as const) {
                link.style[property] = `${Number.parseFloat(link.style[property] || "0") * ratio}px`;
            }
        });
        this.paintPage(info);
    }

    private async applyViewMode(announce: boolean): Promise<void> {
        if (!this.pdf || this.viewMode === "custom") return;
        const info = this.pages[this.currentPage - 1];
        const pageRect = info?.element.getBoundingClientRect();
        const containerRect = this.pagesElement.getBoundingClientRect();
        const anchor = info && pageRect && pageRect.width > 0 && pageRect.height > 0 ? {
            page: this.currentPage,
            x: clamp((containerRect.left + containerRect.width / 2 - pageRect.left) / pageRect.width, 0, 1),
            y: clamp((containerRect.top + containerRect.height / 2 - pageRect.top) / pageRect.height, 0, 1),
            viewportX: containerRect.width / 2,
            viewportY: containerRect.height / 2,
        } : undefined;
        this.zoomGeneration++;
        this.suppressScrollTrackingUntil = performance.now() + 500;
        for (const pageInfo of this.pages) {
            const currentScale = Number(pageInfo.element.dataset.layoutScale || pageInfo.element.dataset.renderedZoom || this.zoom) || this.zoom;
            const baseWidth = Number(pageInfo.element.dataset.baseWidth) || pageInfo.width / currentScale;
            const baseHeight = Number(pageInfo.element.dataset.baseHeight) || pageInfo.height / currentScale;
            this.resizePageLayout(pageInfo, clamp(this.scaleForDimensions(baseWidth, baseHeight), 0.5, 3.5));
        }
        this.zoom = await this.viewScaleForPage(this.currentPage);
        this.updateZoomLabel();
        if (anchor) {
            const target = this.pages[anchor.page - 1];
            this.pagesElement.scrollLeft = Math.max(0, target.element.offsetLeft + anchor.x * target.width - anchor.viewportX);
            this.pagesElement.scrollTop = Math.max(0, target.element.offsetTop + anchor.y * target.height - anchor.viewportY);
        }
        await this.refreshPageQuality(this.currentPage, this.zoomGeneration);
        if (announce) showMessage(`PDF 显示：${this.element.querySelector('[data-role="view-mode-label"]')?.textContent || "自动"}`, 1800);
    }

    private onScroll(): void {
        if (!this.pages.length || this.scrollRaf || performance.now() < this.suppressScrollTrackingUntil) {
            return;
        }
        this.scrollRaf = requestAnimationFrame(() => {
            this.scrollRaf = 0;
            const container = this.pagesElement.getBoundingClientRect();
            // SiYuan briefly collapses inactive/custom tab panels during focus and window
            // switches. Geometry from that hidden state must never update reading progress.
            if (!this.pagesElement.isConnected || container.width < 100 || container.height < 100) {
                return;
            }
            const center = container.top + container.height / 2;
            let best = this.currentPage;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const page of this.pages) {
                const rect = page.element.getBoundingClientRect();
                const pageCenter = rect.top + rect.height / 2;
                const distance = Math.abs(pageCenter - center);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = page.pageNumber;
                }
            }
            if (best !== this.currentPage) {
                this.currentPage = best;
                this.pageInput.value = String(best);
                this.updateCompactMeta();
                void this.refreshPageQuality(best, this.zoomGeneration);
            }
            this.hideFloat();
            this.preview.hide();
            this.hoveredAnnotationId = "";
            this.scheduleSavePosition();
        });
    }

    private scheduleSavePosition(): void {
        window.clearTimeout(this.savePositionTimer);
        this.savePositionTimer = window.setTimeout(() => this.savePositionNow(), 700);
    }

    private savePositionNow(): void {
        const attachment = this.host.store.getAttachment(this.data.attachmentId);
        const info = this.pages[this.currentPage - 1];
        if (!attachment || !info) {
            return;
        }
        attachment.lastPage = this.currentPage;
        this.updateCompactMeta();
        attachment.scrollRatio = clamp(
            (this.pagesElement.scrollTop - info.element.offsetTop) / Math.max(1, info.height),
            0,
            1,
        );
        void this.host.store.save();
    }

    private scrollToPage(page: number, smooth = true, record = true): void {
        const clamped = clamp(page, 1, Math.max(1, this.pages.length));
        const info = this.pages[clamped - 1];
        if (!info) {
            return;
        }
        if (record && clamped !== this.currentPage) {
            this.pushHistory(this.currentPage);
        }
        this.currentPage = clamped;
        this.pageInput.value = String(clamped);
        this.updateCompactMeta();
        this.suppressScrollTrackingUntil = performance.now() + (smooth ? 500 : 120);
        const target = info.element.offsetTop - 8;
        this.pagesElement.scrollTo({top: target, behavior: smooth ? "smooth" : "auto"});
        this.scheduleSavePosition();
    }

    private updateCompactMeta(): void {
        if (!this.compactMeta) return;
        const total = this.pages.length || 0;
        this.compactMeta.textContent = `p.${this.currentPage}${total ? `/${total}` : ""} · ${Math.round(this.zoom * 100)}%`;
    }

    private navigateToPage(page: number, smooth = true, record = true): void {
        this.scrollToPage(page, smooth, record);
    }

    private scrollToAnnotation(annotation: Annotation, flash: boolean): void {
        const info = this.pages[annotation.page - 1];
        if (!info) {
            return;
        }
        this.currentPage = annotation.page;
        this.pageInput.value = String(annotation.page);
        this.suppressScrollTrackingUntil = performance.now() + 180;
        const first = annotation.rects[0];
        const targetCenter = info.element.offsetTop + (first ? (first.y + first.h / 2) * info.height : 0);
        this.pagesElement.scrollTo({
            top: Math.max(0, targetCenter - this.pagesElement.clientHeight / 2),
            behavior: "auto",
        });
        if (flash) {
            info.element.classList.remove("pz-flash");
            void info.element.offsetWidth;
            info.element.classList.add("pz-flash");
            window.setTimeout(() => info.element.classList.remove("pz-flash"), 2000);
        }
        this.scheduleSavePosition();
    }

    private scrollToPdfTarget(page: number, rect: [number, number, number, number], color = "yellow"): void {
        const info = this.pages[page - 1];
        if (!info) {
            return;
        }
        const rawWidth = info.width / this.zoom;
        const rawHeight = info.height / this.zoom;
        const [x1, y1, x2, y2] = rect;
        const left = clamp(Math.min(x1, x2) / rawWidth, 0, 1);
        const top = clamp(1 - Math.max(y1, y2) / rawHeight, 0, 1);
        const width = clamp(Math.abs(x2 - x1) / rawWidth, 0, 1 - left);
        const height = clamp(Math.abs(y2 - y1) / rawHeight, 0, 1 - top);
        const overlay = info.element.querySelector<HTMLElement>(".pz-overlay");
        const swatch = HIGHLIGHT_COLORS.find(item => item.id === color)?.value || color;
        if (overlay && width > 0 && height > 0) {
            const marker = document.createElement("div");
            marker.className = "pz-highlight pz-return-target";
            marker.style.left = `${left * info.width}px`;
            marker.style.top = `${top * info.height}px`;
            marker.style.width = `${width * info.width}px`;
            marker.style.height = `${height * info.height}px`;
            marker.style.backgroundColor = colorToRgba(swatch, 0.28);
            overlay.append(marker);
        }
        this.currentPage = page;
        this.pageInput.value = String(page);
        this.suppressScrollTrackingUntil = performance.now() + 180;
        const targetCenter = info.element.offsetTop + (top + height / 2) * info.height;
        this.pagesElement.scrollTo({
            top: Math.max(0, targetCenter - this.pagesElement.clientHeight / 2),
            behavior: "auto",
        });
        info.element.classList.add("pz-flash");
        window.setTimeout(() => info.element.classList.remove("pz-flash"), 2000);
        this.scheduleSavePosition();
    }

    private scrollToScreenshotRegion(region: ScreenshotRegion): void {
        const info = this.pages[region.page - 1];
        if (!info) {
            return;
        }
        this.currentPage = region.page;
        this.pageInput.value = String(region.page);
        this.suppressScrollTrackingUntil = performance.now() + 180;
        this.pagesElement.scrollTo({
            top: Math.max(0, info.element.offsetTop + (region.rect.y + region.rect.h / 2) * info.height - this.pagesElement.clientHeight / 2),
            behavior: "auto",
        });
        const marker = info.element.querySelector<HTMLElement>(`[data-region-id="${CSS.escape(region.id)}"]`);
        marker?.classList.remove("is-locating");
        if (marker) {
            void marker.offsetWidth;
            marker.classList.add("is-locating");
            window.setTimeout(() => marker.classList.remove("is-locating"), 1600);
        }
        this.host.logDebug("region.jump.complete", {regionId: region.id, attachmentId: region.attachmentId, page: region.page});
        this.scheduleSavePosition();
    }

    private async reconcileScreenshotRegions(): Promise<void> {
        const linked = this.screenshotRegions.filter(region => region.noteBlockId);
        if (!linked.length) {
            return;
        }
        const ids = linked.map(region => `'${region.noteBlockId.replaceAll("'", "''")}'`).join(",");
        try {
            const response = await fetch("/api/query/sql", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({stmt: `select id, markdown from blocks where id in (${ids})`}),
            });
            const result = await response.json();
            if (!response.ok || result.code !== 0) {
                return;
            }
            const rows = new Map<string, string>((result.data || []).map((row: any) => [String(row.id), String(row.markdown || "")] as [string, string]));
            const now = Date.now();
            const removed: ScreenshotRegion[] = [];
            for (const region of linked) {
                const markdown = rows.get(region.noteBlockId) || "";
                const assetName = region.assetPath.split(/[\\/]/).pop() || region.assetPath;
                // Deleting only the image leaves its paragraph block alive. The region is
                // linked to the image/link content, not merely to the containing block.
                if (markdown && (markdown.includes(assetName) || markdown.includes(region.id))) {
                    this.regionMissingChecks.delete(region.id);
                    continue;
                }
                // SiYuan updates the block index asynchronously after insertion.
                // A single early miss used to delete a brand-new source marker,
                // causing the visible disappear/reappear and same-page overwrite symptoms.
                if (now - region.createdAt < 5000) {
                    continue;
                }
                this.regionMissingChecks.set(region.id, 1);
                removed.push(region);
            }
            if (!removed.length) {
                return;
            }
            for (const region of removed) {
                if (!this.host.store.state.screenshotRegions[region.id]) {
                    continue;
                }
                this.host.store.removeScreenshotRegion(region.id);
                this.regionMissingChecks.delete(region.id);
                this.host.logDebug("region.sync.note-deleted", {regionId: region.id, noteBlockId: region.noteBlockId});
            }
            this.screenshotRegions = this.host.store.screenshotRegionsForAttachment(this.data.attachmentId);
            await this.host.store.save();
            this.paintAll();
        } catch (error: any) {
            this.host.logDebug("region.sync.failed", {message: error?.message || String(error)}, "warn");
        }
    }

    private async deleteScreenshotRegion(regionId: string): Promise<void> {
        const region = this.host.store.state.screenshotRegions[regionId];
        if (!region) {
            return;
        }
        const started = performance.now();
        if (region.noteBlockId) {
            try {
                const response = await fetch("/api/block/deleteBlock", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({id: region.noteBlockId}),
                });
                const result = await response.json();
                if (!response.ok || result.code !== 0) {
                    throw new Error(result.msg || `HTTP ${response.status}`);
                }
            } catch (error: any) {
                this.host.logDebug("region.delete.note-failed", {regionId, message: error?.message || String(error)}, "warn");
                showMessage(`删除对应笔记图片失败：${error?.message || String(error)}`, 5000, "error");
                return;
            }
        }
        this.host.store.removeScreenshotRegion(regionId);
        await this.host.store.save();
        this.screenshotRegions = this.host.store.screenshotRegionsForAttachment(this.data.attachmentId);
        this.paintAll();
        this.host.logDebug("region.delete.complete", {regionId, noteBlockId: region.noteBlockId, durationMs: Math.round(performance.now() - started)});
        showMessage("已删除 PDF 截图区域及对应笔记图片", 2500);
    }

    private async updateScreenshotRegionColor(regionId: string, colorId: string): Promise<void> {
        const color = HIGHLIGHT_COLORS.find(item => item.id === colorId)?.value || colorId;
        if (!this.host.store.updateScreenshotRegion(regionId, {color, colorId})) return;
        await this.host.store.save();
        this.screenshotRegions = this.host.store.screenshotRegionsForAttachment(this.data.attachmentId);
        this.paintAll();
        this.host.logDebug("region.color.updated", {regionId, colorId});
    }

    private async updateAnnotationColor(annotationId: string, colorId: string): Promise<void> {
        const annotation = this.host.store.getAnnotation(annotationId);
        if (!annotation) return;
        const color = HIGHLIGHT_COLORS.find(item => item.id === colorId)?.value || colorId;
        this.host.store.updateAnnotation(annotationId, {color});
        this.annotations = this.host.store.annotationsForAttachment(this.data.attachmentId);
        await this.host.store.save();
        const info = this.pages[annotation.page - 1];
        if (info) this.paintPage(info);
        for (const link of this.host.store.noteLinksForAnnotation(annotationId)) {
            void fetch("/api/attr/setBlockAttrs", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: link.siyuanBlockId, attrs: {
                    "custom-pdf-annotation-color": colorId,
                    "custom-pz-callout": "true",
                    "custom-pz-color": colorId,
                }}),
            });
            const block = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(link.siyuanBlockId)}"]`);
            block?.setAttribute("custom-pz-callout", "true");
            block?.setAttribute("custom-pz-color", colorId);
        }
        this.host.logDebug("annotation.color.updated", {annotationId, colorId, noteLinks: this.host.store.noteLinksForAnnotation(annotationId).length});
        showMessage(`高亮颜色已改为${HIGHLIGHT_COLORS.find(item => item.id === colorId)?.label || colorId}`, 2000);
    }

    private async deleteAnnotationAndNotes(annotationId: string): Promise<void> {
        const removed = this.host.store.removeAnnotation(annotationId);
        if (!removed.annotation) return;
        for (const link of removed.noteLinks) {
            try {
                const response = await fetch("/api/block/deleteBlock", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({id: link.siyuanBlockId}),
                });
                const result = await response.json();
                if (!response.ok || result.code !== 0) throw new Error(result.msg || `HTTP ${response.status}`);
            } catch (error: any) {
                this.host.logDebug("annotation.delete.note-failed", {annotationId, blockId: link.siyuanBlockId, message: error?.message || String(error)}, "warn");
            }
        }
        await this.host.store.save();
        this.annotations = this.host.store.annotationsForAttachment(this.data.attachmentId);
        this.paintAll();
        this.renderSide();
        this.host.logDebug("annotation.delete.complete", {annotationId, noteBlocks: removed.noteLinks.length});
        showMessage("已删除高亮及其关联笔记", 2500);
    }

    private async reconcileAnnotationNotes(): Promise<void> {
        const links = this.annotations.flatMap(annotation => this.host.store.noteLinksForAnnotation(annotation.id));
        if (!links.length) return;
        const ids = links.map(link => `'${link.siyuanBlockId.replaceAll("'", "''")}'`).join(",");
        try {
            const response = await fetch("/api/query/sql", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({stmt: `select id from blocks where id in (${ids})`}),
            });
            const result = await response.json();
            if (!response.ok || result.code !== 0) return;
            const existing = new Set((result.data || []).map((row: any) => String(row.id)));
            const affected = new Set<string>();
            let changed = false;
            for (const link of links) {
                if (existing.has(link.siyuanBlockId)) {
                    this.annotationMissingChecks.delete(link.id);
                    continue;
                }
                if (Date.now() - link.createdAt < 5000) continue;
                const checks = (this.annotationMissingChecks.get(link.id) || 0) + 1;
                this.annotationMissingChecks.set(link.id, checks);
                if (checks < 2) continue;
                this.host.store.removeNoteLink(link.id);
                this.annotationMissingChecks.delete(link.id);
                affected.add(link.annotationId);
                changed = true;
            }
            for (const annotationId of affected) {
                if (!this.host.store.noteLinksForAnnotation(annotationId).length) {
                    this.host.store.removeAnnotation(annotationId);
                    this.host.logDebug("annotation.sync.note-deleted", {annotationId});
                }
            }
            if (changed) {
                await this.host.store.save();
                this.annotations = this.host.store.annotationsForAttachment(this.data.attachmentId);
                this.paintAll();
                this.renderSide();
            }
        } catch (error: any) {
            this.host.logDebug("annotation.sync.failed", {message: error?.message || String(error)}, "warn");
        }
    }

    private pushHistory(page: number): void {
        const scrollTop = this.pagesElement.scrollTop;
        const last = this.history[this.historyIndex];
        if (last && last.page === page && Math.abs(last.scrollTop - scrollTop) < 8) {
            return;
        }
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push({page, scrollTop});
        if (this.history.length > 80) {
            this.history.shift();
        }
        this.historyIndex = this.history.length - 1;
    }

    private historyBack(): void {
        if (this.historyIndex <= 0) {
            return;
        }
        this.historyIndex--;
        this.restoreHistory(this.history[this.historyIndex]);
    }

    private historyForward(): void {
        if (this.historyIndex >= this.history.length - 1) {
            return;
        }
        this.historyIndex++;
        this.restoreHistory(this.history[this.historyIndex]);
    }

    private restoreHistory(entry: HistoryEntry): void {
        this.currentPage = entry.page;
        this.pageInput.value = String(entry.page);
        const info = this.pages[entry.page - 1];
        if (info) {
            this.pagesElement.scrollTo({top: entry.scrollTop || info.element.offsetTop - 8, behavior: "auto"});
        }
        this.scheduleSavePosition();
    }

    private clearUserSelection(): void {
        this.element.querySelectorAll(".pz-user-selection").forEach(item => item.remove());
    }

    private paintUserSelection(pageElement: HTMLElement, rects: Array<{x: number; y: number; w: number; h: number}>): void {
        this.clearUserSelection();
        const pageRect = pageElement.getBoundingClientRect();
        let overlay = pageElement.querySelector<HTMLElement>(".pz-selection-overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.className = "pz-selection-overlay";
            pageElement.append(overlay);
        }
        for (const rect of rects) {
            const item = document.createElement("div");
            item.className = "pz-user-selection";
            item.style.left = `${rect.x * pageRect.width}px`;
            item.style.top = `${rect.y * pageRect.height}px`;
            item.style.width = `${rect.w * pageRect.width}px`;
            item.style.height = `${rect.h * pageRect.height}px`;
            overlay.append(item);
        }
    }

    private captureSelection(): void {
        const debug: any = {at: Date.now()};
        const writeDebug = () => {
            this.element.dataset.pzSelectionDebug = JSON.stringify(debug);
        };
        const selection = window.getSelection();
        debug.collapsed = selection?.isCollapsed;
        debug.rangeCount = selection?.rangeCount || 0;
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            writeDebug();
            this.hideFloat();
            this.closeTranslationPopup();
            return;
        }
        const range = selection.getRangeAt(0);
        debug.text = range.toString().slice(0, 80);
        const start = range.startContainer;
        const startElement = start.nodeType === Node.ELEMENT_NODE ? start as HTMLElement : start.parentElement;
        debug.startTag = startElement?.tagName || "";
        const pageElement = startElement?.closest<HTMLElement>(".pz-page");
        debug.pageFound = Boolean(pageElement);
        debug.pageConnected = Boolean(pageElement && this.pagesElement.contains(pageElement));
        if (!pageElement || !this.pagesElement.contains(pageElement)) {
            writeDebug();
            return;
        }
        const pageNumber = Number.parseInt(pageElement.dataset.page || "1", 10);
        const info = this.pages[pageNumber - 1];
        debug.pageNumber = pageNumber;
        debug.pageInfo = Boolean(info);
        if (!info) {
            writeDebug();
            return;
        }
        const rawRects = Array.from(range.getClientRects());
        debug.rawRects = rawRects.length;
        debug.firstRawRect = rawRects[0] ? {x: Math.round(rawRects[0].left), y: Math.round(rawRects[0].top), w: Math.round(rawRects[0].width), h: Math.round(rawRects[0].height)} : null;
        const anchor = rectsFromSelection(range, pageElement, {
            page: pageNumber,
            pageWidth: info.width / this.zoom,
            pageHeight: info.height / this.zoom,
            rotation: info.rotation,
        });
        debug.anchor = Boolean(anchor);
        writeDebug();
        if (!anchor) {
            return;
        }
        this.selection = anchor;
        this.selectionRect = range.getBoundingClientRect();
        this.closeTranslationPopup(true);
        const rects = anchor.rects;
        this.translationAnchor = {
            page: anchor.page,
            x: Math.min(...rects.map(item => item.x)),
            y: Math.min(...rects.map(item => item.y)),
            w: Math.max(...rects.map(item => item.x + item.w)) - Math.min(...rects.map(item => item.x)),
            h: Math.max(...rects.map(item => item.y + item.h)) - Math.min(...rects.map(item => item.y)),
        };
        this.hideFloat();
        this.scheduleAutoTranslation();
    }

    private closeTranslationPopup(keepSelection = false): void {
        window.clearTimeout(this.translationTimer);
        this.translationTimer = 0;
        this.translationSeq++;
        if (this.translationOutsideHandler) {
            document.removeEventListener("pointerdown", this.translationOutsideHandler, true);
            this.translationOutsideHandler = null;
        }
        this.translationPopup?.remove();
        this.translationPopup = null;
        this.translationAnchor = null;
        if (!keepSelection) {
            this.selection = null;
            this.selectionRect = null;
            this.clearUserSelection();
            this.hideFloat();
            window.getSelection()?.removeAllRanges();
        }
    }

    private readonly positionTranslationPopup = (): void => {
        const popup = this.translationPopup;
        const anchor = this.translationAnchor;
        if (!popup || !anchor) return;
        const page = this.pagesElement.querySelector<HTMLElement>(`.pz-page[data-page="${anchor.page}"]`);
        if (!page) return;
        const pageRect = page.getBoundingClientRect();
        const paneRect = this.pagesElement.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        const anchorLeft = pageRect.left + anchor.x * pageRect.width;
        const anchorTop = pageRect.top + anchor.y * pageRect.height;
        const anchorRight = anchorLeft + anchor.w * pageRect.width;
        const anchorBottom = anchorTop + anchor.h * pageRect.height;
        const gap = 8;
        const minLeft = paneRect.left + gap;
        const maxLeft = Math.max(minLeft, paneRect.right - popupRect.width - gap);
        const minTop = paneRect.top + gap;
        const maxTop = Math.max(minTop, paneRect.bottom - popupRect.height - gap);
        const candidates = [
            {left: clamp(anchorLeft, minLeft, maxLeft), top: anchorBottom + gap},
            {left: clamp(anchorLeft, minLeft, maxLeft), top: anchorTop - popupRect.height - gap},
            {left: anchorRight + gap, top: clamp(anchorTop, minTop, maxTop)},
            {left: anchorLeft - popupRect.width - gap, top: clamp(anchorTop, minTop, maxTop)},
        ];
        const fits = (candidate: {left: number; top: number}) =>
            candidate.left >= minLeft && candidate.left <= maxLeft
            && candidate.top >= minTop && candidate.top <= maxTop;
        const chosen = candidates.find(fits) || {
            left: clamp(anchorLeft, minLeft, maxLeft),
            top: clamp(anchorBottom + gap, minTop, maxTop),
        };
        popup.style.left = `${chosen.left}px`;
        popup.style.top = `${chosen.top}px`;
    };

    private scheduleAutoTranslation(): void {
        const settings = this.host.store.state.settings;
        if (!settings.translationEnabled || !settings.translationAuto) return;
        const text = this.selection?.text?.trim() || "";
        if (text.length < Math.max(1, settings.translationMinChars || 2)) return;
        window.clearTimeout(this.translationTimer);
        this.translationTimer = window.setTimeout(() => {
            void this.translateSelection(false);
        }, 320);
    }

    private readonly qaPageTextCache = new Map<number, string>();

    private bindQaEvents(): void {
        const panel = this.qaPanel;
        if (!panel) return;
        this.element.ownerDocument.addEventListener("pointerdown", this.closeQaMenuOnPointer, true);
        panel.addEventListener("contextmenu", this.onQaTextContextMenu);
        panel.addEventListener("click", event => {
            const target = (event.target as HTMLElement).closest<HTMLElement>("[data-qa-act]");
            if (!target) return;
            const action = target.dataset.qaAct || "";
            if (action === "close") {
                panel.hidden = true;
                this.qaSessionsOpen = false;
                this.closeQaSessions();
            } else if (action === "new-thread") {
                this.host.store.qaCreateThread(this.data.attachmentId);
                void this.host.store.save();
                this.qaSessionsOpen = false;
                this.closeQaSessions();
                this.renderQa();
                this.qaInput?.focus();
            } else if (action === "threads") {
                this.qaSessionsOpen = !this.qaSessionsOpen;
                this.renderQaSessions();
            } else if (action === "float") {
                this.qaFloating = !this.qaFloating;
                panel.classList.toggle("is-floating", this.qaFloating);
                if (this.qaFloating) {
                    const settings = this.host.store.state.settings;
                    const width = Math.max(280, Math.min(720, Number(settings.qaPanelWidth) || 380));
                    const height = Math.max(320, Math.min(900, Number(settings.qaPanelHeight) || 560));
                    const rect = panel.getBoundingClientRect();
                    const parentRect = (panel.parentElement || this.element).getBoundingClientRect();
                    panel.style.width = `${width}px`;
                    panel.style.height = `${height}px`;
                    panel.style.left = `${Math.max(8, rect.left - parentRect.left)}px`;
                    panel.style.top = `${Math.max(8, rect.top - parentRect.top)}px`;
                } else {
                    panel.style.left = "";
                    panel.style.top = "";
                    panel.style.height = "";
                    const width = Math.max(280, Math.min(720, Number(this.host.store.state.settings.qaPanelWidth) || 360));
                    panel.style.flexBasis = `${width}px`;
                    panel.style.width = `${width}px`;
                }
            } else if (action === "attach") {
                this.pickQaAttachments();
            } else if (action === "send") {
                void this.sendQaQuestion();
            }
        });
        this.qaMessagesElement?.addEventListener("scroll", () => this.updateQaActiveTurn());
        const input = this.qaInput;
        input?.addEventListener("keydown", event => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void this.sendQaQuestion();
            }
        });
        const resizer = panel.querySelector<HTMLElement>('[data-role="qa-resizer"]');
        resizer?.addEventListener("pointerdown", event => {
            event.preventDefault();
            event.stopPropagation();
            const parentRect = this.element.getBoundingClientRect();
            const startX = event.clientX;
            const startWidth = panel.getBoundingClientRect().width;
            const move = (moveEvent: PointerEvent) => {
                const next = clamp(startWidth - (moveEvent.clientX - startX), 280, parentRect.width * 0.7);
                panel.style.flexBasis = `${next}px`;
                panel.style.width = `${next}px`;
            };
            const up = () => {
                document.removeEventListener("pointermove", move);
                document.removeEventListener("pointerup", up);
                const width = Math.round(panel.getBoundingClientRect().width);
                this.host.store.updateSettings({qaPanelWidth: width});
                void this.host.store.save();
            };
            document.addEventListener("pointermove", move);
            document.addEventListener("pointerup", up);
        });
        panel.querySelectorAll<HTMLElement>("[data-qa-resize]").forEach(handle => {
            handle.addEventListener("pointerdown", event => {
                if (!this.qaFloating) return;
                event.preventDefault();
                event.stopPropagation();
                const direction = handle.dataset.qaResize || "";
                const parent = panel.parentElement || this.element;
                const parentRect = parent.getBoundingClientRect();
                const startRect = panel.getBoundingClientRect();
                const startLeft = startRect.left - parentRect.left;
                const startTop = startRect.top - parentRect.top;
                const startWidth = startRect.width;
                const startHeight = startRect.height;
                const move = (moveEvent: PointerEvent) => {
                    const dx = moveEvent.clientX - event.clientX;
                    const dy = moveEvent.clientY - event.clientY;
                    let left = startLeft;
                    let top = startTop;
                    let width = startWidth;
                    let height = startHeight;
                    if (direction.includes("e")) width = startWidth + dx;
                    if (direction.includes("s")) height = startHeight + dy;
                    if (direction.includes("w")) {
                        width = startWidth - dx;
                        left = startLeft + dx;
                    }
                    if (direction.includes("n")) {
                        height = startHeight - dy;
                        top = startTop + dy;
                    }
                    width = Math.max(280, Math.min(parentRect.width - 8, width));
                    height = Math.max(320, Math.min(parentRect.height - 8, height));
                    if (direction.includes("w")) left = Math.max(0, Math.min(parentRect.width - width, left));
                    if (direction.includes("n")) top = Math.max(0, Math.min(parentRect.height - height, top));
                    panel.style.width = `${width}px`;
                    panel.style.height = `${height}px`;
                    panel.style.left = `${left}px`;
                    panel.style.top = `${top}px`;
                };
                const up = () => {
                    document.removeEventListener("pointermove", move);
                    document.removeEventListener("pointerup", up);
                    this.host.store.updateSettings({
                        qaPanelWidth: Math.round(panel.getBoundingClientRect().width),
                        qaPanelHeight: Math.round(panel.getBoundingClientRect().height),
                    });
                    void this.host.store.save();
                };
                document.addEventListener("pointermove", move);
                document.addEventListener("pointerup", up);
            });
        });
        const header = panel.querySelector<HTMLElement>('[data-role="qa-head"]');
        header?.addEventListener("pointerdown", event => {
            if ((event.target as HTMLElement).closest("button")) return;
            if (!this.qaFloating) return;
            event.preventDefault();
            const panelRect = panel.getBoundingClientRect();
            const parentRect = (panel.parentElement || this.element).getBoundingClientRect();
            const offsetX = event.clientX - panelRect.left;
            const offsetY = event.clientY - panelRect.top;
            const move = (moveEvent: PointerEvent) => {
                panel.style.left = `${clamp(moveEvent.clientX - parentRect.left - offsetX, 0, parentRect.width - panelRect.width)}px`;
                panel.style.top = `${clamp(moveEvent.clientY - parentRect.top - offsetY, 0, parentRect.height - panelRect.height)}px`;
            };
            const up = () => {
                document.removeEventListener("pointermove", move);
                document.removeEventListener("pointerup", up);
            };
            document.addEventListener("pointermove", move);
            document.addEventListener("pointerup", up);
        });
    }

    private toggleQaPanel(): void {
        const panel = this.qaPanel;
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
            const settings = this.host.store.state.settings;
            if (!this.qaFloating) {
                const width = Math.max(280, Math.min(720, Number(settings.qaPanelWidth) || 360));
                panel.style.flexBasis = `${width}px`;
                panel.style.width = `${width}px`;
                panel.style.height = "";
            } else {
                panel.style.width = `${Math.max(280, Math.min(720, Number(settings.qaPanelWidth) || 380))}px`;
                panel.style.height = `${Math.max(320, Math.min(900, Number(settings.qaPanelHeight) || 560))}px`;
            }
            const removed = this.host.store.pruneQaThreads(settings.qaHistoryDays || 15, settings.qaMaxThreadsPerPdf || 50);
            if (removed) void this.host.store.save();
            this.renderQa();
            this.qaInput?.focus();
        }
    }

    private renderQa(): void {
        const panel = this.qaPanel;
        const list = this.qaMessagesElement;
        if (!panel || !list) return;
        const settings = this.host.store.state.settings;
        const modelLabel = panel.querySelector<HTMLElement>('[data-role="qa-model"]');
        if (modelLabel) modelLabel.textContent = settings.qaModelId ? `模型：${settings.qaModelId}` : "模型：思源当前 AI";
        const thread = this.host.store.qaActiveThread(this.data.attachmentId);
        const titleLabel = panel.querySelector<HTMLElement>('[data-role="qa-title"]');
        if (titleLabel) titleLabel.textContent = thread.title || "新对话";
        list.innerHTML = "";
        if (!thread.messages.length) {
            const empty = document.createElement("div");
            empty.className = "pz-qa-empty";
            empty.textContent = "针对这篇 PDF 提问。默认会带当前选区/页面及前后文。";
            list.append(empty);
        }
        let turnIndex = 0;
        for (let index = 0; index < thread.messages.length; index++) {
            const message = thread.messages[index];
            const item = document.createElement("div");
            item.className = `pz-qa-message is-${message.role}`;
            item.dataset.qaMessageId = message.id;
            if (message.role === "user") {
                turnIndex++;
                item.dataset.qaTurnIndex = String(turnIndex);
            }
            const body = document.createElement("div");
            body.className = "pz-qa-text";
            if (message.role === "assistant") {
                body.innerHTML = renderQaMarkdown(message.text);
            } else {
                body.textContent = message.text;
            }
            item.append(body);
            if (message.attachments?.length) {
                const files = document.createElement("div");
                files.className = "pz-qa-message-files";
                files.textContent = message.attachments.map(file => `📎 ${file.name}`).join("  ");
                item.append(files);
            }
            if (message.sources?.length) {
                const source = document.createElement("div");
                source.className = "pz-qa-sources";
                source.append("来源：");
                for (const page of message.sources) {
                    const link = document.createElement("a");
                    link.textContent = `p.${page}`;
                    link.href = pdfPageHref(this.data.attachmentId, page);
                    link.addEventListener("click", event => {
                        event.preventDefault();
                        this.navigateToPage(page, true, true);
                    });
                    source.append(link);
                }
                item.append(source);
            }
            if (message.role === "assistant") {
                const question = index > 0 && thread.messages[index - 1]?.role === "user" ? thread.messages[index - 1].text.trim() : "";
                const isGreeting = !question || /^(你好|您好|hi|hello|嗨|在吗)[！!。.？?\s]*$/i.test(question);
                if (question && !isGreeting) {
                    const actions = document.createElement("div");
                    actions.className = "pz-qa-message-actions";
                    const insert = document.createElement("button");
                    insert.textContent = "插入 Q/A";
                    insert.addEventListener("click", () => void this.insertQaBlock(message, true));
                    const onlyAnswer = document.createElement("button");
                    onlyAnswer.textContent = "仅插入 A";
                    onlyAnswer.addEventListener("click", () => void this.insertQaBlock(message, false));
                    actions.append(insert, onlyAnswer);
                    item.append(actions);
                    item.dataset.question = question;
                }
            }
            list.append(item);
        }
        this.renderQaAttachments();
        this.renderQaTurnRail(thread);
        list.scrollTop = list.scrollHeight;
        requestAnimationFrame(() => this.updateQaActiveTurn());
    }

    private renderQaTurnRail(thread: QaThread): void {
        const rail = this.qaTurnRailElement;
        if (!rail) return;
        rail.innerHTML = "";
        const turns = thread.messages.filter(message => message.role === "user");
        if (!turns.length) {
            rail.hidden = true;
            return;
        }
        rail.hidden = false;
        for (let index = 0; index < turns.length; index++) {
            const message = turns[index];
            const marker = document.createElement("button");
            marker.className = "pz-qa-turn-marker";
            marker.dataset.qaRailMessageId = message.id;
            marker.dataset.qaTurnIndex = String(index + 1);
            const preview = message.text.replace(/\s+/g, " ").trim().slice(0, 120);
            marker.dataset.preview = `Q${index + 1}：${preview}`;
            marker.title = marker.dataset.preview;
            marker.setAttribute("aria-label", marker.dataset.preview);
            marker.addEventListener("click", () => {
                const target = this.qaMessagesElement?.querySelector<HTMLElement>(`[data-qa-message-id="${CSS.escape(message.id)}"]`);
                if (!target) return;
                target.scrollIntoView({block: "start", behavior: "smooth"});
                target.classList.add("is-jump-highlight");
                window.setTimeout(() => target.classList.remove("is-jump-highlight"), 1200);
            });
            rail.append(marker);
        }
        requestAnimationFrame(() => this.updateQaActiveTurn());
    }

    private updateQaActiveTurn(): void {
        const list = this.qaMessagesElement;
        const rail = this.qaTurnRailElement;
        if (!list || !rail || rail.hidden) return;
        const listTop = list.getBoundingClientRect().top;
        const turns = Array.from(list.querySelectorAll<HTMLElement>("[data-qa-turn-index]"));
        let active = 1;
        for (const item of turns) {
            if (item.getBoundingClientRect().top <= listTop + 24) active = Number(item.dataset.qaTurnIndex || active);
        }
        rail.querySelectorAll<HTMLElement>(".pz-qa-turn-marker").forEach(marker => {
            marker.classList.toggle("is-active", Number(marker.dataset.qaTurnIndex) === active);
        });
    }

    private renderQaSessions(): void {
        const panel = this.qaPanel;
        const list = this.qaSessionsElement;
        if (!panel || !list) return;
        if (!this.qaSessionsOpen) {
            this.closeQaSessions();
            return;
        }
        this.ensureQaSessionsPlacement();
        list.hidden = false;
        list.innerHTML = "";
        const head = document.createElement("div");
        head.className = "pz-qa-sessions-head";
        const label = document.createElement("strong");
        label.textContent = this.qaSelectionMode ? `已选 ${this.qaSelectedThreadIds.size} 个` : "会话";
        const headActions = document.createElement("div");
        headActions.className = "pz-qa-sessions-head-actions";
        if (this.qaSelectionMode) {
            const removeSelected = document.createElement("button");
            removeSelected.textContent = "删除所选";
            removeSelected.addEventListener("click", () => {
                if (!this.qaSelectedThreadIds.size) return;
                if (!window.confirm(`删除选中的 ${this.qaSelectedThreadIds.size} 个会话？`)) return;
                for (const id of this.qaSelectedThreadIds) this.host.store.deleteQaThread(id);
                this.qaSelectedThreadIds.clear();
                this.qaSelectionMode = false;
                void this.host.store.save();
                this.renderQaSessions();
                this.renderQa();
            });
            const cancel = document.createElement("button");
            cancel.textContent = "取消";
            cancel.addEventListener("click", () => {
                this.qaSelectionMode = false;
                this.qaSelectedThreadIds.clear();
                this.renderQaSessions();
            });
            headActions.append(removeSelected, cancel);
        }
        const close = document.createElement("button");
        close.textContent = "×";
        close.title = "关闭会话列表";
        close.addEventListener("click", () => {
            this.qaSessionsOpen = false;
            this.qaSelectionMode = false;
            this.closeQaSessions();
        });
        headActions.append(close);
        head.append(label, headActions);
        list.append(head);
        if (!this.qaSelectionMode) {
            const add = document.createElement("button");
            add.className = "pz-qa-session-new";
            add.textContent = "＋ 新对话";
            add.addEventListener("click", () => {
                this.host.store.qaCreateThread(this.data.attachmentId);
                void this.host.store.save();
                this.qaSessionsOpen = false;
                this.closeQaSessions();
                this.renderQa();
            });
            list.append(add);
        }
        const threads = this.host.store.qaThreadsFor(this.data.attachmentId);
        const active = this.host.store.qaActiveThread(this.data.attachmentId);
        const groups = new Map<string, typeof threads>();
        for (const thread of threads) {
            const group = thread.pinned ? "置顶" : qaSessionGroup(thread.updatedAt);
            const items = groups.get(group) || [];
            items.push(thread);
            groups.set(group, items);
        }
        for (const [group, items] of groups) {
            const groupLabel = document.createElement("div");
            groupLabel.className = "pz-qa-session-group";
            groupLabel.textContent = group;
            list.append(groupLabel);
            for (const thread of items) {
                const card = document.createElement("div");
                card.className = `pz-qa-session-card${thread.id === active.id ? " is-active" : ""}${this.qaSelectedThreadIds.has(thread.id) ? " is-selected" : ""}`;
                card.addEventListener("contextmenu", event => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.showQaThreadMenu(event, thread);
                });
                const main = document.createElement("button");
                main.className = "pz-qa-session-main";
                if (this.qaSelectionMode) {
                    const check = document.createElement("span");
                    check.className = "pz-qa-session-check";
                    check.textContent = this.qaSelectedThreadIds.has(thread.id) ? "☑" : "☐";
                    main.append(check);
                }
                const meta = document.createElement("small");
                meta.textContent = `${thread.messages.length} 条消息 · ${formatRelativeTime(thread.updatedAt)}`;
                if (this.qaRenamingThreadId === thread.id) {
                    const input = document.createElement("input");
                    input.className = "pz-qa-session-rename";
                    input.value = thread.title || "新对话";
                    const finish = (save: boolean) => {
                        if (save) this.host.store.renameQaThread(thread.id, input.value);
                        this.qaRenamingThreadId = "";
                        void this.host.store.save();
                        this.renderQaSessions();
                        this.renderQa();
                    };
                    input.addEventListener("click", event => event.stopPropagation());
                    input.addEventListener("keydown", event => {
                        event.stopPropagation();
                        if (event.key === "Enter") finish(true);
                        if (event.key === "Escape") finish(false);
                    });
                    input.addEventListener("blur", () => {
                        if (this.qaRenamingThreadId === thread.id) finish(true);
                    });
                    main.append(input, meta);
                    requestAnimationFrame(() => {
                        input.focus();
                        input.select();
                    });
                } else {
                    const title = document.createElement("strong");
                    title.textContent = thread.title || "新对话";
                    main.append(title, meta);
                }
                main.addEventListener("click", () => {
                    if (this.qaSelectionMode) {
                        if (this.qaSelectedThreadIds.has(thread.id)) this.qaSelectedThreadIds.delete(thread.id);
                        else this.qaSelectedThreadIds.add(thread.id);
                        this.renderQaSessions();
                        return;
                    }
                    this.host.store.setActiveQaThread(this.data.attachmentId, thread.id);
                    void this.host.store.save();
                    this.qaSessionsOpen = false;
                    this.closeQaSessions();
                    this.renderQa();
                });
                card.append(main);
                list.append(card);
            }
        }
        if (!threads.length) {
            const empty = document.createElement("div");
            empty.className = "pz-qa-session-empty";
            empty.textContent = "还没有会话";
            list.append(empty);
        }
    }

    private showQaThreadMenu(event: MouseEvent, thread: QaThread): void {
        this.closeQaContextMenu();
        const menu = document.createElement("div");
        menu.className = "pz-qa-context-menu";
        const addItem = (label: string, action: () => void, danger = false) => {
            const button = document.createElement("button");
            button.textContent = label;
            if (danger) button.classList.add("is-danger");
            button.addEventListener("click", () => {
                this.closeQaContextMenu();
                action();
            });
            menu.append(button);
        };
        addItem("重命名", () => {
            this.qaRenamingThreadId = thread.id;
            this.renderQaSessions();
        });
        addItem(thread.pinned ? "取消置顶" : "置顶", () => {
            this.host.store.toggleQaThreadPin(thread.id);
            void this.host.store.save();
            this.renderQaSessions();
        });
        addItem("分享", () => {
            const markdown = thread.messages.map(message => {
                const role = message.role === "user" ? "Q" : "A";
                return `## ${role}\n\n${message.text}`;
            }).join("\n\n");
            void navigator.clipboard?.writeText(markdown).then(
                () => showMessage("会话内容已复制", 1600),
                () => showMessage("复制失败", 2500, "error"),
            );
        });
        addItem("多选", () => {
            this.qaSelectionMode = true;
            this.qaSelectedThreadIds.clear();
            this.renderQaSessions();
        });
        addItem("删除", () => {
            if (!window.confirm("删除这个会话？")) return;
            this.host.store.deleteQaThread(thread.id);
            void this.host.store.save();
            this.renderQaSessions();
            this.renderQa();
        }, true);
        document.body.append(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(6, Math.min(window.innerWidth - rect.width - 6, event.clientX))}px`;
        menu.style.top = `${Math.max(6, Math.min(window.innerHeight - rect.height - 6, event.clientY))}px`;
        this.qaContextMenu = menu;
    }

    private closeQaContextMenu(): void {
        this.qaContextMenu?.remove();
        this.qaContextMenu = null;
    }

    private closeQaTextMenu(): void {
        this.qaTextMenu?.remove();
        this.qaTextMenu = null;
    }

    private onQaTextContextMenu = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null;
        const textElement = target?.closest<HTMLElement>(".pz-qa-text");
        if (!textElement) return;
        event.preventDefault();
        event.stopPropagation();
        this.closeQaContextMenu();
        this.closeQaTextMenu();
        const selection = window.getSelection();
        const selected = selection && selection.rangeCount && textElement.contains(selection.anchorNode)
            ? selection.toString().trim()
            : "";
        const menu = document.createElement("div");
        menu.className = "pz-qa-context-menu pz-qa-text-menu";
        const addItem = (label: string, action: () => void) => {
            const button = document.createElement("button");
            button.textContent = label;
            button.addEventListener("click", () => {
                this.closeQaTextMenu();
                action();
            });
            menu.append(button);
        };
        addItem(selected ? "复制" : "复制全部", () => void this.copyQaText(selected || textElement.innerText));
        addItem("复制为引用", () => void this.copyQaText(selected || textElement.innerText, true));
        addItem("插入笔记", () => {
            const text = selected || textElement.innerText;
            if (!text.trim()) return;
            const markdown = text.split(/\r?\n/).map(line => `> ${line}`).join("\n");
            void insertMarkdownAtCursor(markdown, this.host.captureNoteInsertionTarget()).then(blockId => {
                if (blockId) showMessage("已插入笔记", 1600);
                else showMessage("插入失败：请先在笔记中定位光标", 3000, "error");
            });
        });
        addItem("全选", () => {
            const range = document.createRange();
            range.selectNodeContents(textElement);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        });
        document.body.append(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(6, Math.min(window.innerWidth - rect.width - 6, event.clientX))}px`;
        menu.style.top = `${Math.max(6, Math.min(window.innerHeight - rect.height - 6, event.clientY))}px`;
        this.qaTextMenu = menu;
    }

    private async copyQaText(text: string, quote = false): Promise<void> {
        const value = quote ? text.split(/\r?\n/).map(line => `> ${line}`).join("\n") : text;
        try {
            await navigator.clipboard.writeText(value);
            showMessage("已复制", 1400);
        } catch {
            const textarea = document.createElement("textarea");
            textarea.value = value;
            textarea.style.position = "fixed";
            textarea.style.left = "-10000px";
            document.body.append(textarea);
            textarea.select();
            document.execCommand("copy");
            textarea.remove();
            showMessage("已复制", 1400);
        }
    }

    private ensureQaSessionsPlacement(): void {
        const panel = this.qaPanel;
        const list = this.qaSessionsElement;
        if (!panel || !list) return;
        const drawer = this.host.store.state.settings.qaSessionListPlacement === "drawer";
        if (drawer) {
            const body = panel.parentElement;
            if (body && list.parentElement !== body) body.append(list);
            list.classList.add("is-drawer");
            list.style.right = `${Math.ceil(panel.getBoundingClientRect().width)}px`;
        } else {
            if (list.parentElement !== panel) panel.insertBefore(list, this.qaMessagesElement);
            list.classList.remove("is-drawer");
            list.style.right = "";
        }
    }

    private closeQaSessions(): void {
        if (this.qaSessionsElement) this.qaSessionsElement.hidden = true;
    }

    private renderQaAttachments(): void {
        const container = this.qaAttachmentsElement;
        if (!container) return;
        container.innerHTML = "";
        for (const attachment of this.qaAttachments) {
            const chip = document.createElement("span");
            chip.className = "pz-qa-attachment-chip";
            chip.textContent = attachment.name;
            const remove = document.createElement("button");
            remove.textContent = "×";
            remove.addEventListener("click", () => {
                this.qaAttachments = this.qaAttachments.filter(item => item.id !== attachment.id);
                this.renderQaAttachments();
            });
            chip.append(remove);
            container.append(chip);
        }
    }

    private pickQaAttachments(): void {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = ".txt,.md,.markdown,.pdf";
        input.style.position = "fixed";
        input.style.left = "-10000px";
        document.body.append(input);
        input.addEventListener("change", () => {
            for (const file of Array.from(input.files || [])) {
                const path = getPathForFile(file);
                if (!path) continue;
                this.qaAttachments.push({
                    id: `qa-att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    name: file.name,
                    path,
                    mime: file.type || "",
                    size: file.size,
                });
            }
            input.remove();
            this.renderQaAttachments();
        });
        input.addEventListener("cancel", () => input.remove());
        input.click();
    }

    private async pageText(page: number): Promise<string> {
        const cached = this.qaPageTextCache.get(page);
        if (cached !== undefined) return cached;
        if (!this.pdf) return "";
        try {
            const pdfPage = await this.pdf.getPage(page);
            const content = await pdfPage.getTextContent();
            const text = (content.items || []).map((item: any) => String(item?.str || "")).join(" ").trim();
            this.qaPageTextCache.set(page, text);
            return text;
        } catch {
            return "";
        }
    }

    private async attachmentText(attachment: QaAttachment): Promise<string> {
        const fs = requireNode("fs");
        const lower = attachment.name.toLowerCase();
        try {
            if (/\.(txt|md|markdown|csv)$/i.test(lower)) {
                return String(fs?.readFileSync?.(attachment.path, "utf8") || "").slice(0, 20_000);
            }
            if (/\.pdf$/i.test(lower)) {
                const bytes = new Uint8Array(fs.readFileSync(attachment.path));
                const opened = await openPdfDocument(bytes);
                try {
                    let out = "";
                    for (let page = 1; page <= Math.min(opened.pdf.numPages, 20); page++) {
                        const pdfPage = await opened.pdf.getPage(page);
                        const content = await pdfPage.getTextContent();
                        out += `\n[p.${page}] ${(content.items || []).map((item: any) => item?.str || "").join(" ")}`;
                        if (out.length > 20_000) break;
                    }
                    return out.slice(0, 20_000);
                } finally {
                    await opened.destroy();
                }
            }

        } catch {
            return "";
        }
        return "";
    }

    private async buildQaContext(question: string): Promise<{context: string; sources: number[]}> {
        if (!this.pdf) return {context: "", sources: []};
        const settings = this.host.store.state.settings;
        const current = this.currentPage;
        const mode = (this.qaPanel?.querySelector<HTMLSelectElement>('[data-role="qa-mode"]')?.value || "auto");
        const sources = new Set<number>();
        let chunks: Array<{page: number; text: string}> = [];
        if (mode === "full") {
            const queryWords = question.toLowerCase().split(/[\s，。！？、；：,.!?;:]+/).filter(item => item.length >= 2).slice(0, 16);
            for (let page = 1; page <= this.pdf.numPages; page++) {
                const text = await this.pageText(page);
                if (!text) continue;
                let score = 0;
                for (const word of queryWords) if (text.toLowerCase().includes(word)) score += 1;
                chunks.push({page, text, score} as any);
            }
            chunks.sort((a: any, b: any) => b.score - a.score);
            chunks = chunks.slice(0, 8);
        } else {
            const selected = this.selection?.text?.trim();
            if (selected) {
                chunks.push({page: this.selection!.page, text: selected});
                sources.add(this.selection!.page);
            }
            const span = Math.max(1, Math.min(4, settings.qaContextPages || 2));
            for (let page = Math.max(1, current - span); page <= Math.min(this.pdf.numPages, current + span); page++) {
                const text = await this.pageText(page);
                if (text) chunks.push({page, text});
            }
        }
        chunks.sort((a, b) => a.page - b.page);
        let context = "";
        for (const chunk of chunks) {
            sources.add(chunk.page);
            const part = `\n\n[p.${chunk.page}]\n${chunk.text}`;
            if (context.length + part.length > 32_000) break;
            context += part;
        }
        for (const attachment of this.qaAttachments) {
            const text = await this.attachmentText(attachment);
            if (text) context += `\n\n[附件 ${attachment.name}]\n${text}`;
        }
        return {context: context.trim(), sources: [...sources].sort((a, b) => a - b)};
    }

    private async sendQaQuestion(): Promise<void> {
        if (this.qaBusy || !this.qaInput) return;
        const question = this.qaInput.value.trim();
        if (!question) return;
        this.qaBusy = true;
        const settings = this.host.store.state.settings;
        const userMessage: QaMessage = {
            id: `qa-${Date.now()}-u`,
            role: "user",
            text: question,
            createdAt: Date.now(),
            sources: [],
            attachments: [...this.qaAttachments],
        };
        const thread = this.host.store.qaActiveThread(this.data.attachmentId);
        this.host.store.addQaMessage(thread.id, userMessage);
        await this.host.store.save();
        this.qaInput.value = "";
        this.renderQa();
        const list = this.qaMessagesElement;
        const streamMessage = document.createElement("div");
        streamMessage.className = "pz-qa-message is-assistant";
        const streamBody = document.createElement("div");
        streamBody.className = "pz-qa-text pz-qa-loading";
        streamBody.textContent = "正在结合 PDF 上下文回答…";
        streamMessage.append(streamBody);
        if (list) {
            list.append(streamMessage);
            list.scrollTop = list.scrollHeight;
        }
        try {
            const {context} = await this.buildQaContext(question);
            const current = this.host.store.qaActiveThread(this.data.attachmentId);
            const history = current.messages.slice(-9, -1).map(item => `${item.role === "user" ? "用户" : "AI"}：${item.text}`).join("\n");
            const knowledgeRule = settings.qaKnowledgeMode === "pdf"
                ? [
                    "只依据下面的 PDF 上下文回答。",
                    "如果上下文中没有足够依据，明确说“文中未提及”，不要编造。",
                ]
                : [
                    "PDF 上下文只是参考资料，不是必须使用的限制。",
                    "问题与 PDF 有关且有依据时，优先使用 PDF 内容并标注页码。",
                    "如果 PDF 未提及该问题，或问题本身属于通用知识，可以直接用通用知识回答；但必须先说明“文中未提及”或“以下为通用知识，非 PDF 原文”，不要编造 PDF 页码。",
                    "如果问题中的术语疑似错别字、音译不统一或指向另一个常见术语，先说明你理解的正确术语，再回答；不要因为 PDF 里没有这个错词就拒绝。",
                ];
            const prompt = [
                "你是论文阅读助手，也可以回答与论文相关的通用科学问题。",
                ...knowledgeRule,
                "涉及文章内容时，在句末用 [p.页码] 标注来源，只标注实际引用的页。",
                "请使用 Markdown 输出：该分条的分条，该加粗的加粗，公式用 LaTeX 的 $...$ 或 $$...$$。",
                "用户只是问候时，用一两句话简短回应，不要输出能力清单，也不要主动总结全文。",
                "回答长度跟随问题；不要默认输出长篇报告。直接回答，不要先列“我能做什么”。",
                "",
                "PDF 上下文（可能与本问题无关，只在相关时使用）：",
                context || "（没有可用的 PDF 文本）",
                "",
                history ? `最近对话：\n${history}` : "",
                "",
                `用户问题：${question}`,
            ].filter(Boolean).join("\n");
            let lastPaint = 0;
            const answer = await chatWithSiyuanAIStream([
                {role: "system", content: "你是严谨的论文阅读助手。优先基于 PDF 证据；PDF 未提及时可以回答通用知识，但必须明确区分，不得编造 PDF 页码或内容。回答使用中文，只回答用户问的内容，必须使用 Markdown 格式输出。"},
                {role: "user", content: prompt},
            ], settings.qaModelId, (_delta, full) => {
                const now = Date.now();
                if (now - lastPaint < 80) return;
                lastPaint = now;
                streamBody.classList.remove("pz-qa-loading");
                streamBody.innerHTML = renderQaMarkdown(full);
                if (list) list.scrollTop = list.scrollHeight;
            });
            if (!answer.trim()) throw new Error("AI 返回空内容");
            streamBody.classList.remove("pz-qa-loading");
            streamBody.innerHTML = renderQaMarkdown(answer);
            const cited = [...answer.matchAll(/\[p\.?\s*(\d+)\]/gi)]
                .map(match => Number(match[1]))
                .filter(page => Number.isFinite(page) && page > 0);
            const sources = [...new Set(cited)].sort((a, b) => a - b);
            const assistantMessage: QaMessage = {
                id: `qa-${Date.now()}-a`,
                role: "assistant",
                text: answer,
                createdAt: Date.now(),
                sources,
                attachments: [],
            };
            this.host.store.addQaMessage(current.id, assistantMessage);
            await this.host.store.save();
            this.qaAttachments = [];
            this.renderQa();
        } catch (error: any) {
            showMessage(`PDF 问答失败：${error?.message || String(error)}`, 6000, "error");
            this.renderQa();
        } finally {
            this.qaBusy = false;
        }
    }

    private normalizeQaNoteText(text: string): string {
        const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
        const output: string[] = [];
        let inFence = false;
        let inDisplayMath = false;
        for (const rawLine of lines) {
            const line = rawLine.trimEnd();
            const trimmed = line.trim();
            if (/^```/.test(trimmed)) {
                inFence = !inFence;
                output.push(line);
                continue;
            }
            if (inFence) {
                output.push(line);
                continue;
            }
            if (/^\$\$/.test(trimmed)) {
                inDisplayMath = !inDisplayMath;
                output.push(line);
                continue;
            }
            if (inDisplayMath) {
                output.push(line);
                continue;
            }
            if (!trimmed) {
                output.push("");
                continue;
            }
            const structural = /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|)/.test(trimmed);
            if (!output.length || structural || !output[output.length - 1].trim()) {
                output.push(line.trimStart());
                continue;
            }
            const previous = output[output.length - 1];
            // AI output often puts every formula fragment on its own line. A
            // single newline is soft in Markdown, so keep it soft when importing
            // into a note instead of creating one hard line per token.
            output[output.length - 1] = `${previous.trimEnd()} ${trimmed}`;
        }
        return output.join("\n").trim();
    }

    private async findLatestQaBlockId(docId: string, title: string): Promise<string> {
        try {
            const token = String((window as any).siyuan?.config?.api?.token || "");
            const safeDoc = docId.replaceAll("'", "''");
            const safeTitle = title.replaceAll("'", "''").replaceAll("%", "\\%").replaceAll("_", "\\_");
            const response = await fetch("/api/query/sql", {
                method: "POST",
                headers: {"Content-Type": "application/json", ...(token ? {Authorization: `Token ${token}`} : {})},
                body: JSON.stringify({
                    stmt: `select id from blocks where root_id='${safeDoc}' and type='b' and markdown like '%${safeTitle}%' order by updated desc limit 1`,
                }),
            });
            const result = await response.json();
            return String(result.data?.[0]?.id || "");
        } catch {
            return "";
        }
    }

    private async insertQaBlock(message: QaMessage, includeQuestion: boolean): Promise<void> {
        const thread = this.host.store.qaActiveThread(this.data.attachmentId);
        const index = thread.messages.indexOf(message);
        const question = index > 0 && thread.messages[index - 1]?.role === "user" ? thread.messages[index - 1].text : "";
        const settings = this.host.store.state.settings;
        const title = settings.qaTitle || "PDF 问答";
        applyQaBlockTheme(settings);
        const sourceLinks = (message.sources || []).map(page => `[p.${page}](${pdfPageHref(this.data.attachmentId, page)})`).join(" · ");
        const quote = (text: string) => text.split(/\r?\n/).map(line => line ? `> ${line}` : ">").join("\n");
        const lines = [`> **${title}**`];
        if (includeQuestion && question) {
            lines.push(">", "> **Q**", ">", quote(question.trim()));
        }
        lines.push(">", "> **A**", ">", quote(this.normalizeQaNoteText(message.text)));
        if (sourceLinks) lines.push(">", `> 来源：${sourceLinks}`);
        const markdown = lines.join("\n");
        const insertionTarget = this.host.captureNoteInsertionTarget();
        let blockId = await insertMarkdownAtCursor(markdown, insertionTarget);
        if (insertionTarget.docId) {
            const latest = await this.findLatestQaBlockId(insertionTarget.docId, title);
            if (latest) blockId = latest;
        }
        if (!blockId) {
            showMessage("插入失败：请先打开笔记并确认光标位置", 5000, "error");
            return;
        }
        try {
            await fetch("/api/attr/setBlockAttrs", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(String((window as any).siyuan?.config?.api?.token || "") ? {Authorization: `Token ${String((window as any).siyuan?.config?.api?.token || "")}`} : {}),
                },
                body: JSON.stringify({id: blockId, attrs: {"custom-qa-block": "true"}}),
            });
        } catch {
            // Content is already inserted; attribute failure only affects styling.
        }
        showMessage(includeQuestion ? "已插入 Q/A" : "已插入回答", 1800);
    }

    private recordTranslationOutput(path: string, provider: "doc2x" | "pdf2zh", mode: string, targetLang: string): void {
        const attachment = this.host.store.getAttachment(this.data.attachmentId);
        const book = attachment ? this.host.store.getBook(attachment.bookId) : undefined;
        const pathApi = requireNode("path");
        const fileName = pathApi?.basename?.(path) || path.split(/[\\/]/).pop() || "translated.pdf";
        this.host.store.addTranslationOutput({
            path,
            fileName,
            provider,
            mode,
            targetLang,
            sourceAttachmentId: attachment?.id,
            sourceTitle: book?.title || attachment?.fileName || "",
            createdAt: Date.now(),
        });
        void this.host.store.save().then(() => this.host.refreshDock());
    }

    private async translateWholePdf(): Promise<void> {
        const settings = this.host.store.state.settings;
        const attachment = this.host.store.getAttachment(this.data.attachmentId);
        if (!attachment?.path || !fileExists(attachment.path)) {
            showMessage("当前 PDF 文件不可访问，无法整篇翻译", 4000, "error");
            return;
        }
        if (settings.wholeTranslationProvider === "doc2x") {
            await this.translateWholePdfWithDoc2x(attachment.path);
            return;
        }
        const client = new Pdf2zhClient(settings.pdf2zhBaseUrl);
        const hud = new Pdf2zhHud();
        hud.setIndeterminate("正在检查 PDF2zh 服务…");
        try {
            const server = await ensurePdf2zhServer(settings);
            if (!server.ok) {
                throw new Error(server.error || "PDF2zh 服务不可用");
            }
            const fileName = attachment.path.split(/[\\/]/).pop() || `${attachment.id}.pdf`;
            const outputPath = translationOutputPath(attachment.id, attachment.fingerprint, settings);
            if (fileExists(outputPath)) {
                hud.complete("使用已有翻译缓存");
                this.recordTranslationOutput(outputPath, "pdf2zh", settings.pdf2zhOutputMode, settings.pdf2zhTargetLang);
                const cached = await this.host.importLocalPath(outputPath);
                if (cached) this.host.openAttachment(cached);
                return;
            }
            hud.setStatus("正在上传 PDF 到 PDF2zh…");
            const waitStartedAt = Date.now();
            const waitTimer = window.setInterval(() => {
                hud.setWaiting(Math.floor((Date.now() - waitStartedAt) / 1000));
            }, 1000);
            let progressLogCount = 0;
            let progressPollBusy = false;
            const progressTimer = window.setInterval(async () => {
                if (progressPollBusy) return;
                progressPollBusy = true;
                try {
                    const progress = await client.progress();
                    if (!progress) return;
                    if (progress.progress > 0) hud.setProgress(progress.progress);
                    if (progress.logs.length < progressLogCount) progressLogCount = 0;
                    for (const line of progress.logs.slice(progressLogCount)) hud.addLog(line);
                    progressLogCount = progress.logs.length;
                } finally {
                    progressPollBusy = false;
                }
            }, 1200);
            let task: Awaited<ReturnType<typeof client.start>>;
            try {
                task = await client.start(attachment.path, fileName, settings);
            } finally {
                window.clearInterval(waitTimer);
                window.clearInterval(progressTimer);
            }
            if (!task.taskId) {
                task.progress = 100;
                task.finished = true;
                task.status = "完成";
            }
            const startedAt = Date.now();
            while (!task.finished && task.status !== "完成" && task.status !== "失败") {
                if (Date.now() - startedAt > 45 * 60_000) {
                    throw new Error("PDF2zh 翻译超时");
                }
                hud.setIndeterminate(task.message || `${task.status || "翻译中"}…`);
                await new Promise(resolve => setTimeout(resolve, 1200));
                if (!task.taskId) throw new Error("PDF2zh 没有返回任务 ID");
                const current = await client.task(task.taskId);
                if (current) {
                    task = current;
                    const value = Math.max(0, Math.min(100, Number(task.progress) || 0));
                    hud.setProgress(value, task.message || task.status || "翻译中");
                }
            }
            if (task.status === "失败") {
                throw new Error(task.message || task.error || "PDF2zh 翻译失败");
            }
            const outputFile = choosePdf2zhOutput(task, settings.pdf2zhOutputMode);
            if (!outputFile) {
                throw new Error("PDF2zh 没有返回可下载的 PDF");
            }
            hud.setIndeterminate("正在下载翻译结果…");
            const data = await client.download(outputFile);
            writeTranslationPdf(outputPath, data);
            this.recordTranslationOutput(outputPath, "pdf2zh", settings.pdf2zhOutputMode, settings.pdf2zhTargetLang);
            hud.complete("翻译完成");
            const imported = await this.host.importLocalPath(outputPath);
            if (imported) {
                this.host.openAttachment(imported);
            } else {
                hud.fail("翻译完成，但无法打开生成文件");
            }
        } catch (error: any) {
            hud.fail(String(error?.message || error || "PDF2zh 翻译失败"));
        }
    }

    private async translateWholePdfWithDoc2x(inputPath: string): Promise<void> {
        const settings = this.host.store.state.settings;
        const attachment = this.host.store.getAttachment(this.data.attachmentId);
        if (!attachment) return;
        if (!settings.doc2xConfigured) {
            showMessage("请先在设置 → Doc2X 勾选“我已配置完成解析&翻译设置”", 4000, "error");
            return;
        }
        const outputDir = doc2xOutputPath(attachment.id, attachment.fingerprint, settings);
        const fs = requireNode("fs");
        const path = requireNode("path");
        const findPdf = (dir: string): string => {
            if (!fs?.existsSync?.(dir)) return "";
            const stack = [dir];
            while (stack.length) {
                const current = stack.pop()!;
                let entries: any[] = [];
                try {
                    entries = fs.readdirSync(current, {withFileTypes: true});
                } catch {
                    continue;
                }
                for (const entry of entries) {
                    const full = path.join(current, entry.name);
                    if (entry.isDirectory()) stack.push(full);
                    else if (/\.pdf$/i.test(entry.name)) return full;
                }
            }
            return "";
        };
        const cached = findPdf(outputDir);
        if (cached) {
            this.recordTranslationOutput(cached, "doc2x", settings.doc2xOutputMode, settings.doc2xTargetLang);
            const imported = await this.host.importLocalPath(cached);
            if (imported) this.host.openAttachment(imported);
            return;
        }
        const hud = new Pdf2zhHud("Doc2X");
        hud.setIndeterminate("正在检查 Doc2X 环境…");
        try {
            const check = await checkDoc2xEnvironment(settings);
            if (!check.ok) {
                throw new Error(check.checks.filter(item => !item.ok).map(item => `${item.label}: ${item.detail}`).join("\n"));
            }
            hud.setStatus("正在调用 Doc2X CLI…");
            const startedAt = Date.now();
            const timer = window.setInterval(() => {
                hud.setWaiting(Math.floor((Date.now() - startedAt) / 1000));
            }, 1000);
            let result: Awaited<ReturnType<typeof translateWithDoc2x>>;
            try {
                result = await translateWithDoc2x(settings, inputPath, outputDir);
            } finally {
                window.clearInterval(timer);
            }
            const generated = result.files[0];
            if (!generated) throw new Error("Doc2X 没有返回 PDF");
            this.recordTranslationOutput(generated, "doc2x", settings.doc2xOutputMode, settings.doc2xTargetLang);
            hud.complete("Doc2X 翻译完成");
            const imported = await this.host.importLocalPath(generated);
            if (imported) {
                this.host.openAttachment(imported);
            } else {
                hud.fail("Doc2X 翻译完成，但无法打开生成文件");
            }
        } catch (error: any) {
            hud.fail(String(error?.message || error || "Doc2X 翻译失败"));
        }
    }

    private async translateSelection(manual: boolean): Promise<void> {
        const selection = this.selection;
        if (!selection?.text?.trim()) {
            if (manual) showMessage("请先在 PDF 中选择文字", 2000);
            return;
        }
        const settings = this.host.store.state.settings;
        if (!settings.translationEnabled) {
            showMessage("翻译功能未启用", 2500);
            return;
        }
        const service = activeTranslationService(settings);
        if (!service) {
            showMessage("没有可用的翻译服务，请在插件设置中配置", 4000, "error");
            return;
        }
        const text = selection.text.trim();
        const seq = ++this.translationSeq;
        const cacheKey = `${service.id}\u0000${settings.translationTargetLang}\u0000${text}`;
        const cached = this.translationCache.get(cacheKey);
        if (cached) {
            this.showTranslationPopup(text, cached, service.name, false);
            return;
        }
        this.showTranslationPopup(text, "正在翻译…", service.name, true);
        try {
            const result = await translateText(service, text, settings.translationTargetLang);
            if (seq !== this.translationSeq) return;
            this.translationCache.set(cacheKey, result.text);
            this.showTranslationPopup(text, result.text, result.service, false);
        } catch (error: any) {
            if (seq !== this.translationSeq) return;
            this.showTranslationPopup(text, `翻译失败：${error?.message || String(error)}`, service.name, false, true);
        }
    }

    private showTranslationPopup(original: string, translated: string, serviceName: string, loading: boolean, isError = false): void {
        this.translationPopup?.remove();
        const popup = document.createElement("div");
        popup.className = "pz-translation-popup";
        popup.setAttribute("role", "dialog");
        popup.setAttribute("aria-label", "PDF 翻译");
        const settings = this.host.store.state.settings;
        const rect = this.selectionRect;
        const head = document.createElement("div");
        head.className = "pz-translation-head";
        head.innerHTML = `<strong>翻译</strong><span>${escapeHtml(serviceName)} · ${escapeHtml(settings.translationTargetLang)}</span>`;
        const close = document.createElement("button");
        close.className = "pz-translation-close";
        close.textContent = "×";
        close.title = "关闭";
        close.addEventListener("click", () => this.closeTranslationPopup());
        head.append(close);
        const body = document.createElement("div");
        body.className = "pz-translation-body";
        if (settings.translationShowOriginal) {
            const source = document.createElement("div");
            source.className = "pz-translation-source";
            source.textContent = original;
            body.append(source);
        }
        const result = document.createElement("div");
        result.className = `pz-translation-result${loading ? " is-loading" : ""}${isError ? " is-error" : ""}`;
        result.textContent = translated;
        body.append(result);
        const actions = document.createElement("div");
        actions.className = "pz-translation-actions";
        const action = (label: string, handler: () => void) => {
            const button = document.createElement("button");
            button.textContent = label;
            button.disabled = loading || isError;
            button.addEventListener("click", handler);
            actions.append(button);
        };
        action("复制译文", async () => {
            try {
                const selection = this.selection;
                const rect = selection?.rects?.[0];
                const backlink = selection && rect
                    ? ` ^[[原文]](${pdfPageHref(this.data.attachmentId, selection.page, rect, this.selectedColor || DEFAULT_COLOR)})^`
                    : "";
                await navigator.clipboard.writeText(`${translated}${backlink}`);
                showMessage(backlink ? "已复制译文（带原文回跳）" : "已复制译文", 1800);
            } catch {
                showMessage("复制译文失败", 2500, "error");
            }
        });
        action("写入标注", async () => {
            const annotation = await this.createAnnotation();
            if (!annotation) return;
            this.host.store.updateAnnotation(annotation.id, {translation: translated});
            await this.host.store.save();
            this.renderSide();
            showMessage("译文已写入标注", 1800);
        });
        const closeAction = document.createElement("button");
        closeAction.textContent = "关闭";
        closeAction.addEventListener("click", () => this.closeTranslationPopup());
        actions.append(closeAction);
        popup.append(head, body, actions);
        document.body.append(popup);
        this.translationPopup = popup;
        // Anchor to the PDF page, not the viewport: when the reader is moved or
        // resized (e.g. split into a left PDF pane), the popup must follow it.
        this.positionTranslationPopup();
        requestAnimationFrame(() => this.positionTranslationPopup());
        window.setTimeout(() => {
            if (this.translationPopup !== popup) return;
            this.translationOutsideHandler = (event: PointerEvent): void => {
                if (this.translationPopup !== popup) return;
                if (!popup.contains(event.target as Node)) this.closeTranslationPopup();
            };
            document.addEventListener("pointerdown", this.translationOutsideHandler, {capture: true});
        }, 0);
    }

    private showFloat(rect: DOMRect): void {
        this.hideFloat();
        const el = document.createElement("div");
        el.className = "pz-float";
        el.dataset.attachmentId = this.data.attachmentId;
        el.innerHTML = `
  <button data-act="highlight">仅高亮</button>
  <button data-act="insert" class="pz-primary">高亮并插入笔记</button>
  <button data-act="copy">复制链接</button>
  <button data-act="quote">复制引用</button>`;
        el.addEventListener("click", async (event) => {
            const target = (event.target as HTMLElement).closest<HTMLElement>("[data-color],[data-act]");
            if (!target) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (target.dataset.color) {
                this.selectedColor = target.dataset.color;
                this.updateColorUi();
                el.querySelectorAll(".pz-swatch").forEach(swatch => swatch.classList.remove("is-active"));
                target.classList.add("is-active");
                return;
            }
            const action = target.dataset.act || "";
            if (action === "rect-link") {
                this.insertionTarget = this.host.captureNoteInsertionTarget();
                this.hideFloat();
                this.screenshot?.setActive(false);
                this.updateScreenshotButton();
                this.rectSelect?.setActive(true);
                showMessage("拖拽 PDF 矩形区域，复制该区域的嵌入链接", 3000);
                return;
            }
            const annotation = await this.createAnnotation();
            if (!annotation) {
                return;
            }
            this.hideFloat();
            if (action === "insert") {
                const book = this.host.store.getBook(this.host.store.getAttachment(annotation.attachmentId)?.bookId || "");
                const inserted = await insertAnnotationNote(this.host.store, annotation, book);
                if (inserted) {
                    this.renderSide();
                }
            } else if (action === "copy") {
                const book = this.host.store.getBook(this.host.store.getAttachment(annotation.attachmentId)?.bookId || "");
                const settings = this.host.store.state.settings;
                await copyAnnotationFormatted(annotation, book, settings.linkCopyFormat, settings.displayTextFormat, settings.displayTextTemplate, settings.linkCopyTemplate);
                this.renderSide();
            } else if (action === "quote") {
                const book = this.host.store.getBook(this.host.store.getAttachment(annotation.attachmentId)?.bookId || "");
                await copyAnnotationQuote(annotation, book);
                this.renderSide();
            }
        });
        el.querySelector<HTMLSelectElement>('[data-role="link-format"]')?.addEventListener("change", event => {
            this.host.store.updateSettings({linkCopyFormat: (event.target as HTMLSelectElement).value as any});
            void this.host.store.save();
        });
        el.querySelector<HTMLSelectElement>('[data-role="display-format"]')?.addEventListener("change", event => {
            this.host.store.updateSettings({displayTextFormat: (event.target as HTMLSelectElement).value as any});
            void this.host.store.save();
        });
        document.body.append(el);
        // Keep the actions next to the selection while clamping them inside the
        // visible window. Prefer above the text, fall back below near the top edge.
        const floatRect = el.getBoundingClientRect();
        const margin = 8;
        const left = clamp(rect.left + rect.width / 2 - floatRect.width / 2, margin, Math.max(margin, window.innerWidth - floatRect.width - margin));
        const above = rect.top - floatRect.height - margin;
        const top = above >= margin
            ? above
            : Math.min(window.innerHeight - floatRect.height - margin, rect.bottom + margin);
        el.style.left = `${Math.round(left)}px`;
        el.style.top = `${Math.round(Math.max(margin, top))}px`;
        el.style.transform = "none";
        this.floatEl = el;
    }

    private hideFloat(): void {
        if (this.floatEl) {
            this.floatEl.remove();
            this.floatEl = null;
        }
    }

    private async createAnnotation(): Promise<Annotation | null> {
        if (!this.selection) {
            return null;
        }
        const attachment = this.host.store.getAttachment(this.data.attachmentId);
        if (!attachment) {
            return null;
        }
        const color = HIGHLIGHT_COLORS.find(c => c.id === this.selectedColor)?.value || HIGHLIGHT_COLORS[0].value;
        const now = Date.now();
        const annotation: Annotation = {
            id: newId("ann"),
            attachmentId: attachment.id,
            page: this.selection.page,
            rects: this.selection.rects,
            text: this.selection.text,
            color,
            pageWidth: this.selection.pageWidth,
            pageHeight: this.selection.pageHeight,
            rotation: this.selection.rotation,
            createdAt: now,
            updatedAt: now,
        };
        this.host.store.addAnnotation(annotation);
        this.annotations.push(annotation);
        await this.host.store.save();
        if (this.host.store.state.settings.writePdfAnnotations) {
            try {
                await this.writeAnnotationToPdf(annotation);
            } catch (error: any) {
                this.host.logDebug("pdf.write-highlight.failed", {annotationId: annotation.id, error: String(error?.message || error)});
                showMessage(`PDF 高亮写入失败：${error?.message || error}`, 5000, "error");
            }
        }
        const info = this.pages[annotation.page - 1];
        if (info) {
            this.paintPage(info);
        }
        return annotation;
    }

    private async executeSelectionProduct(
        colorId: string,
        linkFormat: LinkCopyFormat,
        displayFormat: DisplayTextFormat,
    ): Promise<void> {
        this.selectedColor = colorId;
        this.updateColorUi();
        this.host.store.updateSettings({linkCopyFormat: linkFormat, displayTextFormat: displayFormat});
        await this.host.store.save();
        this.updateFormatButtonLabels();
        const annotation = await this.createAnnotation();
        if (!annotation) return;
        const attachment = this.host.store.getAttachment(annotation.attachmentId);
        const book = attachment ? this.host.store.getBook(attachment.bookId) : undefined;
        const settings = this.host.store.state.settings;
        await copyAnnotationFormatted(annotation, book, linkFormat, displayFormat, settings.displayTextTemplate, settings.linkCopyTemplate);
        this.hideFloat();
        this.renderSide();
        this.host.logDebug("selection.product.executed", {annotationId: annotation.id, colorId, linkFormat, displayFormat});
    }

    private async writeAnnotationToPdf(annotation: Annotation): Promise<void> {
        const attachment = this.host.store.getAttachment(annotation.attachmentId);
        if (!attachment?.path || !this.pdf) throw new Error("当前 PDF 没有可写入的本地文件");
        const fs = requireNode("fs");
        const path = requireNode("path");
        if (!fs?.writeFileSync || !path?.dirname) throw new Error("Electron 文件接口不可用");
        const info = this.pages[annotation.page - 1];
        if (!info) throw new Error("PDF 页面尚未渲染");
        const width = info.width / this.zoom;
        const height = info.height / this.zoom;
        const quadPoints: number[] = [];
        const outlines: number[][] = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const normalized of annotation.rects) {
            const x1 = normalized.x * width;
            const x2 = (normalized.x + normalized.w) * width;
            const top = (1 - normalized.y) * height;
            const bottom = (1 - normalized.y - normalized.h) * height;
            quadPoints.push(x1, top, x2, top, x1, bottom, x2, bottom);
            outlines.push([x1, bottom, x2, bottom, x2, top, x1, top]);
            minX = Math.min(minX, x1); minY = Math.min(minY, bottom);
            maxX = Math.max(maxX, x2); maxY = Math.max(maxY, top);
        }
        if (!quadPoints.length) throw new Error("高亮区域为空");
        const hex = annotation.color === "transparent" ? "#888888" : annotation.color;
        const color = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
        const storage = (this.pdf as any).annotationStorage;
        const storageId = `pdfjs_internal_editor_${annotation.id.replace(/[^\w-]/g, "")}`;
        storage.setValue(storageId, {
            annotationType: 9,
            color,
            opacity: 0.2,
            thickness: 12,
            quadPoints,
            outlines,
            pageIndex: annotation.page - 1,
            rect: [minX, minY, maxX, maxY],
            rotation: annotation.rotation || 0,
            id: null,
            deleted: false,
            date: Date.now(),
            user: "SiYuan PDF × Zotero",
        });
        const bytes = await (this.pdf as any).saveDocument();
        const backup = `${attachment.path}.pz-backup.pdf`;
        if (!fs.existsSync(backup)) fs.copyFileSync(attachment.path, backup);
        const temporary = path.join(path.dirname(attachment.path), `.${path.basename(attachment.path)}.pz-writing-${Date.now()}`);
        fs.writeFileSync(temporary, Buffer.from(bytes));
        try {
            fs.copyFileSync(temporary, attachment.path);
        } finally {
            try { fs.unlinkSync(temporary); } catch { /* best effort */ }
        }
        this.host.logDebug("pdf.write-highlight.complete", {annotationId: annotation.id, page: annotation.page, backup});
        showMessage(`高亮已写入 PDF（备份：${path.basename(backup)}）`, 3000);
    }

    private onPagesClick(event: MouseEvent): void {
        const regionElement = (event.target as HTMLElement).closest<HTMLElement>("[data-region-id]");
        if (regionElement) {
            const region = this.screenshotRegions.find(item => item.id === regionElement.dataset.regionId);
            if (region) {
                event.preventDefault();
                event.stopPropagation();
                this.scrollToScreenshotRegion(region);
            }
            return;
        }
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) {
            return;
        }
        const pageElement = (event.target as HTMLElement).closest<HTMLElement>(".pz-page");
        if (!pageElement) {
            return;
        }
        const pageNumber = Number.parseInt(pageElement.dataset.page || "1", 10);
        const info = this.pages[pageNumber - 1];
        if (!info) {
            return;
        }
        const {x, y} = pointerInPage(event, pageElement);
        const nx = x / info.width;
        const ny = y / info.height;
        const annotation = [...this.annotations].reverse().find(ann =>
            ann.page === pageNumber && ann.rects.some(rect =>
                nx >= rect.x && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h));
        if (!annotation) {
            return;
        }
        this.sideTab = "annotations";
        this.scrollSideTo(annotation.id);
    }

    private readonly onContextMenu = (event: MouseEvent): void => {
        const pageElement = (event.target as HTMLElement).closest<HTMLElement>(".pz-page");
        let regionId = (event.target as HTMLElement).closest<HTMLElement>("[data-region-id]")?.dataset.regionId || "";
        if (!regionId && pageElement) {
            const page = Number(pageElement.dataset.page || 0);
            const info = this.pages[page - 1];
            if (info) {
                const {x, y} = pointerInPage(event, pageElement);
                const nx = x / info.width;
                const ny = y / info.height;
                regionId = [...this.screenshotRegions].reverse().find(region =>
                    region.page === page && nx >= region.rect.x && nx <= region.rect.x + region.rect.w
                    && ny >= region.rect.y && ny <= region.rect.y + region.rect.h)?.id || "";
            }
        }
        if (regionId) {
            event.preventDefault();
            event.stopPropagation();
            this.showHighlightEditMenu(event.clientX, event.clientY, "region", regionId);
            return;
        }
        const annotationElement = (event.target as HTMLElement).closest<HTMLElement>("[data-annotation-id]");
        let annotationId = annotationElement?.dataset.annotationId || "";
        if (!annotationId && pageElement) {
            const page = Number(pageElement.dataset.page || 0);
            const info = this.pages[page - 1];
            if (info) {
                const {x, y} = pointerInPage(event, pageElement);
                const nx = x / info.width;
                const ny = y / info.height;
                annotationId = [...this.annotations].reverse().find(annotation =>
                    annotation.page === page && annotation.rects.some(rect =>
                        nx >= rect.x && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h))?.id || "";
            }
        }
        if (annotationId) {
            event.preventDefault();
            event.stopPropagation();
            this.showHighlightEditMenu(event.clientX, event.clientY, "annotation", annotationId);
            return;
        }
        const liveSelection = window.getSelection();
        if (!this.selection || !liveSelection || liveSelection.isCollapsed) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.closeTranslationPopup();
        this.showSelectionContextMenu(event.clientX, event.clientY);
    };

    private showSelectionContextMenu(x: number, y: number): void {
        document.querySelectorAll(".pz-selection-menu").forEach(item => item.remove());
        const settings = this.host.store.state.settings;
        const linkFormats: Array<[string, LinkCopyFormat]> = [
            ["Quote", "quote"], ["Link", "link"], ["Embed", "embed"], ["Callout", "callout"], ["Quote in callout", "quote-callout"],
        ];
        const displayFormats: Array<[string, DisplayTextFormat]> = [
            ["Title & page", "title-page"], ["Page", "page"], ["Text", "text"], ["Emoji", "emoji"], ["None", "none"],
        ];
        const menu = document.createElement("div");
        menu.className = "pz-selection-menu";
        if (x > window.innerWidth - 620) menu.classList.add("is-leftward");
        const row = (label: string, className = "", swatch = "") => {
            const item = document.createElement("div");
            item.className = `pz-selection-row ${className}`;
            item.innerHTML = `${swatch ? `<i class="pz-selection-dot" style="--pz-menu-color:${swatch}"></i>` : "<span class=\"pz-selection-icon\"></span>"}<span>${label}</span>`;
            return item;
        };
        menu.append(row("▣  Copy link to selection", "is-heading"));
        for (const color of HIGHLIGHT_COLORS) {
            const colorRow = row(color.id === "none" ? "Don't specify color" : color.label, "has-submenu", color.id === "none" ? "transparent" : color.value);
            const linkMenu = document.createElement("div");
            linkMenu.className = "pz-selection-submenu";
            for (const [linkLabel, linkValue] of linkFormats) {
                const linkRow = row(linkLabel, "has-submenu" + (settings.linkCopyFormat === linkValue ? " is-current" : ""));
                const displayMenu = document.createElement("div");
                displayMenu.className = "pz-selection-submenu";
                for (const [displayLabel, displayValue] of displayFormats) {
                    const leaf = row(displayLabel, "is-leaf" + (settings.displayTextFormat === displayValue ? " is-current" : ""));
                    leaf.addEventListener("click", event => {
                        event.stopPropagation();
                        menu.remove();
                        void this.executeSelectionProduct(color.id, linkValue, displayValue);
                    });
                    displayMenu.append(leaf);
                }
                linkRow.append(displayMenu);
                linkMenu.append(linkRow);
            }
            colorRow.append(linkMenu);
            menu.append(colorRow);
        }
        const separator = document.createElement("div");
        separator.className = "pz-selection-separator";
        menu.append(separator);
        const translateRow = row("译  Translate selection", "is-action");
        translateRow.addEventListener("click", () => {
            menu.remove();
            void this.translateSelection(true);
        });
        menu.append(translateRow);
        const copyText = row("▣  Copy selected text", "is-action");
        copyText.addEventListener("click", async () => {
            const text = this.selection?.text || "";
            menu.remove();
            try { await navigator.clipboard.writeText(text); showMessage("已复制选中文本", 1800); }
            catch { showMessage("复制选中文本失败", 3000, "error"); }
        });
        menu.append(copyText);
        const copySearch = row("⌕  Copy link to search", "is-action");
        copySearch.addEventListener("click", async () => {
            const selection = this.selection;
            if (!selection) return;
            const href = `${pdfPageHref(this.data.attachmentId, selection.page)}&search=${encodeURIComponent(selection.text)}`;
            menu.remove();
            try { await navigator.clipboard.writeText(href); showMessage("已复制 PDF 搜索链接", 1800); }
            catch { showMessage("复制搜索链接失败", 3000, "error"); }
        });
        menu.append(copySearch);
        const customize = row("⚙  Customize menu…", "is-action");
        customize.addEventListener("click", () => { menu.remove(); this.openFormatCustomize(); });
        menu.append(customize);
        document.body.append(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${clamp(x, 6, Math.max(6, innerWidth - rect.width - 6))}px`;
        menu.style.top = `${clamp(y, 6, Math.max(6, innerHeight - rect.height - 6))}px`;
        window.setTimeout(() => document.addEventListener("pointerdown", event => {
            if (!menu.contains(event.target as Node)) menu.remove();
        }, {once: true, capture: true}), 0);
    }

    private showHighlightEditMenu(x: number, y: number, kind: "annotation" | "region", id: string): void {
        document.querySelectorAll(".pz-edit-menu").forEach(item => item.remove());
        const menu = document.createElement("div");
        menu.className = "pz-edit-menu";
        menu.setAttribute("role", "menu");
        const current = kind === "annotation"
            ? this.host.store.getAnnotation(id)?.color
            : this.host.store.state.screenshotRegions[id]?.color;
        for (const color of HIGHLIGHT_COLORS) {
            const button = document.createElement("button");
            button.className = `pz-edit-swatch${color.id === "none" ? " is-none" : ""}`;
            button.style.setProperty("--pz-edit-color", color.value);
            button.title = color.label;
            button.setAttribute("aria-label", color.label);
            button.dataset.colorId = color.id;
            button.classList.toggle("is-active", current === color.value);
            button.addEventListener("click", () => {
                menu.remove();
                if (kind === "annotation") void this.updateAnnotationColor(id, color.id);
                else void this.updateScreenshotRegionColor(id, color.id);
            });
            menu.append(button);
        }
        const remove = document.createElement("button");
        remove.className = "is-danger";
        remove.title = kind === "annotation" ? "删除高亮并同步删除关联笔记" : "删除截图区域并同步删除笔记图片";
        remove.setAttribute("aria-label", remove.title);
        remove.innerHTML = '<svg aria-hidden="true"><use xlink:href="#iconTrashcan"></use></svg>';
        remove.addEventListener("click", () => {
            menu.remove();
            if (kind === "annotation") void this.deleteAnnotationAndNotes(id);
            else void this.deleteScreenshotRegion(id);
        });
        menu.append(remove);
        document.body.append(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - rect.width - 6))}px`;
        menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - rect.height - 6))}px`;
        const close = (event: MouseEvent) => {
            if (!menu.contains(event.target as Node)) menu.remove();
        };
        window.setTimeout(() => document.addEventListener("mousedown", close, {once: true, capture: true}), 0);
    }

    private onPagesMouseMove(event: MouseEvent): void {
        if (this.screenshot?.isActive() || this.floatEl) {
            return;
        }
        // Link previews are owned by the link buttons; moving inside a link must not hide them.
        if ((event.target as HTMLElement).closest(".pz-link-box")) {
            return;
        }
        const pageElement = (event.target as HTMLElement).closest<HTMLElement>(".pz-page");
        if (!pageElement) {
            this.preview.hide();
            return;
        }
        const pageNumber = Number.parseInt(pageElement.dataset.page || "1", 10);
        const info = this.pages[pageNumber - 1];
        if (!info) {
            return;
        }
        const {x, y} = pointerInPage(event, pageElement);
        const nx = x / info.width;
        const ny = y / info.height;
        const pageAnnotations = this.annotations.filter(ann => ann.page === pageNumber);
        const directAnnotationId = (event.target as HTMLElement).closest<HTMLElement>("[data-annotation-id]")?.dataset.annotationId || "";
        let annotation = directAnnotationId ? this.host.store.getAnnotation(directAnnotationId) : undefined;
        annotation ||= [...pageAnnotations].reverse().find(ann =>
            ann.rects.some(rect =>
                nx >= rect.x && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h));
        // Text-layer selection rects can be a few pixels off after a side-panel
        // resize. Fall back to the nearest highlight on the same page.
        if (!annotation) {
            let bestDistance = 0.12;
            for (const candidate of pageAnnotations) {
                for (const rect of candidate.rects) {
                    const dx = nx - (rect.x + rect.w / 2);
                    const dy = ny - (rect.y + rect.h / 2);
                    const distance = Math.hypot(dx, dy);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        annotation = candidate;
                    }
                }
            }
        }
        this.element.dataset.pzHoverDebug = JSON.stringify({
            nx: Number(nx.toFixed(4)),
            ny: Number(ny.toFixed(4)),
            direct: pageAnnotations.some(ann => ann.rects.some(rect =>
                nx >= rect.x && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h)),
            annotation: annotation?.id || "",
        });
        if (!annotation) {
            this.hoveredAnnotationId = "";
            this.preview.hide();
            return;
        }
        if (annotation.id === this.hoveredAnnotationId && this.preview.isVisible()) {
            return;
        }
        this.hoveredAnnotationId = annotation.id;
        const trigger = this.host.store.state.settings.previewTrigger;
        if (trigger === "alt" && !event.altKey) {
            this.preview.hide();
            return;
        }
        void this.showLinkedNotePreview(annotation, new DOMRect(event.clientX, event.clientY, 1, 1));
    }

    private async showLinkedNotePreview(annotation: Annotation, anchor: DOMRect): Promise<void> {
        let links = this.host.store.noteLinksForAnnotation(annotation.id);
        if (!links.length) {
            try {
                const safeId = annotation.id.replaceAll("'", "''");
                const response = await fetch("/api/query/sql", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({stmt: `select id, root_id from blocks where markdown like '%annotation?id=${safeId}%' limit 8`}),
                });
                const result = await response.json();
                if (response.ok && result.code === 0) {
                    for (const row of result.data || []) {
                        if (row.id && row.root_id) this.host.store.addNoteLink(annotation.id, String(row.id), String(row.root_id));
                    }
                    links = this.host.store.noteLinksForAnnotation(annotation.id);
                    if (links.length) void this.host.store.save();
                }
            } catch {
                // The normal stored index remains the primary path.
            }
        }
        this.element.dataset.pzNotePreviewDebug = JSON.stringify({stage: "links", annotationId: annotation.id, links: links.length});
        if (!links.length) {
            this.preview.hide();
            return;
        }
        const link = links[0];
        let text = this.notePreviewCache.get(link.siyuanBlockId) || "";
        if (!text) {
            try {
                const response = await fetch("/api/block/getBlockKramdown", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({id: link.siyuanBlockId}),
                });
                const result = await response.json();
                if (!response.ok || result.code !== 0) {
                    this.element.dataset.pzNotePreviewDebug = JSON.stringify({stage: "api-error", status: response.status, code: result.code, msg: result.msg || ""});
                    return;
                }
                const markdown = String(result.data?.kramdown || result.data || "");
                text = markdown
                    .replace(/\{:[^}]*\}/g, " ")
                    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
                    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
                    .replace(/[*_`>#~-]+/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                this.notePreviewCache.set(link.siyuanBlockId, text);
                this.element.dataset.pzNotePreviewDebug = JSON.stringify({stage: "loaded", annotationId: annotation.id, blockId: link.siyuanBlockId, markdownLength: markdown.length, textLength: text.length});
            } catch (error: any) {
                this.host.logDebug("annotation.note-preview.failed", {annotationId: annotation.id, message: error?.message || String(error)}, "warn");
                return;
            }
        }
        if (this.hoveredAnnotationId !== annotation.id) {
            this.element.dataset.pzNotePreviewDebug = JSON.stringify({stage: "cancelled", expected: annotation.id, hovered: this.hoveredAnnotationId});
            return;
        }
        this.preview.showHtml(`
<div class="pz-preview-title">关联笔记${links.length > 1 ? ` · ${links.length} 条` : ""}</div>
<div class="pz-preview-text">${escapeHtml((text || "笔记内容为空").slice(0, 500))}</div>`, anchor, 140);
        this.element.dataset.pzNotePreviewDebug = JSON.stringify({stage: "scheduled", annotationId: annotation.id, textLength: text.length});
    }

    private runSearch(query: string, jump = true): void {
        this.searchQuery = query.trim();
        window.clearTimeout(this.searchTimer);
        if (!this.searchQuery) {
            this.searchHits = [];
            this.searchIndex = -1;
            this.searchCount.textContent = "";
            this.clearSearchHits();
            if (this.sideTab === "search") {
                this.sideTab = "annotations";
            }
            this.renderSide();
            return;
        }
        this.searchHits = searchPages(
            this.pages.map(page => ({element: page.element, pageNumber: page.pageNumber})),
            this.searchQuery,
        );
        this.searchIndex = this.searchHits.length ? 0 : -1;
        this.searchCount.textContent = this.searchHits.length ? `1/${this.searchHits.length}` : "0";
        this.sideTab = "search";
        this.sideElement.style.display = "";
        this.paintSearchHits();
        this.renderSide();
        if (jump && this.searchIndex >= 0) {
            this.goToSearchHit(this.searchIndex);
        }
    }

    private stepSearch(delta: number): void {
        if (!this.searchHits.length) {
            return;
        }
        const next = this.searchIndex < 0 ? 0 : (this.searchIndex + delta + this.searchHits.length) % this.searchHits.length;
        this.goToSearchHit(next);
    }

    private goToSearchHit(index: number): void {
        if (index < 0 || index >= this.searchHits.length) {
            return;
        }
        this.searchIndex = index;
        this.searchCount.textContent = `${index + 1}/${this.searchHits.length}`;
        this.paintSearchHits();
        const hit = this.searchHits[index];
        const info = this.pages[hit.page - 1];
        if (info) {
            const first = hit.rects[0];
            this.currentPage = hit.page;
            this.pageInput.value = String(hit.page);
            const top = info.element.offsetTop + (first ? first.y * info.height : 0) - 80;
            this.pagesElement.scrollTo({top: Math.max(0, top), behavior: "auto"});
        }
        this.renderSide();
    }

    private paintSearchHits(): void {
        for (const page of this.pages) {
            const layer = page.element.querySelector<HTMLElement>(".pz-search-layer");
            if (!layer) {
                continue;
            }
            layer.innerHTML = "";
            this.searchHits.forEach((hit, index) => {
                if (hit.page !== page.pageNumber) {
                    return;
                }
                for (const rect of hit.rects) {
                    const element = document.createElement("div");
                    element.className = `pz-search-hit${index === this.searchIndex ? " is-active" : ""}`;
                    element.dataset.searchIndex = String(index);
                    element.style.left = `${rect.x * page.width}px`;
                    element.style.top = `${rect.y * page.height}px`;
                    element.style.width = `${rect.w * page.width}px`;
                    element.style.height = `${rect.h * page.height}px`;
                    layer.append(element);
                }
            });
        }
    }

    private clearSearchHits(): void {
        for (const page of this.pages) {
            const layer = page.element.querySelector<HTMLElement>(".pz-search-layer");
            if (layer) {
                layer.innerHTML = "";
            }
        }
    }

    private showLoadError(title: string, error: any): void {
        this.pagesElement.innerHTML = `<div class="pz-empty-reader">${escapeHtml(title)}：${escapeHtml(error?.message || String(error))}<br><br>
<button class="b3-button b3-button--text" data-act="relink-pdf">重新定位 PDF 文件</button>
<div class="pz-muted" style="margin-top:6px">重新关联后保留该 PDF 的标注和思源笔记链接；若内容指纹变化会提示，不会自动跳错误位置。</div></div>`;
        this.pagesElement.querySelector<HTMLElement>('[data-act="relink-pdf"]')?.addEventListener("click", () => {
            void this.host.relinkAttachment(this.data.attachmentId);
        });
    }

    private renderSide(): void {
        const tabs = `
<div class="pz-side-head"><span>侧栏</span><button class="pz-side-close" data-side-close title="收起侧栏">×</button></div>
<div class="pz-side-tabs">
  <button data-side="annotations" class="${this.sideTab === "annotations" ? "is-active" : ""}">标注 ${this.annotations.length}</button>
  <button data-side="outline" class="${this.sideTab === "outline" ? "is-active" : ""}">目录 ${this.outline.length}</button>
  <button data-side="search" class="${this.sideTab === "search" ? "is-active" : ""}">搜索 ${this.searchHits.length}</button>
  <button data-side="backlinks" class="${this.sideTab === "backlinks" ? "is-active" : ""}">反链</button>
</div>`;
        let body = "";
        if (this.sideTab === "outline") {
            body = this.outline.length
                ? this.outline.map(entry => `<button class="pz-outline-item" data-outline-page="${entry.page}" style="padding-left:${8 + entry.depth * 12}px">${escapeHtml(entry.title)} <span class="pz-outline-page">p.${entry.page}</span></button>`).join("")
                : `<div class="pz-empty">此 PDF 没有可用目录（outline）。</div>`;
        } else if (this.sideTab === "search") {
            body = this.searchHits.length
                ? this.searchHits.map((hit, index) => `<button class="pz-search-item${index === this.searchIndex ? " is-active" : ""}" data-search-index="${index}"><span class="pz-search-page">p.${hit.page}</span> ${escapeHtml(hit.text.slice(0, 90))}</button>`).join("")
                : `<div class="pz-empty">输入关键词后显示搜索结果。</div>`;
        } else if (this.sideTab === "backlinks") {
            const rows: string[] = [];
            for (const annotation of this.annotations) {
                for (const link of this.host.store.noteLinksForAnnotation(annotation.id)) {
                    rows.push(`<div class="pz-backlink-card">
  <div class="pz-backlink-text">${escapeHtml(annotation.text.slice(0, 120))}</div>
  <div class="pz-ann-meta">p.${annotation.page} · ${escapeHtml(link.siyuanDocId)}</div>
  <button data-note-doc="${escapeHtml(link.siyuanDocId)}" data-note-block="${escapeHtml(link.siyuanBlockId)}">打开笔记块</button>
</div>`);
                }
            }
            body = rows.join("") || `<div class="pz-empty">还没有“标注 → 笔记”链接。选中 PDF 文字后可插入笔记。</div>`;
        } else {
            body = this.annotations.length
                ? this.annotations.slice().sort((a, b) => a.page - b.page || a.createdAt - b.createdAt).map(annotation => {
                    const links = this.host.store.noteLinksForAnnotation(annotation.id);
                    const noteRows = links.map(link => `<button class="pz-note-link" data-note-doc="${escapeHtml(link.siyuanDocId)}" data-note-block="${escapeHtml(link.siyuanBlockId)}">打开笔记块</button>`).join("");
                    return `<div class="pz-ann-card" data-card="${annotation.id}">
  <div class="pz-ann-text">${escapeHtml(annotation.text.slice(0, 260))}</div>
  ${annotation.translation ? `<div class="pz-ann-translation">${escapeHtml(annotation.translation.slice(0, 260))}</div>` : ""}
  <div class="pz-ann-meta">第 ${annotation.page} 页 · ${links.length} 条笔记链接</div>
  <div class="pz-ann-actions">
    <button data-ann="${annotation.id}" data-act="locate">定位</button>
    <button data-ann="${annotation.id}" data-act="insert">插入笔记</button>
    <button data-ann="${annotation.id}" data-act="copy">复制链接</button>
    ${noteRows}
  </div>
</div>`;
                }).join("")
                : `<div class="pz-empty">在 PDF 中选中文字后使用悬浮工具栏创建高亮。</div>`;
        }
        this.sideElement.innerHTML = `${tabs}<div class="pz-side-body">${body}</div>`;
        if (this.sideElement.style.display === "none") {
            this.sideElement.style.display = "none";
        }
    }

    private scrollSideTo(annotationId: string): void {
        this.sideElement.style.display = "";
        const card = this.sideElement.querySelector<HTMLElement>(`[data-card="${CSS.escape(annotationId)}"]`);
        card?.scrollIntoView({block: "nearest"});
    }

    private async onAnnotationAction(action: string, annotationId: string): Promise<void> {
        const annotation = this.host.store.getAnnotation(annotationId);
        if (!annotation) {
            return;
        }
        if (action === "locate") {
            this.scrollToAnnotation(annotation, true);
        } else if (action === "copy") {
            const attachment = this.host.store.getAttachment(annotation.attachmentId);
            const book = attachment ? this.host.store.getBook(attachment.bookId) : undefined;
            const settings = this.host.store.state.settings;
            await copyAnnotationFormatted(annotation, book, settings.linkCopyFormat, settings.displayTextFormat, settings.displayTextTemplate, settings.linkCopyTemplate);
        } else if (action === "insert") {
            const attachment = this.host.store.getAttachment(annotation.attachmentId);
            const book = attachment ? this.host.store.getBook(attachment.bookId) : undefined;
            const inserted = await insertAnnotationNote(this.host.store, annotation, book);
            if (inserted) {
                this.renderSide();
            }
        }
    }

    private pdfRectForPage(page: number, rect?: {x: number; y: number; w: number; h: number}): {x: number; y: number; w: number; h: number} | undefined {
        if (!rect) {
            return undefined;
        }
        const info = this.pages[page - 1];
        if (!info) {
            return undefined;
        }
        const width = info.width / this.zoom;
        const height = info.height / this.zoom;
        return {
            x: rect.x * width,
            y: (1 - rect.y - rect.h) * height,
            w: rect.w * width,
            h: rect.h * height,
        };
    }

    private async onOcrSelection(selection: RectSelection): Promise<void> {
        if (!selection.blob) {
            showMessage("没有获取到框选图像", 3000, "error");
            return;
        }
        const settings = this.host.store.state.settings;
        const hud = new Pdf2zhHud("OCR");
        let progress = 5;
        hud.setProgress(progress, "正在检查本地 OCR 服务…");
        const timer = window.setInterval((): void => {
            progress = Math.min(90, progress + 3);
            hud.setProgress(progress, "正在识别公式/文本…");
        }, 1200);
        try {
            const server = await ensureOcrServer(settings);
            if (!server.ok) throw new Error(server.error || "OCR 服务不可用");
            hud.setProgress(20, "正在上传选区并识别…");
            const result = await recognizeImage(settings, selection.blob, {
                mode: settings.ocrDefaultMode,
                source: "pdf-region",
            });
            if (!result.items.length && !result.markdown.trim()) throw new Error("OCR 没有返回内容");
            window.clearInterval(timer);
            hud.complete("OCR 识别完成");
            this.showOcrPreview(result, selection);
        } catch (error: any) {
            window.clearInterval(timer);
            hud.fail(String(error?.message || error || "OCR 识别失败"));
        }
    }

    private showOcrPreview(result: OcrResult, selection: RectSelection): void {
        openOcrResultDialog(this.host, result, {
            imageBlob: selection.blob,
            source: "pdf-region",
            attachmentId: this.data.attachmentId,
            page: selection.page,
            insertionTarget: this.insertionTarget,
        });
    }

    private async onRectSelection(selection: RectSelection): Promise<void> {
        const settings = this.host.store.state.settings;
        const pdfRect = this.pdfRectForPage(selection.page, selection.rect);
        if (!pdfRect) {
            return;
        }
        const regionId = newId("shot");
        const href = `${pdfPageHref(this.data.attachmentId, selection.page, pdfRect, this.selectedColor)}&region=${encodeURIComponent(regionId)}`;
        const label = displayTextForScreenshot(
            this.titleElement.textContent || "PDF",
            selection.page,
            settings.displayTextFormat,
            settings.displayTextTemplate,
        );
        const text = formatHrefCopy(
            href,
            label,
            settings.linkCopyFormat,
            this.titleElement.textContent || "PDF",
            selection.page,
            settings.linkCopyTemplate,
        );
        // Deterministic E2E/read-only diagnostic. Clipboard reads can be denied
        // after a plugin reload even when the generated link is correct.
        this.element.dataset.pzLastRectLink = text;
        let inserted = null;
        const started = performance.now();
        if (selection.blob) {
            try {
                const assetPath = await uploadPngAsset(selection.blob, `pz-rect-${Date.now()}.png`);
                inserted = await insertImageAtCursor(
                    assetPath,
                    `PDF 第 ${selection.page} 页矩形选区`,
                    this.insertionTarget,
                    href,
                    label,
                );
                if (inserted) {
                    await this.persistScreenshotRegion(regionId, selection.page, selection.rect, assetPath, inserted.blockId, inserted.docId, label);
                    this.host.logDebug("screenshot.insert.complete", {
                        kind: "rect",
                        regionId,
                        page: selection.page,
                        noteBlockId: inserted.blockId,
                        durationMs: Math.round(performance.now() - started),
                    });
                }
            } catch (error: any) {
                this.host.logDebug("screenshot.insert.failed", {kind: "rect", regionId, message: error?.message || String(error)}, "error");
                showMessage(`矩形选区插入失败：${error?.message || String(error)}`, 6000, "error");
            }
        }
        try {
            await navigator.clipboard.writeText(text);
            showMessage(
                inserted
                    ? "已插入矩形选区，并复制了嵌入链接"
                    : "已复制矩形选区嵌入链接（PDF++ 格式）",
                3000,
            );
        } catch {
            showMessage(
                inserted
                    ? "已插入矩形选区（剪贴板不可用）"
                    : `复制失败，内容：${text}`,
                inserted ? 3000 : 6000,
                inserted ? "info" : "error",
            );
        }
    }

    private async onScreenshot(capture: {blob: Blob; page: number; width: number; height: number; rect?: {x: number; y: number; w: number; h: number}}): Promise<void> {
        const started = performance.now();
        const regionId = newId("shot");
        try {
            const name = `pz-shot-${Date.now()}.png`;
            const assetPath = await uploadPngAsset(capture.blob, name);
            const sourceHref = `${pdfPageHref(
                this.data.attachmentId,
                capture.page,
                this.pdfRectForPage(capture.page, capture.rect),
                this.selectedColor,
            )}&region=${encodeURIComponent(regionId)}`;
            const settings = this.host.store.state.settings;
            const sourceText = displayTextForScreenshot(
                this.titleElement.textContent || "PDF",
                capture.page,
                settings.displayTextFormat,
                settings.displayTextTemplate,
            );
            const inserted = await insertImageAtCursor(assetPath, "PDF 截图", this.insertionTarget, sourceHref, sourceText);
            if (inserted && capture.rect) {
                await this.persistScreenshotRegion(regionId, capture.page, capture.rect, assetPath, inserted.blockId, inserted.docId, sourceText);
                this.host.logDebug("screenshot.insert.complete", {
                    kind: "screenshot",
                    regionId,
                    page: capture.page,
                    noteBlockId: inserted.blockId,
                    durationMs: Math.round(performance.now() - started),
                });
                showMessage(`已插入 PDF 截图（第 ${capture.page} 页），点击图片可返回原区域`, 3000);
            }
        } catch (error: any) {
            this.host.logDebug("screenshot.insert.failed", {kind: "screenshot", regionId, message: error?.message || String(error)}, "error");
            showMessage(`截图插入失败：${error?.message || String(error)}`, 6000, "error");
        } finally {
            this.screenshot?.setActive(false);
            this.updateScreenshotButton();
        }
    }

    private async persistScreenshotRegion(
        id: string,
        page: number,
        rect: {x: number; y: number; w: number; h: number},
        assetPath: string,
        noteBlockId: string,
        noteDocId: string,
        label: string,
    ): Promise<void> {
        const color = HIGHLIGHT_COLORS.find(item => item.id === this.selectedColor)?.value || this.selectedColor;
        this.host.store.addScreenshotRegion({
            id,
            attachmentId: this.data.attachmentId,
            page,
            rect,
            color,
            colorId: this.selectedColor,
            assetPath,
            noteBlockId,
            noteDocId,
            label: label || `${this.titleElement.textContent || "PDF"} · p.${page}`,
            createdAt: Date.now(),
        });
        await this.host.store.save();
        this.screenshotRegions = this.host.store.screenshotRegionsForAttachment(this.data.attachmentId);
        const info = this.pages[page - 1];
        if (info) {
            this.paintPage(info);
        }
    }
}
