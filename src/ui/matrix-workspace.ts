import {Dialog, getAllEditor, getActiveEditor, showMessage} from "siyuan";
import {createDocWithMd, getBlockAttrs} from "../api";
import type {PluginHost} from "../host";
import type {MatrixCanvasEdge, MatrixCanvasNode, MatrixCanvasState, MatrixColumn, MatrixFilterCondition, MatrixProject, MatrixRow, MatrixView, MatrixViewKind, ReadingStatus} from "../types";
import {createMatrixProject, formulaValue, suggestMatrixSchema, rowForZoteroItem} from "../matrix/model";
import {GALLERY_GROUP_OPTIONS, itemTypeLabel, normalizeGallerySettings, statusFromLabel, statusLabel, type GallerySettings} from "../matrix/gallery";
import {attachmentForZoteroItem, statusForStat} from "../reading";
import {filterMatrixRows} from "../matrix/filter";
import {matrixRowTags, suggestCanvasRelations} from "../matrix/relationships";
import {autoLayoutMatrixCanvas, ensureMatrixCanvasNodes} from "../matrix/canvas";
import {syncReadingValues} from "../matrix/reading";
import {createNoteFromTemplate} from "../template/notes";
import {openMatrixRow} from "./matrix-row";
import {openMatrixAI} from "./matrix-ai";
import {newId} from "../storage";
import {loadAttachmentBytes} from "../pdf/source";
import {openPdfDocument} from "../pdf/pdfjs";
import {fileExists, requireNode, resolveZoteroAttachmentPath} from "../runtime";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch] as string));
}

function downloadText(fileName: string, text: string): void {
    const blob = new Blob(["\ufeff", text], {type: "text/csv;charset=utf-8"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function ensureProject(host: PluginHost): MatrixProject {
    const state = host.store.state;
    if (!state.matrixProjects?.length) {
        const project = createMatrixProject("我的研究项目");
        state.matrixProjects = [project];
        state.matrixActiveProjectId = project.id;
        void host.store.save();
    }
    let project = state.matrixProjects.find(item => item.id === state.matrixActiveProjectId) || state.matrixProjects[0];
    if (!state.matrixActiveProjectId) state.matrixActiveProjectId = project.id;
    return project;
}

function viewKind(view?: MatrixView): MatrixViewKind {
    return view?.kind === "kanban" || view?.kind === "canvas" || view?.kind === "gallery" ? view.kind : "table";
}

function canvasFor(view: MatrixView): MatrixCanvasState {
    if (!view.canvas) view.canvas = {nodes: [], edges: []};
    return view.canvas;
}

function rowTitle(row: MatrixRow): string {
    return String(row.values.title || row.itemKey || "未命名文献");
}

function rowSubtitle(row: MatrixRow): string {
    const authors = String(row.values.authors || "").split(";")[0]?.trim();
    const year = String(row.values.year || "").trim();
    return [authors, year].filter(Boolean).join(" · ");
}

function groupValues(project: MatrixProject, row: MatrixRow, columns: string[]): string[] {
    return columns.map(columnId => {
        const column = project.columns.find(item => item.id === columnId);
        const value = row.values[columnId];
        return String(value ?? "").trim() || (column ? `未填写${column.name}` : "未分组");
    });
}

function cellInput(project: MatrixProject, row: MatrixRow, column: MatrixColumn): string {
    const value = row.values[column.id];
    const common = `data-row="${row.id}" data-column="${column.id}"`;
    if (column.type === "formula") {
        return `<div class="pz-matrix-readonly">${escapeHtml(formulaValue(project, row, column))}</div>`;
    }
    if (column.system || column.type === "relation") {
        return `<div class="pz-matrix-readonly">${escapeHtml(String(value ?? ""))}</div>`;
    }
    if (column.type === "select") {
        return `<select class="b3-select pz-matrix-cell" ${common}>${["", ...(column.options || [])].map(option => `<option value="${escapeHtml(option)}" ${String(value ?? "") === option ? "selected" : ""}>${escapeHtml(option || "—")}</option>`).join("")}</select>`;
    }
    if (column.type === "multiselect") {
        return `<input class="b3-text-field pz-matrix-cell" ${common} value="${escapeHtml(Array.isArray(value) ? value.join(", ") : String(value ?? ""))}" placeholder="逗号分隔" />`;
    }
    if (column.type === "rating") {
        return `<input class="b3-text-field pz-matrix-cell" type="number" min="1" max="5" ${common} value="${escapeHtml(String(value ?? ""))}" style="width:60px" />`;
    }
    if (column.type === "number") {
        return `<input class="b3-text-field pz-matrix-cell" type="number" ${common} value="${escapeHtml(String(value ?? ""))}" />`;
    }
    if (column.type === "longtext") {
        return `<textarea class="b3-text-field pz-matrix-cell" rows="2" ${common}>${escapeHtml(String(value ?? ""))}</textarea>`;
    }
    if (column.type === "checkbox") {
        return `<input class="pz-matrix-cell" type="checkbox" ${common} ${value ? "checked" : ""} />`;
    }
    if (column.type === "date") {
        return `<input class="b3-text-field pz-matrix-cell" type="date" ${common} value="${escapeHtml(String(value ?? ""))}" />`;
    }
    if (column.type === "url") {
        return `<input class="b3-text-field pz-matrix-cell" type="url" ${common} value="${escapeHtml(String(value ?? ""))}" />`;
    }
    return `<input class="b3-text-field pz-matrix-cell" ${common} value="${escapeHtml(String(value ?? ""))}" />`;
}

function ensureCanvasNodes(project: MatrixProject, view: MatrixView): MatrixCanvasState {
    return ensureMatrixCanvasNodes(project, canvasFor(view));
}

function autoLayoutCanvas(project: MatrixProject, view: MatrixView): void {
    autoLayoutMatrixCanvas(project, canvasFor(view));
}

const pdfThumbnailPending = new Set<string>();
const thumbnailUrls = new Map<string, string>();

function apiToken(): string {
    return String((window as any).siyuan?.config?.api?.token || "");
}

async function writeThumbnailCache(attachmentId: string, dataUrl: string): Promise<string> {
    const path = `data/storage/petal/siyuan-pdf-zotero/matrix-thumbnails/${attachmentId}.jpg`;
    const blob = await (await fetch(dataUrl)).blob();
    const form = new FormData();
    form.append("path", `/${path}`);
    form.append("isDir", "false");
    form.append("modTime", String(Date.now()));
    form.append("file", blob, `${attachmentId}.jpg`);
    const response = await fetch("/api/file/putFile", {
        method: "POST",
        headers: apiToken() ? {Authorization: `Token ${apiToken()}`} : {},
        body: form,
    });
    if (!response.ok) throw new Error(`thumbnail cache failed: ${response.status}`);
    return path;
}

async function readThumbnailUrl(path: string): Promise<string> {    if (thumbnailUrls.has(path)) return thumbnailUrls.get(path)!;
    const response = await fetch("/api/file/getFile", {
        method: "POST",
        headers: {
            ...(apiToken() ? {Authorization: `Token ${apiToken()}`} : {}),
            "Content-Type": "application/json",
        },
        body: JSON.stringify({path: `/${path}`}),
    });
    if (!response.ok) throw new Error(`thumbnail read failed: ${response.status}`);
    const blob = await response.blob();
    // SiYuan returns HTTP 200 with a JSON error body when the file is missing;
    // treating that as an image would poison the cache and render broken thumbnails.
    if (!blob.size || !blob.type.startsWith("image/")) {
        void removeThumbnailCache(path);
        throw new Error("thumbnail cache miss");
    }
    const url = URL.createObjectURL(blob);
    thumbnailUrls.set(path, url);
    return url;
}

async function removeThumbnailCache(path: string): Promise<void> {
    try {
        await fetch("/api/file/removeFile", {
            method: "POST",
            headers: {
                ...(apiToken() ? {Authorization: `Token ${apiToken()}`} : {}),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({path: `/${path}`}),
        });
        thumbnailUrls.delete(path);
    } catch {
        // cache cleanup is best effort
    }
}

async function cleanOrphanThumbnails(host: PluginHost): Promise<number> {
    const referenced = new Set<string>();
    for (const project of host.store.state.matrixProjects || []) {
        for (const view of project.views || []) {
            for (const node of view.canvas?.nodes || []) {
                if (node.thumbnailPath) referenced.add(node.thumbnailPath);
            }
        }
    }
    const response = await fetch("/api/file/readDir", {
        method: "POST",
        headers: {
            ...(apiToken() ? {Authorization: `Token ${apiToken()}`} : {}),
            "Content-Type": "application/json",
        },
        body: JSON.stringify({path: "/data/storage/petal/siyuan-pdf-zotero/matrix-thumbnails"}),
    });
    if (!response.ok) return 0;
    const json = await response.json();
    const files = Array.isArray(json?.data) ? json.data : [];
    let removed = 0;
    for (const file of files) {
        if (file?.isDir || !file?.name) continue;
        const path = `data/storage/petal/siyuan-pdf-zotero/matrix-thumbnails/${file.name}`;
        if (referenced.has(path)) continue;
        await removeThumbnailCache(path);
        removed++;
    }
    return removed;
}

async function makePdfThumbnail(host: PluginHost, attachmentId: string): Promise<string | null> {
    const attachment = host.store.getAttachment(attachmentId);
    if (!attachment) return null;
    if (attachment.zotero?.attachmentKey) {
        const styleUrl = readStyleCover(
            host.store.state.zotero.dataDir,
            host.store.state.zotero.libraryId || 0,
            attachment.zotero.attachmentKey,
        );
        if (styleUrl) return styleUrl;
    }
    let pdfDoc: Awaited<ReturnType<typeof openPdfDocument>> | null = null;
    try {
        const loaded = await loadAttachmentBytes(attachment);
        pdfDoc = await openPdfDocument(loaded.bytes);
        const page = await pdfDoc.pdf.getPage(1);
        const base = page.getViewport({scale: 1});
        const viewport = page.getViewport({scale: 520 / Math.max(1, base.width)});
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d", {alpha: false});
        if (!context) return null;
        await page.render({canvas, canvasContext: context, viewport}).promise;
        return canvas.toDataURL("image/jpeg", 0.88);
    } catch {
        return null;
    } finally {
        await pdfDoc?.destroy();
    }
}

const zoteroCoverCache = new Map<string, string>();
const zoteroCoverPending = new Set<string>();
const ZOTERO_COVER_LIMIT = 256;

/** Reuse Zotero Style's own cover cache when it is present: no PDF rendering needed. */
function readStyleCover(dataDir: string, libraryId: number, attachmentKey: string): string | null {
    if (!dataDir || !attachmentKey) return null;
    const fs = requireNode("fs");
    const pathModule = requireNode("path");
    if (!fs?.readFileSync || !pathModule?.join) return null;
    const dir = pathModule.join(dataDir, "cache", "zotero-style-covers-v1");
    const candidates = [`${libraryId}-${attachmentKey}-520.json`, `1-${attachmentKey}-520.json`, `0-${attachmentKey}-520.json`];
    for (const name of candidates) {
        try {
            const file = pathModule.join(dir, name);
            if (!fs.existsSync(file)) continue;
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            const url = String(parsed?.url || "");
            if (url.startsWith("data:image/jpeg;base64,") && url.length < 4 * 1024 * 1024) return url;
        } catch {
            // try the next candidate
        }
    }
    return null;
}

function rememberZoteroCover(itemKey: string, url: string): void {
    zoteroCoverCache.set(itemKey, url);
    while (zoteroCoverCache.size > ZOTERO_COVER_LIMIT) {
        const oldest = zoteroCoverCache.keys().next().value;
        if (!oldest) break;
        zoteroCoverCache.delete(oldest);
    }
}

/** Render page 1 straight from a cached Zotero attachment, without importing it. */
async function makeZoteroThumbnail(host: PluginHost, itemKey: string): Promise<string | null> {
    const cached = zoteroCoverCache.get(itemKey);
    if (cached) return cached;
    if (zoteroCoverPending.has(itemKey)) return null;
    zoteroCoverPending.add(itemKey);
    let pdfDoc: Awaited<ReturnType<typeof openPdfDocument>> | null = null;
    try {
        const cache = host.store.state.zotero;
        const candidates = (cache.attachments || []).filter(attachment => attachment.parentItemKey === itemKey);
        const pdf = candidates.find(attachment => /pdf/i.test(attachment.contentType || "") || /\.pdf$/i.test(attachment.filename || attachment.rawPath || "")) || candidates[0];
        // Style already rendered and cached this cover at 520px; reuse it before doing any work.
        if (pdf) {
            const styleUrl = readStyleCover(cache.dataDir, cache.libraryId || 0, pdf.attachmentKey);
            if (styleUrl) {
                rememberZoteroCover(itemKey, styleUrl);
                return styleUrl;
            }
        }
        const cachePath = `data/storage/petal/siyuan-pdf-zotero/matrix-thumbnails/zot520-${itemKey}.jpg`;
        try {
            const url = await readThumbnailUrl(cachePath);
            rememberZoteroCover(itemKey, url);
            return url;
        } catch {
            // no cached thumbnail yet
        }
        try {
            const quick = await readThumbnailUrl(`data/storage/petal/siyuan-pdf-zotero/matrix-thumbnails/zot260-${itemKey}.jpg`);
            rememberZoteroCover(itemKey, quick);
            return quick;
        } catch {
            // fall through to generation
        }
        if (!pdf) return null;
        const path = resolveZoteroAttachmentPath({
            dataDir: cache.dataDir,
            attachmentKey: pdf.attachmentKey,
            path: pdf.rawPath,
            filename: pdf.filename,
        });
        if (!path || !fileExists(path)) return null;
        const fs = requireNode("fs");
        const buffer = fs.readFileSync(path);
        const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        pdfDoc = await openPdfDocument(bytes);
        const page = await pdfDoc.pdf.getPage(1);
        const base = page.getViewport({scale: 1});
        const viewport = page.getViewport({scale: 260 / Math.max(1, base.width)});
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d", {alpha: false});
        if (!context) return null;
        await page.render({canvas, canvasContext: context, viewport}).promise;
        const url = canvas.toDataURL("image/jpeg", 0.8);
        rememberZoteroCover(itemKey, url);
        void writeThumbnailCache(`zot260-${itemKey}`, url).catch(() => {});
        return url;
    } catch {
        return null;
    } finally {
        zoteroCoverPending.delete(itemKey);
        await pdfDoc?.destroy();
    }
}


export function openMatrix(host: PluginHost): Dialog {
    let project = ensureProject(host);
    let currentKind: MatrixViewKind = "gallery";
    let currentViewId = "";
    let currentSortColumn = "";
    let currentSortDirection: "asc" | "desc" = "asc";
    let currentGroupColumn = "";
    let currentFilterColumn = "";
    let currentFilterOperator: "contains" | "equals" | "not-empty" | "gt" | "lt" = "contains";
    let currentFilterValue = "";
    let workingFilters: MatrixFilterCondition[] = [];
    let currentFilterLogic: "and" | "or" = "and";
    let canvasZoom = 1;
    let canvasPanX = 0;
    let canvasPanY = 0;
    let connectFrom = "";
    let connectMode = false;
    let marqueeMode = false;
    let marqueeState: {startX: number; startY: number; box: HTMLElement; additive: boolean} | null = null;
    let showFilteredNodes = false;
    let edgeKindFilter: MatrixCanvasEdge["kind"] | "" = "";
    let workingView: MatrixView | null = null;
    const undoStack: string[] = [];
    const redoStack: string[] = [];
    const selectedNodeIds = new Set<string>();
    let canvasClipboard: {nodes: MatrixCanvasNode[]; edges: MatrixCanvasEdge[]} | null = null;
    let canvasSelectedNode = "";
    const selectedRows = new Set<string>();

    const dialog = new Dialog({
        title: "文献矩阵",
        width: "min(1400px, 96vw)",
        content: `<div class="b3-dialog__content pz-matrix-dialog">
  <div class="pz-matrix-top">
    <div class="pz-matrix-tabs">
      <button data-matrix-kind="table">表格</button>
      <button data-matrix-kind="kanban">看板</button>
      <button data-matrix-kind="gallery" class="is-active">画廊</button>
      <button data-matrix-kind="canvas">画布</button>
    </div>
    <div class="pz-matrix-projectbar">
      <select class="b3-select" data-role="matrix-project"></select>
      <button class="b3-button b3-button--outline" data-act="matrix-new-project">新建项目</button>
      <select class="b3-select" data-role="matrix-collection"></select>
      <button class="b3-button b3-button--outline" data-act="matrix-import">从 Collection 导入</button>
      <button class="b3-button b3-button--outline" data-act="matrix-add-column">添加字段</button>
      <button class="b3-button b3-button--outline" data-act="matrix-manage-columns">字段管理</button>
      <button class="b3-button b3-button--outline" data-act="matrix-schema-suggest">类型建议</button>
      <span class="fn__space"></span>
      <select class="b3-select" data-role="matrix-view"></select>
      <button class="b3-button b3-button--outline" data-act="matrix-save-view">保存视图</button>
      <button class="b3-button b3-button--outline" data-act="matrix-rename-view">重命名</button>
      <button class="b3-button b3-button--outline" data-act="matrix-delete-view">删除视图</button>
    </div>
    <div class="pz-matrix-filterbar">
      <input class="b3-text-field" data-role="matrix-filter" placeholder="搜索文献…" />
      <select class="b3-select" data-role="filter-column"></select>
      <select class="b3-select" data-role="filter-op"><option value="contains">包含</option><option value="equals">等于</option><option value="not-empty">非空</option><option value="gt">大于</option><option value="lt">小于</option></select>
      <input class="b3-text-field" data-role="filter-value" placeholder="筛选值" style="width:100px" />
      <button class="b3-button b3-button--outline" data-act="filter-clear">清空筛选</button>
      <button class="b3-button b3-button--outline" data-act="filter-builder">多条件筛选</button>
      <select class="b3-select" data-role="matrix-sort-column"></select>
      <select class="b3-select" data-role="matrix-sort-direction"><option value="asc">升序</option><option value="desc">降序</option></select>
      <select class="b3-select" data-role="matrix-group-column"></select>
      <select class="b3-select" data-role="matrix-batch-column"></select>
      <input class="b3-text-field" data-role="matrix-batch-value" placeholder="批量值" style="width:110px" />
      <button class="b3-button b3-button--outline" data-act="matrix-batch-apply">批量设置</button>
      <button class="b3-button b3-button--outline" data-act="matrix-ai">AI 填充选中</button>
      <button class="b3-button b3-button--outline" data-act="matrix-export-csv">导出 CSV</button>
      <button class="b3-button b3-button--outline" data-act="matrix-export-siyuan">导出 SiYuan 表格</button>
    </div>
  </div>
  <div class="pz-muted" data-role="matrix-status" style="margin:6px 0"></div>

  <div class="pz-matrix-pane" data-matrix-pane="table">
    <div class="pz-matrix-scroll"><table class="pz-matrix-table"><thead data-role="matrix-head"></thead><tbody data-role="matrix-body"></tbody></table></div>
  </div>

  <div class="pz-matrix-pane" data-matrix-pane="kanban" hidden>
    <div class="pz-matrix-kanban-toolbar">
      <select class="b3-select" data-role="kanban-mode"><option value="field">按字段分组</option><option value="custom">自定义列</option></select>
      <select class="b3-select" data-role="kanban-group1"></select>
      <select class="b3-select" data-role="kanban-group2"></select>
      <select class="b3-select" data-role="kanban-group3"></select>
      <button class="b3-button b3-button--outline" data-act="kanban-edit-columns">编辑自定义列</button>
      <span class="pz-muted">拖动卡片可修改分组字段或自定义列</span>
    </div>
    <div class="pz-matrix-kanban" data-role="matrix-kanban"></div>
  </div>

  <div class="pz-matrix-pane" data-matrix-pane="gallery" hidden>
    <div class="pz-gallery-toolbar">
      <div class="pz-gallery-tabs">
        <button data-gallery-mode="items" class="is-active">条目</button>
        <button data-gallery-mode="notes">笔记</button>
        <button data-gallery-mode="annotations">标注</button>
      </div>
      <div class="pz-gallery-status" data-role="gallery-status"></div>
      <span class="fn__space"></span>
      <select class="b3-select" data-role="gallery-scope" title="文库范围">
        <option value="library">全部文库</option>
        <option value="project">当前矩阵项目</option>
      </select>
      <select class="b3-select" data-role="gallery-group" title="分列依据"></select>
      <span class="pz-muted" data-role="gallery-count"></span>
      <button class="b3-button b3-button--outline" data-act="gallery-settings">显示设置</button>
    </div>
    <div class="pz-gallery-grid" data-role="matrix-gallery"></div>
  </div>

  <div class="pz-matrix-pane" data-matrix-pane="canvas" hidden>
    <div class="pz-matrix-canvas-toolbar">
      <button class="b3-button b3-button--outline" data-act="canvas-auto-layout">自动布局</button>
      <button class="b3-button b3-button--outline" data-act="canvas-undo">撤销</button>
      <button class="b3-button b3-button--outline" data-act="canvas-redo">重做</button>
      <button class="b3-button b3-button--outline" data-act="canvas-connect">连线</button>
      <button class="b3-button b3-button--outline" data-act="canvas-edge-list">关系</button>
      <button class="b3-button b3-button--outline" data-act="canvas-batch-color">节点颜色</button>
      <button class="b3-button b3-button--outline" data-act="canvas-clean-thumbnails">清理缩略图缓存</button>
      <button class="b3-button b3-button--outline" data-act="canvas-marquee">框选</button>
      <button class="b3-button b3-button--outline" data-act="canvas-add-text">添加文本</button>
      <button class="b3-button b3-button--outline" data-act="canvas-add-tag">添加标签</button>
      <button class="b3-button b3-button--outline" data-act="canvas-add-group">添加分组</button>
      <button class="b3-button b3-button--outline" data-act="canvas-add-image">添加图片</button>
      <button class="b3-button b3-button--outline" data-act="canvas-add-pdf">添加 PDF 节点</button>
      <button class="b3-button b3-button--outline" data-act="canvas-add-note">添加笔记节点</button>
      <button class="b3-button b3-button--outline" data-act="canvas-fit">适应画布</button>
      <label class="pz-muted" style="display:flex;align-items:center;gap:4px"><input type="checkbox" data-role="canvas-show-filtered" /> 显示筛掉的灰色节点</label>
      <select class="b3-select" data-role="canvas-edge-filter"><option value="">全部关系</option><option value="citation">引用</option><option value="contrast">对比</option><option value="method">方法</option><option value="conclusion">结论</option><option value="data">数据</option><option value="other">其他</option></select>
      <span class="pz-muted" data-role="canvas-hint"></span>
    </div>
    <div class="pz-matrix-canvas" data-role="matrix-canvas" tabindex="0">
      <div class="pz-matrix-canvas-world" data-role="canvas-world">
        <svg class="pz-matrix-canvas-edges" data-role="canvas-edges" width="4000" height="4000"></svg>
        <div class="pz-matrix-canvas-nodes" data-role="canvas-nodes"></div>
      </div>
      <div class="pz-matrix-minimap" data-role="canvas-minimap"></div>
    </div>
  </div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="matrix-close">关闭</button></div>`,
    });

    const q = <T extends Element>(selector: string): T => dialog.element.querySelector<T>(selector)!;
    const projectSelect = q<HTMLSelectElement>('[data-role="matrix-project"]');
    const collectionSelect = q<HTMLSelectElement>('[data-role="matrix-collection"]');
    const viewSelect = q<HTMLSelectElement>('[data-role="matrix-view"]');
    const filter = q<HTMLInputElement>('[data-role="matrix-filter"]');
    const filterColumn = q<HTMLSelectElement>('[data-role="filter-column"]');
    const filterOp = q<HTMLSelectElement>('[data-role="filter-op"]');
    const filterValue = q<HTMLInputElement>('[data-role="filter-value"]');
    const status = q<HTMLElement>('[data-role="matrix-status"]');
    const tableHead = q<HTMLElement>('[data-role="matrix-head"]');
    const tableBody = q<HTMLElement>('[data-role="matrix-body"]');
    const tablePane = q<HTMLElement>('[data-matrix-pane="table"]');
    const kanbanPane = q<HTMLElement>('[data-matrix-pane="kanban"]');
    const galleryPane = q<HTMLElement>('[data-matrix-pane="gallery"]');
    const galleryRoot = q<HTMLElement>('[data-role="matrix-gallery"]');
    const galleryStatusBar = q<HTMLElement>('[data-role="gallery-status"]');
    const galleryGroupSelect = q<HTMLSelectElement>('[data-role="gallery-group"]');
    const galleryScopeSelect = q<HTMLSelectElement>('[data-role="gallery-scope"]');
    const galleryCount = q<HTMLElement>('[data-role="gallery-count"]');
    const canvasPane = q<HTMLElement>('[data-matrix-pane="canvas"]');
    const kanbanRoot = q<HTMLElement>('[data-role="matrix-kanban"]');
    const kanbanMode = q<HTMLSelectElement>('[data-role="kanban-mode"]');
    const kanbanGroup1 = q<HTMLSelectElement>('[data-role="kanban-group1"]');
    const kanbanGroup2 = q<HTMLSelectElement>('[data-role="kanban-group2"]');
    const kanbanGroup3 = q<HTMLSelectElement>('[data-role="kanban-group3"]');
    const sortColumn = q<HTMLSelectElement>('[data-role="matrix-sort-column"]');
    const sortDirection = q<HTMLSelectElement>('[data-role="matrix-sort-direction"]');
    const groupColumn = q<HTMLSelectElement>('[data-role="matrix-group-column"]');
    const batchColumn = q<HTMLSelectElement>('[data-role="matrix-batch-column"]');
    const batchValue = q<HTMLInputElement>('[data-role="matrix-batch-value"]');
    const canvasRoot = q<HTMLElement>('[data-role="matrix-canvas"]');
    const canvasWorld = q<HTMLElement>('[data-role="canvas-world"]');
    const canvasEdges = q<SVGSVGElement>('[data-role="canvas-edges"]');
    const canvasNodes = q<HTMLElement>('[data-role="canvas-nodes"]');
    const canvasMinimap = q<HTMLElement>('[data-role="canvas-minimap"]');
    const canvasHint = q<HTMLElement>('[data-role="canvas-hint"]');
    const showFilteredInput = q<HTMLInputElement>('[data-role="canvas-show-filtered"]');
    const edgeFilterSelect = q<HTMLSelectElement>('[data-role="canvas-edge-filter"]');

    const collections = host.store.state.zotero.collections || [];
    project.views = project.views || [];
    const activeView = (): MatrixView | undefined => project.views?.find(view => view.id === currentViewId);
    const ensureActiveView = (): MatrixView => {
        const view = activeView();
        if (view) return view;
        if (!workingView) {
            workingView = {id: newId("mxview"), name: "未保存视图", filter: filter.value, sortColumn: currentSortColumn, sortDirection: currentSortDirection, kind: currentKind};
        }
        workingView.filter = filter.value;
        workingView.sortColumn = currentSortColumn;
        workingView.sortDirection = currentSortDirection;
        workingView.groupColumn = currentGroupColumn;
        workingView.kind = currentKind;
        return workingView;
    };
    const pushCanvasHistory = () => {
        const canvas = canvasFor(ensureActiveView());
        undoStack.push(JSON.stringify(canvas));
        if (undoStack.length > 40) undoStack.shift();
        redoStack.length = 0;
    };
    const restoreCanvasHistory = (from: string[], to: string[]) => {
        const snapshot = from.pop();
        if (!snapshot) return;
        const canvas = canvasFor(ensureActiveView());
        to.push(JSON.stringify(canvas));
        const restored = JSON.parse(snapshot) as MatrixCanvasState;
        canvas.nodes = restored.nodes || [];
        canvas.edges = restored.edges || [];
        project.updatedAt = Date.now();
        void host.store.save();
        renderCanvas();
    };

    const renderProjects = () => {
        projectSelect.innerHTML = host.store.state.matrixProjects.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === project.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
        collectionSelect.innerHTML = `<option value="">选择 Collection…</option>` + collections.map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`).join("");
    };
    const renderViewSelect = () => {
        viewSelect.innerHTML = `<option value="">未保存视图</option>` + (project.views || []).map(view => `<option value="${escapeHtml(view.id)}" ${view.id === currentViewId ? "selected" : ""}>${escapeHtml(view.name)}</option>`).join("");
    };
    const renderOptions = () => {
        const columns = project.columns.filter(column => column.visible && !column.system);
        const visible = project.columns.filter(column => column.visible);
        sortColumn.innerHTML = `<option value="">不排序</option>` + visible.map(column => `<option value="${column.id}" ${currentSortColumn === column.id ? "selected" : ""}>${escapeHtml(column.name)}</option>`).join("");
        sortDirection.value = currentSortDirection;
        filterColumn.innerHTML = `<option value="">不按字段筛选</option>` + visible.map(column => `<option value="${column.id}" ${currentFilterColumn === column.id ? "selected" : ""}>${escapeHtml(column.name)}</option>`).join("");
        filterOp.value = currentFilterOperator;
        filterValue.value = currentFilterValue;
        groupColumn.innerHTML = `<option value="">不分组</option>` + visible.map(column => `<option value="${column.id}" ${currentGroupColumn === column.id ? "selected" : ""}>按 ${escapeHtml(column.name)} 分组</option>`).join("");
        batchColumn.innerHTML = columns.map(column => `<option value="${column.id}">${escapeHtml(column.name)}</option>`).join("");
        const groupOptions = `<option value="">不分组</option>` + visible.map(column => `<option value="${column.id}">${escapeHtml(column.name)}</option>`).join("");
        for (const select of [kanbanGroup1, kanbanGroup2, kanbanGroup3]) {
            const current = select.value;
            select.innerHTML = groupOptions;
            if (current) select.value = current;
        }
        const active = activeView();
        if (active) {
            kanbanMode.value = active.kanbanMode || "field";
            const cols = active.groupColumns || [];
            kanbanGroup1.value = cols[0] || "";
            kanbanGroup2.value = cols[1] || "";
            kanbanGroup3.value = cols[2] || "";
        }
    };

    const filteredRows = (): MatrixRow[] => {
        const query = filter.value.trim().toLowerCase();
        let rows = query ? project.rows.filter(row => [Object.values(row.values).join(" "), row.itemKey].join(" ").toLowerCase().includes(query)) : [...project.rows];
        if (currentFilterColumn) {
            rows = filterMatrixRows(project, rows, [{id: "quick", columnId: currentFilterColumn, operator: currentFilterOperator, value: currentFilterValue}]);
        }
        if (workingFilters.length) {
            rows = filterMatrixRows(project, rows, workingFilters, currentFilterLogic);
        }
        if (currentSortColumn) {
            const column = project.columns.find(item => item.id === currentSortColumn);
            rows.sort((a, b) => {
                const av = a.values[currentSortColumn];
                const bv = b.values[currentSortColumn];
                const result = column?.type === "number" || column?.type === "rating"
                    ? (Number(av) || 0) - (Number(bv) || 0)
                    : String(av ?? "").localeCompare(String(bv ?? ""), "zh-CN");
                return currentSortDirection === "desc" ? -result : result;
            });
        }
        return rows;
    };

    const updateStatus = () => {
        const kindLabel = currentKind === "table" ? "表格" : currentKind === "kanban" ? "看板" : currentKind === "gallery" ? "画廊" : "画布";
        status.textContent = `${project.name} · ${project.rows.length} 篇 · ${project.columns.filter(column => column.visible).length} 列 · ${kindLabel}`;
    };

    const renderTable = () => {
        const columns = project.columns.filter(column => column.visible);
        tableHead.innerHTML = `<tr><th class="pz-matrix-index"><input type="checkbox" data-role="matrix-select-all" /></th><th class="pz-matrix-index">#</th>${columns.map(column => `<th style="min-width:${column.width || 120}px">${escapeHtml(column.name)}</th>`).join("")}<th>操作</th></tr>`;
        const rows = filteredRows();
        const rowHtml = (row: MatrixRow, index: number) => `<tr data-row-id="${row.id}" draggable="true"><td class="pz-matrix-index"><input type="checkbox" data-act="matrix-select-row" data-row-id="${row.id}" ${selectedRows.has(row.id) ? "checked" : ""} /></td><td class="pz-matrix-index">${index + 1}</td>${columns.map(column => `<td>${cellInput(project, row, column)}</td>`).join("")}<td><button class="pz-matrix-detail" data-act="matrix-open-detail" data-row-id="${row.id}">详情</button> <button class="pz-matrix-note" data-act="matrix-open-note" data-row-id="${row.id}">笔记</button> <button class="pz-matrix-delete" data-act="matrix-delete-row" data-row-id="${row.id}">×</button></td></tr>`;
        if (rows.length && currentGroupColumn) {
            const groups = new Map<string, MatrixRow[]>();
            for (const row of rows) {
                const key = String(row.values[currentGroupColumn] ?? "") || "未分组";
                groups.set(key, [...(groups.get(key) || []), row]);
            }
            tableBody.innerHTML = Array.from(groups.entries()).map(([key, groupRows]) => `<tr class="pz-matrix-group-row"><td colspan="${columns.length + 3}">${escapeHtml(key)} <span class="pz-muted">${groupRows.length} 篇</span></td></tr>` + groupRows.map((row, index) => rowHtml(row, index)).join("")).join("");
        } else {
            tableBody.innerHTML = rows.length ? rows.map((row, index) => rowHtml(row, index)).join("") : `<tr><td colspan="${columns.length + 3}" class="pz-muted">还没有文献，先从一个 Collection 导入。</td></tr>`;
        }
        for (const input of Array.from(tableBody.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(".pz-matrix-cell"))) {
            input.addEventListener("change", () => {
                const row = project.rows.find(item => item.id === input.dataset.row);
                if (!row) return;
                row.values[input.dataset.column || ""] = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
                project.updatedAt = Date.now();
                void host.store.save();
            });
        }
        tableBody.addEventListener("dragstart", event => {
            const row = (event.target as HTMLElement).closest<HTMLElement>("tr[data-row-id]");
            if (!row) return;
            event.dataTransfer?.setData("text/plain", row.dataset.rowId || "");
        });
        for (const button of Array.from(tableBody.querySelectorAll<HTMLElement>('[data-act="matrix-open-detail"]'))) {
            button.addEventListener("click", () => {
                const row = project.rows.find(item => item.id === button.dataset.rowId);
                if (row) openMatrixRow(host, project, row);
            });
        }
        for (const button of Array.from(tableBody.querySelectorAll<HTMLElement>('[data-act="matrix-open-note"]'))) {
            button.addEventListener("click", async () => {
                const row = project.rows.find(item => item.id === button.dataset.rowId);
                if (!row) return;
                if (row.noteDocId) {
                    host.openDoc(row.noteDocId);
                    return;
                }
                const docId = await createNoteFromTemplate(host, row.itemKey);
                if (docId) {
                    row.noteDocId = docId;
                    project.updatedAt = Date.now();
                    await host.store.save();
                    renderTable();
                }
            });
        }
        for (const button of Array.from(tableBody.querySelectorAll<HTMLElement>('[data-act="matrix-delete-row"]'))) {
            button.addEventListener("click", () => {
                const row = project.rows.find(item => item.id === button.dataset.rowId);
                if (!row) return;
                const affected = (project.views || []).filter(view => view.kind === "canvas").length;
                if (affected && !window.confirm(`删除《${rowTitle(row)}》会同时删除 ${affected} 张画布中的节点和连线，继续？`)) return;
                project.rows = project.rows.filter(item => item.id !== row.id);
                const removedThumbnails: string[] = [];
                for (const view of project.views || []) {
                    if (!view.canvas) continue;
                    const nodeIds = new Set(view.canvas.nodes.filter(node => node.rowId === row.id).map(node => node.id));
                    for (const node of view.canvas.nodes) {
                        if (nodeIds.has(node.id) && node.thumbnailPath) removedThumbnails.push(node.thumbnailPath);
                    }
                    view.canvas.nodes = view.canvas.nodes.filter(node => !nodeIds.has(node.id));
                    view.canvas.edges = view.canvas.edges.filter(edge => !nodeIds.has(edge.from) && !nodeIds.has(edge.to));
                }
                for (const thumbnailPath of removedThumbnails) void removeThumbnailCache(thumbnailPath);
                project.updatedAt = Date.now();
                void host.store.save();
                render();
            });
        }
        updateStatus();
    };

    const cardHtml = (row: MatrixRow): string => {
        const tags = matrixRowTags(project, row);
        return `<div class="pz-kanban-card" draggable="true" data-row-id="${row.id}"><div class="pz-kanban-card-title">${escapeHtml(rowTitle(row))}</div><div class="pz-kanban-card-sub">${escapeHtml(rowSubtitle(row) || row.itemKey)}</div>${tags.length ? `<div class="pz-kanban-card-tags">${tags.slice(0, 4).map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}</div>`;
    };

    const bindCardEvents = () => {
        for (const card of Array.from(kanbanRoot.querySelectorAll<HTMLElement>(".pz-kanban-card"))) {
            card.addEventListener("click", event => {
                if ((event.target as HTMLElement).closest("[data-kanban-drop]")) return;
                const row = project.rows.find(item => item.id === card.dataset.rowId);
                if (row) openMatrixRow(host, project, row);
            });
            card.addEventListener("dragstart", event => {
                event.dataTransfer?.setData("text/plain", card.dataset.rowId || "");
                card.classList.add("is-dragging");
            });
            card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
        }
    };

    const renderKanban = () => {
        const view = ensureActiveView();
        const mode = view.kanbanMode || "field";
        kanbanMode.value = mode;
        const rows = filteredRows();
        if (mode === "custom") {
            const columns = view.customColumns?.length ? view.customColumns : ["待读", "精读", "已用"];
            view.customColumns = columns;
            view.customColumnByRow = view.customColumnByRow || {};
            const entries = columns.map(column => [column, rows.filter(row => (view.customColumnByRow?.[row.id] || columns[0]) === column)] as const);
            kanbanRoot.innerHTML = `<div class="pz-kanban-board">${entries.map(([name, items]) => `<div class="pz-kanban-column" data-kanban-drop="custom" data-column="${escapeHtml(name)}"><div class="pz-kanban-column-head">${escapeHtml(name)} <span>${items.length}</span></div><div class="pz-kanban-cards">${items.map(cardHtml).join("")}</div></div>`).join("")}</div>`;
        } else {
            const groupIds = [view.groupColumns?.[0] || kanbanGroup1.value, view.groupColumns?.[1] || "", view.groupColumns?.[2] || ""].filter(Boolean);
            const activeGroups = groupIds.length ? groupIds : [groupColumn.value].filter(Boolean);
            const groups = new Map<string, {path: string[]; rows: MatrixRow[]}>();
            for (const row of rows) {
                const path = activeGroups.length ? groupValues(project, row, activeGroups) : ["全部文献"];
                const key = path.join(" / ");
                groups.set(key, {path, rows: [...(groups.get(key)?.rows || []), row]});
            }
            kanbanRoot.innerHTML = `<div class="pz-kanban-board">${Array.from(groups.entries()).map(([key, group]) => `<div class="pz-kanban-column" data-kanban-drop="field" data-group-path="${escapeHtml(JSON.stringify(activeGroups))}"><div class="pz-kanban-column-head">${escapeHtml(key)} <span>${group.rows.length}</span></div><div class="pz-kanban-cards">${group.rows.map(cardHtml).join("")}</div></div>`).join("")}</div>`;
        }
        bindCardEvents();
        for (const column of Array.from(kanbanRoot.querySelectorAll<HTMLElement>("[data-kanban-drop]"))) {
            column.addEventListener("dragover", event => event.preventDefault());
            column.addEventListener("drop", async event => {
                event.preventDefault();
                const rowId = event.dataTransfer?.getData("text/plain") || "";
                const row = project.rows.find(item => item.id === rowId);
                if (!row) return;
                if (column.dataset.kanbanDrop === "custom") {
                    view.customColumnByRow = view.customColumnByRow || {};
                    view.customColumnByRow[row.id] = column.dataset.column || "";
                } else {
                    const groupIds = view.groupColumns?.filter(Boolean) || [];
                    const target = groupIds[groupIds.length - 1];
                    const label = column.querySelector(".pz-kanban-column-head")?.textContent?.split(" ")[0] || "";
                    if (target === "readStatus") {
                        const status = statusFromLabel(label);
                        const attachment = attachmentForZoteroItem(host.store, row.itemKey);
                        if (status && attachment) {
                            const stat = host.store.ensureReadingStat(attachment.id, host.store.readingStat(attachment.id)?.pages || 0);
                            host.store.setReadingStat(attachment.id, {...stat, manualStatus: status});
                        }
                    } else if (target) {
                        row.values[target] = label;
                    }
                }
                project.updatedAt = Date.now();
                await host.store.save();
                renderKanban();
            });
        }
        updateStatus();
    };

    const hydratePdfThumbnails = () => {
        const view = ensureActiveView();
        const canvas = ensureCanvasNodes(project, view);
        for (const node of canvas.nodes) {
            if (node.kind !== "pdf" || pdfThumbnailPending.has(node.id)) continue;
            if (node.thumbnailPath && !thumbnailUrls.has(node.thumbnailPath)) {
                pdfThumbnailPending.add(node.id);
                void readThumbnailUrl(node.thumbnailPath).then(() => {
                    pdfThumbnailPending.delete(node.id);
                    renderCanvas();
                }).catch(() => pdfThumbnailPending.delete(node.id));
                continue;
            }
            if (node.thumbnailPath) continue;
            if (node.thumbnail) {
                const data = node.thumbnail;
                node.thumbnail = undefined;
                if (node.attachmentId) {
                    pdfThumbnailPending.add(node.id);
                    void writeThumbnailCache(node.attachmentId, data).then(path => {
                        node.thumbnailPath = path;
                        thumbnailUrls.set(path, data);
                        project.updatedAt = Date.now();
                        void host.store.save();
                    }).finally(() => { pdfThumbnailPending.delete(node.id); renderCanvas(); });
                }
                continue;
            }
            if (!node.attachmentId) continue;
            pdfThumbnailPending.add(node.id);
            void makePdfThumbnail(host, node.attachmentId).then(async data => {
                if (data) {
                    const path = await writeThumbnailCache(node.attachmentId!, data);
                    node.thumbnailPath = path;
                    thumbnailUrls.set(path, data);
                    project.updatedAt = Date.now();
                    void host.store.save();
                }
            }).catch((): void => undefined).finally(() => {
                pdfThumbnailPending.delete(node.id);
                renderCanvas();
            });
        }
    };

    const renderCanvas = () => {
        const view = ensureActiveView();
        const canvas = ensureCanvasNodes(project, view);
        const rows = filteredRows();
        const visibleIds = new Set(rows.map(row => row.id));
        const nodeById = new Map(canvas.nodes.map(node => [node.id, node]));
        const rowNodeId = new Map(canvas.nodes.filter(node => node.kind === "row" && node.rowId).map(node => [node.rowId!, node.id]));
        const width = 4000;
        const height = 4000;
        canvasWorld.style.transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasZoom})`;
        canvasEdges.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const edgeSvg = (edge: MatrixCanvasEdge, from: MatrixCanvasNode, to: MatrixCanvasNode) => {
            const x1 = from.x + (from.width || 220) / 2;
            const y1 = from.y + (from.height || 80) / 2;
            const x2 = to.x + (to.width || 220) / 2;
            const y2 = to.y + (to.height || 80) / 2;
            const color = edge.auto ? "#8b9dc3" : "#4f63d2";
            const label = edge.label || edge.kind;
            return `<g data-edge-id="${escapeHtml(edge.id)}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="12" style="pointer-events:stroke;cursor:pointer" /><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" ${edge.auto ? 'stroke-dasharray="6 5"' : ""} ${edge.directed ? 'marker-end="url(#pz-arrow)"' : ""} style="pointer-events:stroke;cursor:pointer" /><text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" font-size="10" fill="${color}" text-anchor="middle" style="pointer-events:auto;cursor:pointer">${escapeHtml(label)}</text></g>`;
        };
        const path: string[] = ['<defs><marker id="pz-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#4f63d2"></path></marker></defs>'];
        const collapsedGroups = canvas.nodes.filter(node => node.kind === "group" && node.collapsed);
        const hiddenNodeIds = new Set<string>();
        for (const node of canvas.nodes) {
            if (node.kind === "group") continue;
            if (collapsedGroups.some(group => node.x >= group.x && node.y >= group.y && node.x <= group.x + (group.width || 320) && node.y <= group.y + (group.height || 160))) {
                hiddenNodeIds.add(node.id);
            }
        }
        for (const edge of canvas.edges) {
            if (edgeKindFilter && edge.kind !== edgeKindFilter) continue;
            const from = nodeById.get(edge.from);
            const to = nodeById.get(edge.to);
            if (!from || !to || hiddenNodeIds.has(from.id) || hiddenNodeIds.has(to.id)) continue;
            const filtered = (from.rowId && !visibleIds.has(from.rowId)) || (to.rowId && !visibleIds.has(to.rowId));
            if (filtered && !showFilteredNodes) continue;
            path.push(edgeSvg(edge, from, to));
        }
        const hints = suggestCanvasRelations(project, rows);
        for (const hint of hints) {
            if (edgeKindFilter) break;
            const from = nodeById.get(rowNodeId.get(hint.from) || "");
            const to = nodeById.get(rowNodeId.get(hint.to) || "");
            if (from && to) {
                const x1 = from.x + (from.width || 220) / 2;
                const y1 = from.y + (from.height || 80) / 2;
                const x2 = to.x + (to.width || 220) / 2;
                const y2 = to.y + (to.height || 80) / 2;
                path.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#b8a15a" stroke-width="1.5" stroke-dasharray="6 5" data-hint-from="${escapeHtml(from.id)}" data-hint-to="${escapeHtml(to.id)}" data-hint-label="${escapeHtml(hint.label)}" style="pointer-events:stroke;cursor:pointer"><title>${escapeHtml(hint.label)}（点击转为正式关系）</title></line>`);
            }
        }
        canvasEdges.innerHTML = path.join("");
        canvasNodes.innerHTML = canvas.nodes.filter(node => {
            if (hiddenNodeIds.has(node.id)) return false;
            if (node.kind !== "row" || !node.rowId) return true;
            return showFilteredNodes || visibleIds.has(node.rowId);
        }).map(node => {
            const row = node.rowId ? project.rows.find(item => item.id === node.rowId) : undefined;
            if (node.kind === "row" && !row) return "";
            const filtered = node.rowId ? !visibleIds.has(node.rowId) : false;
            const title = node.kind === "row" && row ? rowTitle(row) : node.kind === "tag" || node.kind === "text" ? node.text || "未命名" : node.kind === "pdf" ? node.text || "PDF 节点" : node.kind === "note" ? node.text || "笔记节点" : node.kind === "group" ? node.text || "分组" : node.kind === "image" ? node.text || "图片" : "节点";
            const sub = node.kind === "row" && row ? rowSubtitle(row) : node.kind === "pdf" ? (project.rows.find(item => item.id === node.rowId)?.values.doi as string || "") : node.kind === "note" ? (node.text || "") : "";
            const classes = ["pz-matrix-canvas-node", `is-${node.kind}`, filtered ? "is-filtered" : "", selectedNodeIds.has(node.id) ? "is-selected" : ""].filter(Boolean).join(" ");
            const thumbUrl = node.thumbnailPath ? thumbnailUrls.get(node.thumbnailPath) : node.thumbnail;
            return `<div class="${classes}" data-node-id="${node.id}" data-row-id="${node.rowId || ""}" style="left:${node.x}px;top:${node.y}px;width:${node.width || 220}px;height:${node.height || 80}px;${node.color ? `border-color:${node.color};` : ""}">
              <div class="pz-canvas-node-head"><span>${escapeHtml(title)}</span>${node.kind === "row" ? `<button data-act="canvas-open-row" data-row="${node.rowId}" title="打开详情">↗</button>` : node.kind === "group" ? `<button data-act="canvas-toggle-group" data-node="${node.id}" title="折叠/展开分组">${node.collapsed ? "▸" : "▾"}</button>` : ""}<button data-act="canvas-node-menu" data-node="${node.id}" title="节点操作">⋯</button></div>
              ${sub ? `<div class="pz-canvas-node-sub">${escapeHtml(String(sub))}</div>` : ""}
              ${node.kind === "pdf" && thumbUrl ? `<img class="pz-canvas-node-thumb" src="${escapeHtml(thumbUrl)}" alt="PDF 缩略图" />` : ""}
              ${node.kind === "tag" ? `<div class="pz-canvas-node-tag">${escapeHtml(node.text || "")}</div>` : ""}
              ${node.kind === "image" && node.text ? `<img class="pz-canvas-node-image" src="${escapeHtml(node.text)}" alt="画布图片" />` : ""}
            </div>`;
        }).join("");
        const kindCounts = new Map<string, number>();
        for (const edge of canvas.edges) kindCounts.set(edge.kind, (kindCounts.get(edge.kind) || 0) + 1);
        const worldSize = 2000;
        const mmW = 160;
        const mmH = 108;
        const viewLeft = Math.max(0, -canvasPanX / canvasZoom);
        const viewTop = Math.max(0, -canvasPanY / canvasZoom);
        const viewWidth = Math.min(worldSize, canvasRoot.clientWidth / canvasZoom);
        const viewHeight = Math.min(worldSize, canvasRoot.clientHeight / canvasZoom);
        canvasMinimap.innerHTML = `${canvas.nodes.map(node => `<div class="pz-minimap-node is-${node.kind}" style="left:${Math.max(0, Math.min(100, node.x / worldSize * 100))}%;top:${Math.max(0, Math.min(100, node.y / worldSize * 100))}%;width:${Math.max(2, (node.width || 220) / worldSize * 100)}%;height:${Math.max(2, (node.height || 80) / worldSize * 100)}%"></div>`).join("")}<div class="pz-minimap-view" style="left:${viewLeft / worldSize * 100}%;top:${viewTop / worldSize * 100}%;width:${viewWidth / worldSize * 100}%;height:${viewHeight / worldSize * 100}%"></div>`;
        canvasHint.textContent = `${canvas.nodes.length} 节点 · ${canvas.edges.length} 关系 · 自动提示 ${hints.length}${edgeKindFilter ? " · 已按类型筛选" : ""}${canvas.edges.length ? ` · ${Array.from(kindCounts.entries()).map(([kind, count]) => `${kind} ${count}`).join(" / ")}` : ""}`;
        updateStatus();
        bindCanvasEvents(canvas, rowNodeId);
        hydratePdfThumbnails();
    };

    const openEdgeEditor = (canvas: MatrixCanvasState, edge: MatrixCanvasEdge) => {
        const editor = new Dialog({
            title: "编辑关系",
            width: "480px",
            content: `<div class="b3-dialog__content">
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>关系类型</span><select class="b3-select fn__block" data-field="kind">${[["citation", "引用"], ["contrast", "对比"], ["method", "方法"], ["conclusion", "结论"], ["data", "数据"], ["other", "其他"]].map(([value, label]) => `<option value="${value}" ${edge.kind === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>自定义标签</span><input class="b3-text-field fn__block" data-field="label" value="${escapeHtml(edge.label || edge.kind)}" /></label>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px"><input type="checkbox" data-field="directed" ${edge.directed ? "checked" : ""} /> 有方向</label>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="delete">删除关系</button><div class="fn__space"></div><button class="b3-button b3-button--cancel" data-act="cancel">取消</button><button class="b3-button b3-button--text" data-act="save">保存</button></div>`,
        });
        editor.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => editor.destroy());
        editor.element.querySelector('[data-act="delete"]')?.addEventListener("click", async () => {
            pushCanvasHistory();
            canvas.edges = canvas.edges.filter(item => item.id !== edge.id);
            project.updatedAt = Date.now();
            await host.store.save();
            editor.destroy();
            renderCanvas();
        });
        editor.element.querySelector('[data-act="save"]')?.addEventListener("click", async () => {
            edge.kind = (editor.element.querySelector<HTMLSelectElement>('[data-field="kind"]')?.value || "other") as MatrixCanvasEdge["kind"];
            edge.label = editor.element.querySelector<HTMLInputElement>('[data-field="label"]')?.value.trim() || edge.kind;
            edge.directed = Boolean(editor.element.querySelector<HTMLInputElement>('[data-field="directed"]')?.checked);
            project.updatedAt = Date.now();
            await host.store.save();
            editor.destroy();
            renderCanvas();
        });
    };

    const openEdgeList = () => {
        const canvas = canvasFor(ensureActiveView());
        const nodeTitle = (id: string) => {
            const node = canvas.nodes.find(item => item.id === id);
            if (!node) return "节点";
            if (node.kind === "row" && node.rowId) {
                const row = project.rows.find(item => item.id === node.rowId);
                return row ? rowTitle(row) : "文献";
            }
            return node.text || node.kind;
        };
        const editor = new Dialog({
            title: "画布关系",
            width: "760px",
            content: `<div class="b3-dialog__content">
  <div class="pz-muted" style="margin-bottom:8px">共 ${canvas.edges.length} 条关系；点击编辑修改类型和标签。</div>
  <div class="pz-matrix-edge-list">${canvas.edges.length ? canvas.edges.map(edge => `<div class="pz-matrix-edge-row" data-edge-id="${edge.id}"><span class="pz-matrix-edge-label">${escapeHtml(edge.label || edge.kind)}</span><span class="pz-muted">${escapeHtml(nodeTitle(edge.from))} → ${escapeHtml(nodeTitle(edge.to))}</span><button class="b3-button b3-button--outline" data-act="edit-edge">编辑</button><button class="b3-button b3-button--outline" data-act="delete-edge">删除</button></div>`).join("") : `<div class="pz-muted">还没有正式关系；使用画布“连线”建立关系。</div>`}</div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="cancel">关闭</button></div>`,
        });
        editor.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => editor.destroy());
        for (const button of Array.from(editor.element.querySelectorAll<HTMLElement>('[data-act="edit-edge"]'))) {
            button.addEventListener("click", () => {
                const row = button.closest<HTMLElement>("[data-edge-id]");
                const edge = canvas.edges.find(item => item.id === row?.dataset.edgeId);
                if (!edge) return;
                editor.destroy();
                openEdgeEditor(canvas, edge);
            });
        }
        for (const button of Array.from(editor.element.querySelectorAll<HTMLElement>('[data-act="delete-edge"]'))) {
            button.addEventListener("click", async () => {
                const row = button.closest<HTMLElement>("[data-edge-id]");
                const id = row?.dataset.edgeId || "";
                pushCanvasHistory();
                canvas.edges = canvas.edges.filter(item => item.id !== id);
                project.updatedAt = Date.now();
                await host.store.save();
                editor.destroy();
                renderCanvas();
            });
        }
    };

    const openCanvasNodeMenu = (event: MouseEvent, node: MatrixCanvasNode, canvas: MatrixCanvasState) => {
        event.preventDefault();
        event.stopPropagation();
        document.querySelectorAll(".pz-matrix-node-menu").forEach(item => item.remove());
        const menu = document.createElement("div");
        menu.className = "pz-matrix-node-menu";
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;
        const add = (label: string, action: () => void, danger = false) => {
            const button = document.createElement("button");
            button.textContent = label;
            if (danger) button.classList.add("is-danger");
            button.addEventListener("click", event => {
                event.stopPropagation();
                menu.remove();
                action();
            });
            menu.appendChild(button);
        };
        if (node.rowId) add("打开文献详情", () => {
            const row = project.rows.find(item => item.id === node.rowId);
            if (row) openMatrixRow(host, project, row);
        });
        add("复制节点", () => {
            pushCanvasHistory();
            const copy = {...node, id: newId("mxnode"), x: node.x + 30, y: node.y + 30};
            canvas.nodes.push(copy);
            selectedNodeIds.clear();
            selectedNodeIds.add(copy.id);
            project.updatedAt = Date.now();
            void host.store.save();
            renderCanvas();
        });
        for (const [label, color] of [["蓝色", "#4f63d2"], ["绿色", "#3fbf7f"], ["橙色", "#d98b3f"], ["红色", "#d9534f"], ["紫色", "#8b5cf6"]]) {
            add(label, () => {
                pushCanvasHistory();
                node.color = color;
                project.updatedAt = Date.now();
                void host.store.save();
                renderCanvas();
            });
        }
        add("清除颜色", () => {
            pushCanvasHistory();
            delete node.color;
            project.updatedAt = Date.now();
            void host.store.save();
            renderCanvas();
        });
        if (node.kind !== "row") add("删除节点", () => {
            pushCanvasHistory();
            if (node.thumbnailPath) void removeThumbnailCache(node.thumbnailPath);
            canvas.nodes = canvas.nodes.filter(item => item.id !== node.id);
            canvas.edges = canvas.edges.filter(edge => edge.from !== node.id && edge.to !== node.id);
            project.updatedAt = Date.now();
            void host.store.save();
            renderCanvas();
        }, true);
        document.body.appendChild(menu);
        const close = (event2: MouseEvent) => {
            if (!menu.contains(event2.target as Node)) {
                menu.remove();
                document.removeEventListener("pointerdown", close, true);
            }
        };
        window.setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
    };

    const openBatchColorDialog = () => {
        if (!selectedNodeIds.size) {
            showMessage("请先选择要设置颜色的节点", 2200);
            return;
        }
        const editor = new Dialog({
            title: "节点颜色",
            width: "420px",
            content: `<div class="b3-dialog__content"><div class="pz-muted" style="margin-bottom:10px">已选择 ${selectedNodeIds.size} 个节点</div><div class="pz-matrix-color-row">${[["蓝", "#4f63d2"], ["绿", "#3fbf7f"], ["橙", "#d98b3f"], ["红", "#d9534f"], ["紫", "#8b5cf6"], ["无", ""]].map(([label, color]) => `<button class="pz-matrix-color-swatch" data-color="${color}" style="${color ? `background:${color};` : ""}">${label}</button>`).join("")}</div></div><div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="cancel">取消</button></div>`,
        });
        editor.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => editor.destroy());
        for (const button of Array.from(editor.element.querySelectorAll<HTMLElement>("[data-color]"))) {
            button.addEventListener("click", async () => {
                const color = button.dataset.color || "";
                const canvas = canvasFor(ensureActiveView());
                pushCanvasHistory();
                for (const node of canvas.nodes) {
                    if (!selectedNodeIds.has(node.id)) continue;
                    if (color) node.color = color;
                    else delete node.color;
                }
                project.updatedAt = Date.now();
                await host.store.save();
                editor.destroy();
                renderCanvas();
            });
        }
    };

    let canvasStateForDrag: { nodeId: string; startX: number; startY: number; positions: Map<string, {x: number; y: number}>; moved: boolean; additive: boolean } | null = null;    let panState: { x: number; y: number; panX: number; panY: number } | null = null;
    const bindCanvasEvents = (canvas: MatrixCanvasState, rowNodeId: Map<string, string>) => {
        const save = () => {
            canvas.zoom = canvasZoom;
            canvas.panX = canvasPanX;
            canvas.panY = canvasPanY;
            project.updatedAt = Date.now();
            void host.store.save();
        };
        canvasMinimap.onclick = event => {
            event.stopPropagation();
            const rect = canvasMinimap.getBoundingClientRect();
            const worldX = (event.clientX - rect.left) / rect.width * 2000;
            const worldY = (event.clientY - rect.top) / rect.height * 2000;
            canvasPanX = canvasRoot.clientWidth / 2 - worldX * canvasZoom;
            canvasPanY = canvasRoot.clientHeight / 2 - worldY * canvasZoom;
            save();
            renderCanvas();
        };
        for (const nodeEl of Array.from(canvasNodes.querySelectorAll<HTMLElement>(".pz-matrix-canvas-node"))) {
            nodeEl.addEventListener("pointerdown", event => {
                if ((event.target as HTMLElement).closest("button")) return;
                const node = canvas.nodes.find(item => item.id === nodeEl.dataset.nodeId);
                if (!node) return;
                canvasRoot.focus();
                if (connectMode) {
                    if (!connectFrom) {
                        connectFrom = node.id;
                        selectedNodeIds.clear();
                        selectedNodeIds.add(node.id);
                        canvasSelectedNode = node.id;
                        canvasHint.textContent = "已选择起点，请点击终点";
                        renderCanvas();
                        return;
                    }
                    if (connectFrom !== node.id) {
                        const kind = (window.prompt("关系类型：citation / contrast / method / conclusion / data / other", "other") || "other") as MatrixCanvasEdge["kind"];
                        const directed = ["citation", "method", "data"].includes(kind);
                        const label = (window.prompt("关系标签（可留空）", kind) || kind).trim() || kind;
                        pushCanvasHistory();
                        canvas.edges.push({id: newId("mxedge"), from: connectFrom, to: node.id, kind, directed, label});
                        project.updatedAt = Date.now();
                        void host.store.save();
                    }
                    connectFrom = "";
                    connectMode = false;
                    canvasHint.textContent = "已建立关系";
                    renderCanvas();
                    return;
                }
                const additive = event.shiftKey || event.metaKey || event.ctrlKey;
                if (additive) {
                    if (selectedNodeIds.has(node.id)) selectedNodeIds.delete(node.id);
                    else selectedNodeIds.add(node.id);
                } else if (!selectedNodeIds.has(node.id)) {
                    selectedNodeIds.clear();
                    selectedNodeIds.add(node.id);
                }
                canvasSelectedNode = node.id;
                for (const el of Array.from(canvasNodes.querySelectorAll<HTMLElement>(".pz-matrix-canvas-node"))) {
                    el.classList.toggle("is-selected", selectedNodeIds.has(el.dataset.nodeId || ""));
                }
                pushCanvasHistory();
                const positions = new Map<string, {x: number; y: number}>();
                for (const id of selectedNodeIds) {
                    const selected = canvas.nodes.find(item => item.id === id);
                    if (selected) positions.set(id, {x: selected.x, y: selected.y});
                }
                nodeEl.setPointerCapture(event.pointerId);
                canvasStateForDrag = {nodeId: node.id, startX: event.clientX, startY: event.clientY, positions, moved: false, additive};
            });
            nodeEl.addEventListener("contextmenu", event => {
                const node = canvas.nodes.find(item => item.id === nodeEl.dataset.nodeId);
                if (node) openCanvasNodeMenu(event, node, canvas);
            });
            nodeEl.addEventListener("pointerup", event => {
                const drag = canvasStateForDrag;
                canvasStateForDrag = null;
                if (!drag) return;
                const node = canvas.nodes.find(item => item.id === drag.nodeId);
                if (!node) return;
                if (drag.moved) {
                    save();
                } else if (!drag.additive) {
                    const rowId = nodeEl.dataset.rowId;
                    if (rowId) {
                        const row = project.rows.find(item => item.id === rowId);
                        if (row) openMatrixRow(host, project, row);
                    } else if (node.kind === "note" && node.docId) {
                        host.openDoc(node.docId);
                    }
                }
            });
        }
        const viewport = canvasRoot;
        viewport.oncontextmenu = event => {
            const nodeEl = (event.target as HTMLElement).closest<HTMLElement>(".pz-matrix-canvas-node");
            if (!nodeEl) return;
            const node = canvas.nodes.find(item => item.id === nodeEl.dataset.nodeId);
            if (node) openCanvasNodeMenu(event, node, canvas);
        };
        viewport.addEventListener("pointerdown", event => {
            if ((event.target as HTMLElement).closest(".pz-matrix-canvas-node")) return;
            viewport.focus();
            if (marqueeMode) {
                const box = document.createElement("div");
                box.className = "pz-matrix-marquee";
                box.style.left = `${event.clientX}px`;
                box.style.top = `${event.clientY}px`;
                box.style.width = "0px";
                box.style.height = "0px";
                document.body.appendChild(box);
                marqueeState = {startX: event.clientX, startY: event.clientY, box, additive: event.shiftKey || event.metaKey || event.ctrlKey};
                return;
            }
            panState = {x: event.clientX, y: event.clientY, panX: canvasPanX, panY: canvasPanY};
            selectedNodeIds.clear();
            canvasSelectedNode = "";
        });
        viewport.addEventListener("pointermove", event => {
            if (marqueeState) {
                const left = Math.min(marqueeState.startX, event.clientX);
                const top = Math.min(marqueeState.startY, event.clientY);
                marqueeState.box.style.left = `${left}px`;
                marqueeState.box.style.top = `${top}px`;
                marqueeState.box.style.width = `${Math.abs(event.clientX - marqueeState.startX)}px`;
                marqueeState.box.style.height = `${Math.abs(event.clientY - marqueeState.startY)}px`;
                return;
            }
            if (canvasStateForDrag) {
                const dx = event.clientX - canvasStateForDrag.startX;
                const dy = event.clientY - canvasStateForDrag.startY;
                if (Math.abs(dx) + Math.abs(dy) > 2) canvasStateForDrag.moved = true;
                for (const [id, start] of canvasStateForDrag.positions) {
                    const node = canvas.nodes.find(item => item.id === id);
                    if (!node) continue;
                    node.x = Math.max(0, start.x + dx);
                    node.y = Math.max(0, start.y + dy);
                    const el = canvasNodes.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
                    if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
                }
                return;
            }
            if (!panState) return;
            canvasPanX = panState.panX + event.clientX - panState.x;
            canvasPanY = panState.panY + event.clientY - panState.y;
            canvasWorld.style.transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasZoom})`;
        });
        viewport.addEventListener("pointerup", event => {
            if (marqueeState) {
                const left = Math.min(marqueeState.startX, event.clientX);
                const top = Math.min(marqueeState.startY, event.clientY);
                const right = Math.max(marqueeState.startX, event.clientX);
                const bottom = Math.max(marqueeState.startY, event.clientY);
                marqueeState.box.remove();
                if (!marqueeState.additive) selectedNodeIds.clear();
                for (const nodeEl of Array.from(canvasNodes.querySelectorAll<HTMLElement>(".pz-matrix-canvas-node"))) {
                    const rect = nodeEl.getBoundingClientRect();
                    if (rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom) {
                        selectedNodeIds.add(nodeEl.dataset.nodeId || "");
                    }
                }
                for (const nodeEl of Array.from(canvasNodes.querySelectorAll<HTMLElement>(".pz-matrix-canvas-node"))) {
                    nodeEl.classList.toggle("is-selected", selectedNodeIds.has(nodeEl.dataset.nodeId || ""));
                }
                marqueeState = null;
                return;
            }
            if (panState) { save(); panState = null; }
        });
        viewport.addEventListener("wheel", event => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            canvasZoom = Math.max(0.35, Math.min(2.2, canvasZoom - event.deltaY * 0.001));
            canvasWorld.style.transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasZoom})`;
            save();
        }, {passive: false});
        viewport.addEventListener("dragover", event => event.preventDefault());        viewport.addEventListener("drop", event => {
            event.preventDefault();
            const raw = event.dataTransfer?.getData("text/plain") || "";
            if (!raw) return;
            let row: MatrixRow | undefined;
            let kind: MatrixCanvasNode["kind"] = "row";
            let nodeText = "";
            let noteDocId = "";
            let noteBlockId = "";
            let attachmentId = "";
            if (raw.startsWith("pz-zotero:")) {
                const itemKey = raw.slice("pz-zotero:".length);
                row = project.rows.find(item => item.itemKey === itemKey);
                const item = (host.store.state.zotero.items || []).find(entry => entry.key === itemKey);
                if (!row && item) {
                    row = rowForZoteroItem(item, host.store.state.zotero.libraryId || 0);
                    project.rows.push(row);
                }
                kind = "row";
            } else if (raw.startsWith("siyuan://blocks/") || raw.startsWith("((")) {
                kind = "note";
                noteBlockId = raw.startsWith("siyuan://blocks/") ? raw.slice("siyuan://blocks/".length).split(/[?&#]/)[0] : (raw.match(/\(\(([^\s"]+)/)?.[1] || "");
                noteDocId = noteBlockId;
                nodeText = raw.slice(0, 120);
            } else if (raw.startsWith("pz-pdf:")) {
                const attachment = host.store.getAttachment(raw.slice("pz-pdf:".length));
                attachmentId = attachment?.id || "";
                const itemKey = attachment?.zotero?.itemKey || "";
                row = project.rows.find(item => item.itemKey === itemKey);
                const item = itemKey ? (host.store.state.zotero.items || []).find(entry => entry.key === itemKey) : undefined;
                if (!row && item) {
                    row = rowForZoteroItem(item, host.store.state.zotero.libraryId || 0);
                    project.rows.push(row);
                }
                kind = "pdf";
                nodeText = attachment?.fileName || attachment?.zotero?.attachmentTitle || "PDF 节点";
            } else {
                row = project.rows.find(item => item.id === raw);
            }
            if (!row && kind !== "pdf" && kind !== "note") return;
            const rect = viewport.getBoundingClientRect();
            const x = Math.max(0, (event.clientX - rect.left - canvasPanX) / canvasZoom - 110);
            const y = Math.max(0, (event.clientY - rect.top - canvasPanY) / canvasZoom - 40);
            let node = row ? canvas.nodes.find(item => item.rowId === row!.id && item.kind === kind) : undefined;
            pushCanvasHistory();
            if (node) {
                node.x = x;
                node.y = y;
            } else {
                node = {id: newId("mxnode"), kind, rowId: row?.id, docId: noteDocId || undefined, blockId: noteBlockId || undefined, attachmentId: attachmentId || undefined, text: nodeText || undefined, x, y, width: 232, height: 86};
                canvas.nodes.push(node);
            }
            project.updatedAt = Date.now();
            void host.store.save();
            renderCanvas();
        });
        for (const button of Array.from(canvasNodes.querySelectorAll<HTMLElement>('[data-act="canvas-open-row"]'))) {
            button.addEventListener("click", event => {
                event.stopPropagation();
                const row = project.rows.find(item => item.id === button.dataset.row);
                if (row) openMatrixRow(host, project, row);
            });
        }
        for (const button of Array.from(canvasNodes.querySelectorAll<HTMLElement>('[data-act="canvas-toggle-group"]'))) {
            button.addEventListener("click", event => {
                event.stopPropagation();
                const node = canvas.nodes.find(item => item.id === button.dataset.node);
                if (!node) return;
                pushCanvasHistory();
                node.collapsed = !node.collapsed;
                project.updatedAt = Date.now();
                void host.store.save();
                renderCanvas();
            });
        }
        for (const button of Array.from(canvasNodes.querySelectorAll<HTMLElement>('[data-act="canvas-node-menu"]'))) {
            button.addEventListener("click", event => {
                event.stopPropagation();
                const node = canvas.nodes.find(item => item.id === button.dataset.node);
                if (!node) return;
                const rect = button.getBoundingClientRect();
                openCanvasNodeMenu(new MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom}), node, canvas);
            });
        }
        for (const edgeEl of Array.from(canvasEdges.querySelectorAll<SVGGElement>("[data-edge-id]"))) {
            edgeEl.addEventListener("click", event => {
                event.stopPropagation();
                const id = edgeEl.dataset.edgeId || "";
                const edge = canvas.edges.find(item => item.id === id);
                if (edge) openEdgeEditor(canvas, edge);
            });
        }
        for (const edgeText of Array.from(canvasEdges.querySelectorAll<SVGTextElement>("text"))) {
            edgeText.addEventListener("click", event => {
                event.stopPropagation();
                const id = edgeText.closest<SVGGElement>("[data-edge-id]")?.dataset.edgeId || "";
                const edge = canvas.edges.find(item => item.id === id);
                if (edge) openEdgeEditor(canvas, edge);
            });
        }
        canvasEdges.addEventListener("click", event => {
            if ((event.target as Element).closest("[data-edge-id]")) return;
            const point = {x: event.clientX, y: event.clientY};
            const distance = (ax: number, ay: number, bx: number, by: number) => {
                const dx = bx - ax;
                const dy = by - ay;
                const length = dx * dx + dy * dy;
                const t = length ? Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / length)) : 0;
                return Math.hypot(point.x - (ax + t * dx), point.y - (ay + t * dy));
            };
            let closest: MatrixCanvasEdge | undefined;
            let closestDistance = 14;
            for (const edge of canvas.edges) {
                const fromEl = canvasNodes.querySelector<HTMLElement>(`[data-node-id="${edge.from}"]`);
                const toEl = canvasNodes.querySelector<HTMLElement>(`[data-node-id="${edge.to}"]`);
                if (!fromEl || !toEl) continue;
                const a = fromEl.getBoundingClientRect();
                const b = toEl.getBoundingClientRect();
                const dist = distance(a.left + a.width / 2, a.top + a.height / 2, b.left + b.width / 2, b.top + b.height / 2);
                if (dist < closestDistance) {
                    closestDistance = dist;
                    closest = edge;
                }
            }
            if (closest) openEdgeEditor(canvas, closest);
        });
        for (const hintLine of Array.from(canvasEdges.querySelectorAll<SVGLineElement>("[data-hint-from]"))) {
            hintLine.addEventListener("click", () => {
                const from = hintLine.dataset.hintFrom || "";
                const to = hintLine.dataset.hintTo || "";
                if (!from || !to) return;
                const kind = (window.prompt("转为正式关系，类型：citation / contrast / method / conclusion / data / other", "other") || "other") as MatrixCanvasEdge["kind"];
                const directed = ["citation", "method", "data"].includes(kind);
                const label = (window.prompt("关系标签（可留空）", kind) || kind).trim() || kind;
                pushCanvasHistory();
                canvas.edges.push({id: newId("mxedge"), from, to, kind, directed, label});
                project.updatedAt = Date.now();
                void host.store.save();
                renderCanvas();
            });
        }
    };

    /** Gallery preferences are global and persisted in plugin state (survives restarts). */
    const loadGalleryPrefs = (): GallerySettings => {
        const stored = host.store.state.gallery;
        if (stored) return normalizeGallerySettings(stored);
        try {
            const legacy = globalThis.localStorage?.getItem(`pdf-zotero-gallery:${project.id}`);
            if (legacy) {
                const imported = normalizeGallerySettings(JSON.parse(legacy));
                host.store.state.gallery = imported;
                void host.store.save();
                return imported;
            }
        } catch {
            // legacy value unreadable; fall back to defaults
        }
        const fresh = normalizeGallerySettings(undefined);
        host.store.state.gallery = fresh;
        void host.store.save();
        return fresh;
    };
    const saveGalleryPrefs = (settings: GallerySettings): void => {
        host.store.state.gallery = {...settings};
        void host.store.save();
    };

    let gallerySettings: GallerySettings = loadGalleryPrefs();
    let galleryStatusFilter: "" | ReadingStatus = "";
    const galleryCovers = new Map<string, string>();
    const galleryPending = new Set<string>();
    const galleryCoverQueue: string[] = [];
    let galleryCoverActive = 0;
    let galleryCoverObserver: IntersectionObserver | null = null;
    const noteTitles = new Map<string, string>();

    const resolveGalleryCover = async (ref: string): Promise<string | null> => {
        if (ref.startsWith("att:")) return makePdfThumbnail(host, ref.slice(4));
        if (ref.startsWith("zot:")) return makeZoteroThumbnail(host, ref.slice(4));
        return null;
    };

    const pumpGalleryCovers = () => {
        while (galleryCoverActive < 2 && galleryCoverQueue.length) {
            const ref = galleryCoverQueue.shift()!;
            galleryCoverActive += 1;
            void resolveGalleryCover(ref).then(url => {
                if (!url) {
                    for (const holder of Array.from(galleryRoot.querySelectorAll<HTMLElement>(`[data-cover-ref="${CSS.escape(ref)}"]`))) {
                        if (holder.querySelector("img")) continue;
                        holder.classList.remove("is-loading");
                        holder.classList.add("is-empty");
                        const fallback = holder.querySelector<HTMLElement>(".pz-gallery-cover-fallback");
                        if (fallback) fallback.textContent = "无封面";
                    }
                    return;
                }
                galleryCovers.set(ref, url);
                while (galleryCovers.size > ZOTERO_COVER_LIMIT) {
                    const oldest = galleryCovers.keys().next().value;
                    if (!oldest) break;
                    galleryCovers.delete(oldest);
                }
                for (const holder of Array.from(galleryRoot.querySelectorAll<HTMLElement>(`[data-cover-ref="${CSS.escape(ref)}"]`))) {
                    if (holder.querySelector("img")) continue;
                    holder.classList.remove("is-loading");
                    holder.classList.add("has-cover");
                    const position = readGalleryCrop(holder.dataset.itemKey || "");
                    holder.innerHTML = `<img src="${url}" alt="" style="object-position:center ${position}%" />`;
                }
            }).finally(() => {
                galleryCoverActive -= 1;
                if (typeof (globalThis as any).requestIdleCallback === "function") {
                    (globalThis as any).requestIdleCallback(() => pumpGalleryCovers(), {timeout: 600});
                } else {
                    globalThis.setTimeout(() => pumpGalleryCovers(), 30);
                }
            });
        }
    };

    const gallerySortedRows = (rows: MatrixRow[]): MatrixRow[] => {
        const columnId = gallerySettings.sortColumn;
        if (!columnId) return rows;
        const column = project.columns.find(item => item.id === columnId);
        const numeric = column?.type === "number" || column?.type === "rating";
        return [...rows].sort((a, b) => {
            const av = a.values[columnId];
            const bv = b.values[columnId];
            const result = numeric
                ? (Number(av) || 0) - (Number(bv) || 0)
                : String(av ?? "").localeCompare(String(bv ?? ""), "zh-CN");
            return gallerySettings.sortDirection === "desc" ? -result : result;
        });
    };

    const hydrateGalleryCovers = () => {
        const holders = Array.from(galleryRoot.querySelectorAll<HTMLElement>("[data-cover-ref]"));
        const enqueue = (ref: string) => {
            const cachedUrl = galleryCovers.get(ref);
            if (cachedUrl) {
                for (const holder of Array.from(galleryRoot.querySelectorAll<HTMLElement>(`[data-cover-ref="${CSS.escape(ref)}"]`))) {
                    if (holder.querySelector("img")) continue;
                    holder.classList.remove("is-loading");
                    holder.classList.add("has-cover");
                    const position = readGalleryCrop(holder.dataset.itemKey || "");
                    holder.innerHTML = `<img src="${cachedUrl}" alt="" style="object-position:center ${position}%" />`;
                }
                return;
            }
            if (galleryPending.has(ref)) return;
            galleryPending.add(ref);
            galleryCoverQueue.push(ref);
            pumpGalleryCovers();
        };
        if (typeof IntersectionObserver === "undefined") {
            for (const holder of holders) enqueue(holder.dataset.coverRef || "");
            return;
        }
        if (!galleryCoverObserver) {
            galleryCoverObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const holder = entry.target as HTMLElement;
                    galleryCoverObserver?.unobserve(holder);
                    enqueue(holder.dataset.coverRef || "");
                }
            }, {root: galleryRoot, rootMargin: "0px"});
        }
        for (const holder of holders) {
            const ref = holder.dataset.coverRef || "";
            if (!ref) continue;
            if (galleryCovers.has(ref)) {
                enqueue(ref);
                continue;
            }
            galleryCoverObserver.observe(holder);
        }
    };

    const galleryKindIcon = (code: string): string => {
        if (code === "thesis") return "🎓";
        if (code === "book" || code === "bookSection") return "📕";
        if (code === "preprint") return "📰";
        if (code === "conferencePaper") return "📄";
        return "📄";
    };

    const galleryGroupFor = (row: MatrixRow, items: Map<string, any>): {key: string; label: string} => {
        switch (gallerySettings.groupBy) {
            case "year": {
                const year = String(row.values.year ?? "").trim();
                return {key: year || "未填写", label: year || "未填写年份"};
            }
            case "venue": {
                const venue = String(row.values.venue ?? "").trim();
                return {key: venue || "未填写", label: venue || "未填写期刊"};
            }
            case "rating": {
                const rating = host.store.itemMeta(row.itemKey)?.rating || 0;
                return {key: String(rating), label: rating ? `${"★".repeat(rating)}` : "未评分"};
            }
            case "readStatus": {
                const attachment = attachmentForZoteroItem(host.store, row.itemKey);
                const status = attachment ? statusForStat(host.store, host.store.readingStat(attachment.id)) : "unread";
                return {key: status, label: statusLabel(status) || "未读"};
            }
            default: {
                const itemType = items.get(row.itemKey)?.itemType || "";
                return {key: itemType || "other", label: itemTypeLabel(itemType)};
            }
        }
    };

    const GALLERY_OVERSCAN = 360;
    const GALLERY_CARD_ESTIMATE = 260;

    interface GalleryVirtualColumn {
        key: string;
        rows: MatrixRow[];
        el: HTMLElement;
        windowEl: HTMLElement;
    }

    let galleryVirtual: {
        columns: GalleryVirtualColumn[];
        heights: Map<string, number[]>;
        ranges: Map<string, [number, number]>;
        rowsById: Map<string, MatrixRow>;
        cardHtml: (row: MatrixRow) => string;
    } | null = null;
    let galleryVirtualFrame = 0;
    let galleryMenuOpenedAt = 0;
    let galleryScroll = {top: 0, left: 0};
    const gallerySelected = new Set<string>();
    const GALLERY_CROP_PREFIX = "pdf-zotero-gallery-crop:";

    const readGalleryCrop = (itemKey: string): number => {
        const stored = host.store.state.coverCrop?.[itemKey];
        if (typeof stored === "number") return Math.min(100, Math.max(0, stored));
        try {
            const legacy = globalThis.localStorage?.getItem(GALLERY_CROP_PREFIX + itemKey);
            if (legacy !== null) {
                const value = Math.min(100, Math.max(0, Number(legacy) || 0));
                host.store.state.coverCrop = {...(host.store.state.coverCrop || {}), [itemKey]: value};
                void host.store.save();
                return value;
            }
        } catch {
            // ignore unreadable legacy value
        }
        return 0;
    };
    const writeGalleryCrop = (itemKey: string, value: number): void => {
        host.store.state.coverCrop = {
            ...(host.store.state.coverCrop || {}),
            [itemKey]: Math.min(100, Math.max(0, value)),
        };
        void host.store.save();
    };

    const copyToClipboard = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text);
            showMessage(`已复制${label}`, 1500);
        } catch {
            showMessage("复制失败", 2500, "error");
        }
    };

    const rowBibtex = (row: MatrixRow): string => {
        const authors = String(row.values.authors || "").split(";").map(item => item.trim()).filter(Boolean);
        const first = (authors[0] || "").replace(/[^A-Za-z]/g, "").toLowerCase() || "ref";
        const year = String(row.values.year || "");
        const fields = [
            `  title = {${row.values.title || ""}}`,
            authors.length ? `  author = {${authors.join(" and ")}}` : "",
            year ? `  year = {${year}}` : "",
            row.values.venue ? `  journal = {${row.values.venue}}` : "",
            row.values.doi ? `  doi = {${row.values.doi}}` : "",
        ].filter(Boolean).join(",\n");
        return `@article{${first}${year},\n${fields}\n}`;
    };

    const closeGalleryMenu = () => {
        document.querySelectorAll(".pz-gallery-menu").forEach(element => element.remove());
    };

    interface GalleryMenuItem {
        label: string;
        action?: () => void;
        disabled?: boolean;
        checked?: boolean;
        children?: GalleryMenuItem[];
    }

    const showGalleryMenu = (x: number, y: number, items: GalleryMenuItem[]) => {
        closeGalleryMenu();
        const menu = document.createElement("div");
        menu.className = "pz-gallery-menu";
        const renderItems = (list: GalleryMenuItem[], parentPath: string): string => list.map((item, index) => {
            const path = parentPath ? `${parentPath}.${index}` : String(index);
            if (item.label === "-") return `<div class="pz-gallery-menu-sep"></div>`;
            const prefix = item.checked ? "✓ " : "";
            if (item.children?.length) {
                return `<div class="pz-gallery-menu-item"><button data-gallery-menu-path="${path}">${prefix}${escapeHtml(item.label)} ▸</button><div class="pz-gallery-submenu">${renderItems(item.children, path)}</div></div>`;
            }
            return `<button data-gallery-menu-path="${path}" ${item.disabled ? "disabled" : ""}>${prefix}${escapeHtml(item.label)}</button>`;
        }).join("");
        const resolve = (path: string): GalleryMenuItem | undefined => {
            let list = items;
            let found: GalleryMenuItem | undefined;
            for (const part of path.split(".")) {
                found = list[Number(part)];
                if (!found) return undefined;
                list = found.children || [];
            }
            return found;
        };
        menu.innerHTML = renderItems(items, "");
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`;
        menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`;
        menu.addEventListener("click", event => {
            const button = (event.target as HTMLElement).closest<HTMLElement>("[data-gallery-menu-path]");
            if (!button) return;
            const item = resolve(button.dataset.galleryMenuPath || "");
            if (!item || item.children?.length) return;
            closeGalleryMenu();
            item.action?.();
        });
        const onPointerDown = (event: PointerEvent) => {
            if ((event.target as HTMLElement)?.closest?.(".pz-gallery-menu")) return;
            closeGalleryMenu();
            document.removeEventListener("pointerdown", onPointerDown, true);
        };
        window.setTimeout(() => {
            document.addEventListener("pointerdown", onPointerDown, true);
        }, 0);
    };
    const galleryHeightAt = (heights: number[] | undefined, index: number): number => heights?.[index] ?? GALLERY_CARD_ESTIMATE;

    /** Style-style column virtualisation: only the visible slice (±overscan) is mounted. */
    const updateGalleryVirtual = (force = false) => {
        const state = galleryVirtual;
        if (!state || !galleryRoot.isConnected) return;
        const viewHeight = galleryRoot.clientHeight || galleryRoot.parentElement?.clientHeight || 600;
        const scrollTop = galleryRoot.scrollTop;
        const viewBottom = scrollTop + viewHeight;
        for (const column of state.columns) {
            const heights = state.heights.get(column.key) || [];
            const groupTop = column.el.offsetTop;
            const localTop = Math.max(0, scrollTop - groupTop - GALLERY_OVERSCAN);
            let acc = 0;
            let start = 0;
            while (start < column.rows.length) {
                const height = galleryHeightAt(heights, start);
                if (acc + height > localTop) break;
                acc += height;
                start += 1;
            }
            const localBottom = viewBottom - groupTop + GALLERY_OVERSCAN;
            let end = start;
            let cursor = acc;
            while (end < column.rows.length && cursor < localBottom) {
                cursor += galleryHeightAt(heights, end);
                end += 1;
            }
            // Layout may not be ready on first paint; never leave a column empty.
            if (end === start && column.rows.length > start) {
                end = Math.min(column.rows.length, start + 6);
            }
            const previous = state.ranges.get(column.key);
            if (!force && previous && previous[0] === start && previous[1] === end) continue;
            state.ranges.set(column.key, [start, end]);
            let topSpace = 0;
            for (let i = 0; i < start; i += 1) topSpace += galleryHeightAt(heights, i);
            let bottomSpace = 0;
            for (let i = end; i < column.rows.length; i += 1) bottomSpace += galleryHeightAt(heights, i);
            column.windowEl.style.paddingTop = `${topSpace}px`;
            column.windowEl.style.paddingBottom = `${bottomSpace}px`;
            column.windowEl.innerHTML = column.rows.slice(start, end).map(state.cardHtml).join("");
            const renderedCards = Array.from(column.windowEl.querySelectorAll<HTMLElement>(".pz-gallery-card"));
            renderedCards.forEach((element, offset) => {
                heights[start + offset] = element.offsetHeight;
            });
            state.heights.set(column.key, heights);
            // Recompute spacers with the freshly measured heights so the column does not jump.
            let measuredTop = 0;
            for (let i = 0; i < start; i += 1) measuredTop += galleryHeightAt(heights, i);
            let measuredBottom = 0;
            for (let i = end; i < column.rows.length; i += 1) measuredBottom += galleryHeightAt(heights, i);
            column.windowEl.style.paddingTop = `${measuredTop}px`;
            column.windowEl.style.paddingBottom = `${measuredBottom}px`;
        }
        hydrateGalleryCovers();
    };

    const scheduleGalleryVirtual = () => {
        if (galleryVirtualFrame) return;
        galleryVirtualFrame = requestAnimationFrame(() => {
            galleryVirtualFrame = 0;
            updateGalleryVirtual();
        });
    };

    const openGalleryRow = (row: MatrixRow): void => {
        if (row.id.startsWith("zlib:")) void host.openZoteroItem(row.itemKey);
        else openMatrixRow(host, project, row);
    };

    const galleryCoverRefFor = (row: MatrixRow): string => {
        const attachment = attachmentForZoteroItem(host.store, row.itemKey);
        return attachment ? `att:${attachment.id}` : `zot:${row.itemKey}`;
    };

    const toggleGallerySelection = (rowId: string): void => {
        if (gallerySelected.has(rowId)) gallerySelected.delete(rowId);
        else gallerySelected.add(rowId);
        for (const cardEl of Array.from(galleryRoot.querySelectorAll<HTMLElement>(`.pz-gallery-card[data-row-id="${CSS.escape(rowId)}"]`))) {
            cardEl.classList.toggle("is-selected", gallerySelected.has(rowId));
        }
    };

    const openGalleryCropDialog = (row: MatrixRow): void => {
        const ref = galleryCoverRefFor(row);
        const holder = galleryRoot.querySelector<HTMLElement>(`[data-cover-ref="${CSS.escape(ref)}"]`);
        const source = holder?.querySelector<HTMLImageElement>("img")?.src || galleryCovers.get(ref) || "";
        if (!source) {
            showMessage("封面还没生成，等它出现后再调整", 2500);
            return;
        }
        let value = readGalleryCrop(row.itemKey);
        const dialog = new Dialog({
            title: "封面位置",
            width: "420px",
            content: `<div class="b3-dialog__content">
  <div class="pz-gallery-crop-preview"><img src="${source}" style="object-position:center ${value}%" /></div>
  <div class="fn__flex" style="align-items:center;gap:8px;margin-top:8px"><span class="pz-muted">上移</span><input type="range" min="0" max="100" value="${value}" data-crop-range style="flex:1" /><span class="pz-muted">下移</span></div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--text" data-act="crop-done">完成</button></div>`,
        });
        const range = dialog.element.querySelector<HTMLInputElement>("[data-crop-range]")!;
        const preview = dialog.element.querySelector<HTMLImageElement>(".pz-gallery-crop-preview img")!;
        const apply = () => {
            value = Number(range.value) || 0;
            preview.style.objectPosition = `center ${value}%`;
            writeGalleryCrop(row.itemKey, value);
            for (const target of Array.from(galleryRoot.querySelectorAll<HTMLElement>(`[data-item-key="${CSS.escape(row.itemKey)}"] img`))) {
                target.style.objectPosition = `center ${value}%`;
            }
        };
        range.addEventListener("input", apply);
        dialog.element.querySelector('[data-act="crop-done"]')?.addEventListener("click", () => dialog.destroy());
    };

    const renderItemsGallery = (rows: MatrixRow[]) => {
        const zoteroItems = new Map(host.store.state.zotero.items.map(item => [item.key, item]));
        const attachmentsByKey = new Map<string, string>();
        for (const attachment of Object.values(host.store.state.attachments)) {
            const key = attachment.zotero?.itemKey;
            if (key && !attachmentsByKey.has(key)) attachmentsByKey.set(key, attachment.id);
        }
        const statuses: Array<{value: "" | ReadingStatus; label: string}> = [
            {value: "", label: "全部"},
            {value: "unread", label: "未读"},
            {value: "reading", label: "在读"},
            {value: "done", label: "已读"},
        ];
        galleryStatusBar.innerHTML = statuses.map(item => `<button class="pz-gallery-status-btn${galleryStatusFilter === item.value ? " is-active" : ""}" data-gallery-status="${item.value}">${item.label}</button>`).join("");
        for (const button of Array.from(galleryStatusBar.querySelectorAll<HTMLElement>("[data-gallery-status]"))) {
            button.addEventListener("click", () => {
                galleryStatusFilter = (button.dataset.galleryStatus || "") as "" | ReadingStatus;
                renderGallery();
            });
        }
        galleryGroupSelect.innerHTML = GALLERY_GROUP_OPTIONS.map(option => `<option value="${option.value}" ${gallerySettings.groupBy === option.value ? "selected" : ""}>按${option.label}分列</option>`).join("");

        const groups = new Map<string, {label: string; rows: MatrixRow[]}>();
        for (const row of gallerySortedRows(rows)) {
            const attachmentId = attachmentsByKey.get(row.itemKey) || "";
            const status = attachmentId ? statusForStat(host.store, host.store.readingStat(attachmentId)) : "unread";
            if (galleryStatusFilter && status !== galleryStatusFilter) continue;
            const group = galleryGroupFor(row, zoteroItems);
            const entry = groups.get(group.key) || {label: group.label, rows: []};
            entry.rows.push(row);
            groups.set(group.key, entry);
        }
        const ordered = [...groups.entries()].sort((a, b) => {
            if (a[0] === "未填写") return 1;
            if (b[0] === "未填写") return -1;
            if (gallerySettings.groupBy === "itemType") {
                const order = ["conferencePaper", "journalArticle", "preprint", "thesis", "bookSection", "book", "report", "webpage", "patent", "document", "computerProgram"];
                const left = order.indexOf(a[0]);
                const right = order.indexOf(b[0]);
                return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
            }
            return b[1].rows.length - a[1].rows.length;
        });
        const shown = ordered.reduce((sum, [, group]) => sum + group.rows.length, 0);
        galleryCount.textContent = `${gallerySettings.scope === "library" ? "全库" : "矩阵"} · ${ordered.length} 组 · ${shown} 篇`;

        const card = (row: MatrixRow): string => {
            const attachmentId = attachmentsByKey.get(row.itemKey) || "";
            const item = zoteroItems.get(row.itemKey);
            const meta = host.store.itemMeta(row.itemKey);
            const coverRef = gallerySettings.covers ? (attachmentId ? `att:${attachmentId}` : `zot:${row.itemKey}`) : "";
            const authors = String(row.values.authors || "").split(";").filter(Boolean).slice(0, 2).join(", ");
            const tags = row.id.startsWith("zlib:") ? [] : matrixRowTags(project, row);
            const horizontal = gallerySettings.layout === "horizontal";
            return `<article class="pz-gallery-card${horizontal ? " is-horizontal" : ""}${gallerySelected.has(row.id) ? " is-selected" : ""}" tabindex="0" data-row-id="${escapeHtml(row.id)}">
  <div class="pz-gallery-cover${coverRef ? " is-loading" : " is-off"}"${coverRef ? ` data-cover-ref="${escapeHtml(coverRef)}" data-item-key="${escapeHtml(row.itemKey)}"` : ""}><span class="pz-gallery-cover-fallback">${coverRef ? "" : "封面已关闭"}</span></div>
  <div class="pz-gallery-info">
    <div class="pz-gallery-title"><span class="pz-gallery-kind">${galleryKindIcon(item?.itemType || "")}</span>${escapeHtml(rowTitle(row))}</div>
    ${authors ? `<div class="pz-gallery-line">👤 ${escapeHtml(authors)}</div>` : ""}
    ${row.values.year ? `<div class="pz-gallery-line">📅 ${escapeHtml(String(row.values.year))}</div>` : ""}
    ${row.values.venue ? `<div class="pz-gallery-line">🏛 ${escapeHtml(String(row.values.venue))}</div>` : ""}
    ${tags.length ? `<div class="pz-gallery-tags"><i class="pz-gallery-tagicon">🏷</i>${tags.slice(0, 3).map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}${tags.length > 3 ? `<span class="is-more">+${tags.length - 3}</span>` : ""}</div>` : ""}
    ${meta?.remark ? `<div class="pz-gallery-remark">${escapeHtml(meta.remark)}</div>` : ""}
  </div>
</article>`;
        };

        galleryRoot.innerHTML = `<div class="pz-gallery-columns">${ordered.map(([key, group], index) => `<section class="pz-gallery-group is-c${(index % 7) + 1}" data-gallery-group-key="${escapeHtml(key)}">
  <header class="pz-gallery-group-head"><span>${escapeHtml(group.label)}</span><em>${group.rows.length}</em></header>
  <div class="pz-gallery-window" data-gallery-window="${escapeHtml(key)}"></div>
</section>`).join("")}${ordered.length ? "" : `<div class="pz-muted" style="padding:24px">没有匹配的文献</div>`}</div>`;
        const columns: GalleryVirtualColumn[] = [];
        for (const [key, group] of ordered) {
            const el = galleryRoot.querySelector<HTMLElement>(`[data-gallery-group-key="${CSS.escape(key)}"]`);
            const windowEl = el?.querySelector<HTMLElement>("[data-gallery-window]");
            if (!el || !windowEl) continue;
            columns.push({key, rows: group.rows, el, windowEl});
        }
        galleryVirtual = {
            columns,
            heights: new Map(),
            ranges: new Map(),
            rowsById: new Map(rows.map(row => [row.id, row])),
            cardHtml: card,
        };
        galleryRoot.scrollTop = galleryScroll.top;
        galleryRoot.scrollLeft = galleryScroll.left;
        // First paint often measures 0 while the dialog is still laying out; retry next frames.
        requestAnimationFrame(() => {
            updateGalleryVirtual(true);
            requestAnimationFrame(() => updateGalleryVirtual(true));
        });
    };

    const renderAnnotationsGallery = (rows: MatrixRow[]) => {
        const attachmentIds = new Map<string, string>();
        for (const row of rows) {
            const attachment = attachmentForZoteroItem(host.store, row.itemKey);
            if (attachment) attachmentIds.set(attachment.id, rowTitle(row));
        }
        const colors = new Map<string, string>();
        const annotations = Object.values(host.store.state.annotations).filter(annotation => {
            if (!attachmentIds.has(annotation.attachmentId)) return false;
            colors.set(annotation.color, annotation.color);
            return !gallerySettings.colorFilter || annotation.color === gallerySettings.colorFilter;
        }).sort((a, b) => b.createdAt - a.createdAt);
        setGalleryTabCount("annotations", annotations.length);
        const visibleAnnotations = annotations.slice(0, 150);
        const colorChips = `<button class="pz-gallery-color is-all${gallerySettings.colorFilter ? "" : " is-active"}" data-gallery-color="">全部</button>` + Array.from(colors.keys()).map(color => `<button class="pz-gallery-color${gallerySettings.colorFilter === color ? " is-active" : ""}" data-gallery-color="${escapeHtml(color)}" style="--pz-dot:${escapeHtml(color)}"></button>`).join("");
        galleryStatusBar.innerHTML = colorChips;
        const cards = visibleAnnotations.map(annotation => `<article class="pz-gallery-card is-annotation" data-annotation-id="${escapeHtml(annotation.id)}" data-attachment-id="${escapeHtml(annotation.attachmentId)}" data-page="${annotation.page}">
  <div class="pz-gallery-ann-bar" style="background:${escapeHtml(annotation.color)}"></div>
  <div class="pz-gallery-ann-text">${escapeHtml(annotation.text || "(空标注)")}</div>
  ${annotation.translation ? `<div class="pz-gallery-ann-trans">${escapeHtml(annotation.translation)}</div>` : ""}
  <div class="pz-gallery-meta">第 ${annotation.page} 页 · ${escapeHtml(attachmentIds.get(annotation.attachmentId) || "")}</div>
</article>`).join("");
        galleryRoot.innerHTML = `<div class="pz-gallery-ann-grid">${cards || `<div class="pz-muted" style="padding:24px">当前范围没有标注</div>`}${annotations.length > visibleAnnotations.length ? `<div class="pz-muted" style="padding:8px">仅显示最近 ${visibleAnnotations.length} 条（共 ${annotations.length} 条）</div>` : ""}</div>`;
        for (const card of Array.from(galleryRoot.querySelectorAll<HTMLElement>(".pz-gallery-card.is-annotation"))) {
            card.addEventListener("dblclick", () => {
                const attachment = host.store.getAttachment(card.dataset.attachmentId || "");
                if (!attachment) return;
                host.openAttachment(attachment, Number(card.dataset.page) || 1, card.dataset.annotationId || "");
            });
        }
        for (const chip of Array.from(galleryRoot.parentElement!.querySelectorAll<HTMLElement>("[data-gallery-color]"))) {
            chip.addEventListener("click", () => {
                gallerySettings = {...gallerySettings, colorFilter: chip.dataset.galleryColor || ""};
                saveGalleryPrefs(gallerySettings);
                renderGallery();
            });
        }
    };

    const renderNotesGallery = (rows: MatrixRow[]) => {
        const itemKeys = new Set(rows.map(row => row.itemKey));
        const docs = new Map<string, string>();
        for (const link of Object.values(host.store.state.templateNotes)) {
            if (link.itemKey && itemKeys.has(link.itemKey) && link.docId) docs.set(link.docId, link.itemKey);
        }
        const attachmentIds = new Set<string>();
        for (const row of rows) {
            const attachment = attachmentForZoteroItem(host.store, row.itemKey);
            if (attachment) attachmentIds.add(attachment.id);
        }
        for (const link of Object.values(host.store.state.noteLinks)) {
            const annotation = host.store.getAnnotation(link.annotationId);
            if (annotation && attachmentIds.has(annotation.attachmentId) && link.siyuanDocId) {
                docs.set(link.siyuanDocId, annotation.attachmentId);
            }
        }
        galleryStatusBar.innerHTML = "";
        setGalleryTabCount("notes", docs.size);
        const docEntries = Array.from(docs.entries()).slice(0, 120);
        const cards = docEntries.map(([docId, source]) => `<article class="pz-gallery-card is-note" data-doc-id="${escapeHtml(docId)}">
  <div class="pz-gallery-note-icon">📝</div>
  <div class="pz-gallery-title" data-note-title="${escapeHtml(docId)}">${escapeHtml(noteTitles.get(docId) || "加载中…")}</div>
  <div class="pz-gallery-meta">${escapeHtml(source)}</div>
</article>`).join("");
        galleryRoot.innerHTML = `<div class="pz-gallery-note-grid">${cards || `<div class="pz-muted" style="padding:24px">当前范围没有笔记</div>`}${docs.size > docEntries.length ? `<div class="pz-muted" style="padding:8px">仅显示前 ${docEntries.length} 条（共 ${docs.size} 条）</div>` : ""}</div>`;
        for (const card of Array.from(galleryRoot.querySelectorAll<HTMLElement>(".pz-gallery-card.is-note"))) {
            card.addEventListener("dblclick", () => host.openDoc(card.dataset.docId || ""));
        }
        for (const titleEl of Array.from(galleryRoot.querySelectorAll<HTMLElement>("[data-note-title]"))) {
            const docId = titleEl.dataset.noteTitle || "";
            if (!docId || noteTitles.has(docId)) continue;
            void getBlockAttrs(docId).then(attrs => {
                const title = String((attrs as any)?.title || (attrs as any)?.name || docId);
                noteTitles.set(docId, title);
                titleEl.textContent = title;
            }).catch(() => {
                noteTitles.set(docId, docId);
                titleEl.textContent = docId;
            });
        }
    };

    /** Gallery source: whole Zotero library by default, or the current matrix rows. */
    const gallerySourceRows = (): MatrixRow[] => {
        if (gallerySettings.scope === "project") return filteredRows();
        const cache = host.store.state.zotero;
        const query = filter.value.trim().toLowerCase();
        const rows: MatrixRow[] = (cache.items || []).map(item => {
            const csl = (item.csl || {}) as Record<string, any>;
            return {
                id: `zlib:${item.key}`,
                libraryId: cache.libraryId || 0,
                itemKey: item.key,
                values: {
                    title: item.title || csl.title || "",
                    authors: (item.creators || []).join("; "),
                    year: item.year || "",
                    venue: csl["container-title"] || "",
                    doi: item.doi || csl.DOI || "",
                },
            };
        });
        if (!query) return rows;
        return rows.filter(row => Object.values(row.values).join(" ").toLowerCase().includes(query));
    };

    const setGalleryTabCount = (mode: GallerySettings["mode"], count: number) => {
        const button = dialog.element.querySelector<HTMLElement>(`[data-gallery-mode="${mode}"]`);
        if (!button) return;
        const label = mode === "items" ? "条目" : mode === "notes" ? "笔记" : "标注";
        button.textContent = `${label} ${count}`;
    };

    const renderGallery = () => {
        if (currentKind === "gallery") {
            galleryScroll = {top: galleryRoot.scrollTop, left: galleryRoot.scrollLeft};
        }
        for (const button of Array.from(dialog.element.querySelectorAll<HTMLElement>("[data-gallery-mode]"))) {
            button.classList.toggle("is-active", button.dataset.galleryMode === gallerySettings.mode);
        }
        galleryGroupSelect.hidden = gallerySettings.mode !== "items";
        galleryScopeSelect.value = gallerySettings.scope;
        const rows = gallerySourceRows();
        if (gallerySettings.mode === "notes") {
            galleryStatusBar.innerHTML = "";
            galleryCount.textContent = "";
            galleryVirtual = null;
            renderNotesGallery(rows);
            return;
        }
        if (gallerySettings.mode === "annotations") {
            galleryCount.textContent = "";
            galleryVirtual = null;
            renderAnnotationsGallery(rows);
            return;
        }
        setGalleryTabCount("items", rows.length);
        renderItemsGallery(rows);
    };

    const openGallerySettings = () => {
        const columns = project.columns.filter(column => column.visible && column.id !== "title" && column.id !== "authors");
        const editor = new Dialog({
            title: "画廊显示设置",
            width: "520px",
            content: `<div class="b3-dialog__content">
  <div class="pz-muted" style="margin-bottom:10px">只影响画廊呈现，不改写文献字段。</div>
  <div style="margin-bottom:10px"><b>卡片字段</b><div class="pz-gallery-field-list">${columns.map(column => `<label><input type="checkbox" data-gallery-field="${escapeHtml(column.id)}" ${gallerySettings.fields.includes(column.id) ? "checked" : ""}/> ${escapeHtml(column.name)}</label>`).join("")}</div></div>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px"><input type="checkbox" data-gallery-setting="covers" ${gallerySettings.covers ? "checked" : ""}/> 显示封面（关闭后明显更流畅）</label>
  <div class="fn__flex" style="gap:12px;margin-bottom:10px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>排序</span><select class="b3-select" data-gallery-setting="sort"><option value="">不排序</option>${project.columns.filter(column => column.visible).map(column => `<option value="${escapeHtml(column.id)}" ${gallerySettings.sortColumn === column.id ? "selected" : ""}>${escapeHtml(column.name)}</option>`).join("")}</select></label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>方向</span><select class="b3-select" data-gallery-setting="direction"><option value="desc" ${gallerySettings.sortDirection === "desc" ? "selected" : ""}>降序</option><option value="asc" ${gallerySettings.sortDirection === "asc" ? "selected" : ""}>升序</option></select></label>
  </div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="gallery-cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="gallery-save">保存</button></div>`,
        });
        editor.element.querySelector('[data-act="gallery-cancel"]')?.addEventListener("click", () => editor.destroy());
        editor.element.querySelector('[data-act="gallery-save"]')?.addEventListener("click", () => {
            const fields = Array.from(editor.element.querySelectorAll<HTMLInputElement>("[data-gallery-field]"))
                .filter(input => input.checked)
                .map(input => input.dataset.galleryField || "");
            const layout = gallerySettings.layout;
            const sortColumn = editor.element.querySelector<HTMLSelectElement>('[data-gallery-setting="sort"]')?.value || "";
            const sortDirection = (editor.element.querySelector<HTMLSelectElement>('[data-gallery-setting="direction"]')?.value || "desc") as GallerySettings["sortDirection"];
            const covers = Boolean(editor.element.querySelector<HTMLInputElement>('[data-gallery-setting="covers"]')?.checked);
            gallerySettings = {...gallerySettings, fields, layout, sortColumn, sortDirection, covers};
            saveGalleryPrefs(gallerySettings);
            editor.destroy();
            renderGallery();
        });
    };

    const renderPane = () => {
        const panes: Array<[MatrixViewKind, HTMLElement]> = [
            ["table", tablePane],
            ["kanban", kanbanPane],
            ["gallery", galleryPane],
            ["canvas", canvasPane],
        ];
        for (const [kind, pane] of panes) {
            pane.hidden = currentKind !== kind;
            const tab = dialog.element.querySelector<HTMLElement>(`[data-matrix-kind="${kind}"]`);
            tab?.classList.toggle("is-active", currentKind === kind);
        }
        if (currentKind === "table") renderTable();
        else if (currentKind === "kanban") renderKanban();
        else if (currentKind === "gallery") renderGallery();
        else renderCanvas();
    };
    const render = () => {
        syncReadingValues(host.store, project);
        updateStatus();
        renderPane();
    };

    const openAddColumnDialog = () => {
        const editor = new Dialog({
            title: "添加字段",
            width: "560px",
            content: `<div class="b3-dialog__content">
  <div class="pz-muted" style="margin-bottom:10px">字段属于当前矩阵项目，可随时调整显示与类型。</div>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>字段名</span><input class="b3-text-field fn__block" data-field="name" placeholder="例如：研究主题" /></label>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>类型</span><select class="b3-select fn__block" data-field="type"><option value="text">文本</option><option value="longtext">长文本</option><option value="number">数字</option><option value="rating">评分</option><option value="date">日期</option><option value="select">单选</option><option value="multiselect">多选</option><option value="checkbox">复选框</option><option value="url">URL / DOI</option><option value="relation">关联行</option><option value="formula">公式 / 汇总</option></select></label>
    <label style="display:flex;align-items:center;gap:5px;padding-top:22px"><input type="checkbox" data-field="visible" checked /> 显示</label>
  </div>
  <label class="fn__flex" data-row="options" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>选项（逗号分隔）</span><input class="b3-text-field fn__block" data-field="options" placeholder="选项 A, 选项 B" /></label>
  <div class="fn__flex" data-row="formula" style="gap:8px;margin-bottom:8px" hidden>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>汇总方式</span><select class="b3-select fn__block" data-field="formula-op"><option value="count">计数</option><option value="sum">求和</option><option value="avg">平均</option><option value="min">最小值</option><option value="max">最大值</option></select></label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>来源字段</span><select class="b3-select fn__block" data-field="formula-source"><option value="">不指定（计数用）</option>${project.columns.filter(column => column.type === "number" || column.type === "rating").map(column => `<option value="${column.id}">${escapeHtml(column.name)}</option>`).join("")}</select></label>
  </div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="save">添加字段</button></div>`,
        });
        const name = editor.element.querySelector<HTMLInputElement>('[data-field="name"]')!;
        const type = editor.element.querySelector<HTMLSelectElement>('[data-field="type"]')!;
        const options = editor.element.querySelector<HTMLInputElement>('[data-field="options"]')!;
        const visible = editor.element.querySelector<HTMLInputElement>('[data-field="visible"]')!;
        const formulaRow = editor.element.querySelector<HTMLElement>('[data-row="formula"]')!;
        const optionsRow = editor.element.querySelector<HTMLElement>('[data-row="options"]')!;
        const formulaOp = editor.element.querySelector<HTMLSelectElement>('[data-field="formula-op"]')!;
        const formulaSource = editor.element.querySelector<HTMLSelectElement>('[data-field="formula-source"]')!;
        const sync = () => {
            formulaRow.hidden = type.value !== "formula";
            optionsRow.hidden = type.value !== "select" && type.value !== "multiselect";
        };
        type.addEventListener("change", sync);
        sync();
        editor.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => editor.destroy());
        editor.element.querySelector('[data-act="save"]')?.addEventListener("click", async () => {
            if (!name.value.trim()) { showMessage("请填写字段名", 2000); return; }
            const columnType = type.value as MatrixColumn["type"];
            const formula = columnType === "formula" ? `${formulaOp.value}${formulaSource.value ? `:${formulaSource.value}` : ""}` : undefined;
            project.columns.push({
                id: newId("mxcol"),
                name: name.value.trim(),
                type: columnType,
                options: columnType === "select" || columnType === "multiselect" ? options.value.split(",").map(item => item.trim()).filter(Boolean) : undefined,
                formula,
                visible: visible.checked,
                system: false,
                source: "custom",
                width: columnType === "longtext" ? 220 : 140,
            });
            project.updatedAt = Date.now();
            await host.store.save();
            editor.destroy();
            renderOptions();
            render();
        });
    };

    const openManageColumnsDialog = () => {        const editor = new Dialog({
            title: "字段管理",
            width: "760px",
            content: `<div class="b3-dialog__content">
  <div class="pz-muted" style="margin-bottom:8px">系统字段的名称和类型只读；可隐藏字段或删除自定义字段。</div>
  <div class="pz-matrix-column-manager">
    ${project.columns.map(column => `<div class="pz-matrix-column-row" data-column-id="${column.id}">
      <input class="b3-text-field" data-col="name" value="${escapeHtml(column.name)}" ${column.system ? "readonly" : ""} />
      <select class="b3-select" data-col="type" ${column.system ? "disabled" : ""}>${["text", "longtext", "number", "rating", "date", "select", "multiselect", "checkbox", "url", "relation", "formula"].map(type => `<option value="${type}" ${column.type === type ? "selected" : ""}>${type}</option>`).join("")}</select>
      <input class="b3-text-field" data-col="options" value="${escapeHtml((column.options || []).join(", "))}" placeholder="选项" ${column.type === "select" || column.type === "multiselect" ? "" : "hidden"} />
      <label style="display:flex;align-items:center;gap:4px"><input type="checkbox" data-col="visible" ${column.visible ? "checked" : ""} /> 显示</label>
      ${column.source === "custom" ? `<label style="display:flex;align-items:center;gap:4px;color:var(--b3-theme-error)"><input type="checkbox" data-col="delete" /> 删除</label>` : `<span class="pz-muted">${column.source === "zotero" ? "系统" : "内置"}</span>`}
    </div>`).join("")}
  </div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="save">保存</button></div>`,
        });
        editor.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => editor.destroy());
        editor.element.querySelector('[data-act="save"]')?.addEventListener("click", async () => {
            const removed = new Set<string>();
            for (const row of Array.from(editor.element.querySelectorAll<HTMLElement>(".pz-matrix-column-row"))) {
                const column = project.columns.find(item => item.id === row.dataset.columnId);
                if (!column) continue;
                if ((row.querySelector<HTMLInputElement>('[data-col="delete"]')?.checked)) {
                    removed.add(column.id);
                    continue;
                }
                const name = row.querySelector<HTMLInputElement>('[data-col="name"]')?.value.trim();
                const type = row.querySelector<HTMLSelectElement>('[data-col="type"]')?.value as MatrixColumn["type"];
                const options = row.querySelector<HTMLInputElement>('[data-col="options"]')?.value || "";
                const visible = row.querySelector<HTMLInputElement>('[data-col="visible"]')?.checked ?? true;
                if (name) column.name = name;
                if (!column.system && type) column.type = type;
                column.visible = visible;
                if (!column.system && (type === "select" || type === "multiselect")) {
                    column.options = options.split(",").map(item => item.trim()).filter(Boolean);
                }
            }
            if (removed.size) {
                project.columns = project.columns.filter(column => !removed.has(column.id));
            }
            project.updatedAt = Date.now();
            await host.store.save();
            editor.destroy();
            renderOptions();
            render();
        });
    };

    const openFilterBuilder = () => {
        const editor = new Dialog({
            title: "多条件筛选",
            width: "720px",
            content: `<div class="b3-dialog__content">
  <div class="fn__flex" style="align-items:center;gap:8px;margin-bottom:10px"><span>条件之间</span><select class="b3-select" data-field="logic"><option value="and">全部满足（AND）</option><option value="or">任一满足（OR）</option></select><span class="fn__space"></span><button class="b3-button b3-button--outline" data-act="add-condition">添加条件</button></div>
  <div class="pz-matrix-filter-list" data-role="conditions"></div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="save">应用</button></div>`,
        });
        const list = editor.element.querySelector<HTMLElement>('[data-role="conditions"]')!;
        const logic = editor.element.querySelector<HTMLSelectElement>('[data-field="logic"]')!;
        logic.value = currentFilterLogic;
        const options = project.columns.filter(column => column.visible);
        const conditionHtml = (condition: MatrixFilterCondition) => `<div class="pz-matrix-filter-row" data-condition-id="${condition.id}">
          <select class="b3-select" data-f="column">${options.map(column => `<option value="${column.id}" ${condition.columnId === column.id ? "selected" : ""}>${escapeHtml(column.name)}</option>`).join("")}</select>
          <select class="b3-select" data-f="op">${[["contains", "包含"], ["equals", "等于"], ["not-empty", "非空"], ["gt", "大于"], ["lt", "小于"]].map(([value, label]) => `<option value="${value}" ${condition.operator === value ? "selected" : ""}>${label}</option>`).join("")}</select>
          <input class="b3-text-field" data-f="value" value="${escapeHtml(condition.value)}" placeholder="值" />
          <button class="b3-button b3-button--outline" data-act="remove-condition">删除</button>
        </div>`;
        const renderConditions = () => {
            if (!workingFilters.length) workingFilters = [{id: newId("mxfilter"), columnId: options[0]?.id || "", operator: "contains", value: ""}];
            list.innerHTML = workingFilters.map(conditionHtml).join("");
            for (const button of Array.from(list.querySelectorAll<HTMLElement>('[data-act="remove-condition"]'))) {
                button.addEventListener("click", () => {
                    workingFilters = workingFilters.filter(condition => condition.id !== button.closest<HTMLElement>("[data-condition-id]")?.dataset.conditionId);
                    renderConditions();
                });
            }
        };
        editor.element.querySelector('[data-act="add-condition"]')?.addEventListener("click", () => {
            workingFilters.push({id: newId("mxfilter"), columnId: options[0]?.id || "", operator: "contains", value: ""});
            renderConditions();
        });
        renderConditions();
        editor.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => editor.destroy());
        editor.element.querySelector('[data-act="save"]')?.addEventListener("click", () => {
            currentFilterLogic = logic.value === "or" ? "or" : "and";
            workingFilters = Array.from(list.querySelectorAll<HTMLElement>("[data-condition-id]")).map(row => ({
                id: row.dataset.conditionId || newId("mxfilter"),
                columnId: row.querySelector<HTMLSelectElement>('[data-f="column"]')?.value || "",
                operator: (row.querySelector<HTMLSelectElement>('[data-f="op"]')?.value || "contains") as MatrixFilterCondition["operator"],
                value: row.querySelector<HTMLInputElement>('[data-f="value"]')?.value || "",
            })).filter(condition => condition.columnId);
            editor.destroy();
            render();
        });
    };

    const openSchemaPreview = (suggestions = suggestMatrixSchema(project)) => {
        if (!suggestions.length) {
            showMessage("当前字段类型没有需要调整的建议", 2500);
            return;
        }
        const editor = new Dialog({
            title: "字段类型建议",
            width: "700px",
            content: `<div class="b3-dialog__content">
  <div class="pz-muted" style="margin-bottom:10px">根据字段名和现有数据推断；勾选后应用，不会删除已有值。</div>
  <div class="pz-matrix-schema-suggest">
    ${suggestions.map((item, index) => `<label class="pz-matrix-schema-row"><input type="checkbox" data-schema-index="${index}" checked /><span>${escapeHtml(item.name)}</span><span class="pz-muted">${escapeHtml(item.currentType)}</span><span>→</span><select class="b3-select" data-schema-type="${index}">${["text", "longtext", "number", "rating", "date", "select", "multiselect", "checkbox", "url", "relation", "formula"].map(type => `<option value="${type}" ${item.suggestedType === type ? "selected" : ""}>${type}</option>`).join("")}</select></label>`).join("")}
  </div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="cancel">暂不处理</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="save">应用建议</button></div>`,
        });
        editor.element.querySelector('[data-act="cancel"]')?.addEventListener("click", async () => {
            project.schemaReviewed = true;
            await host.store.save();
            editor.destroy();
        });
        editor.element.querySelector('[data-act="save"]')?.addEventListener("click", async () => {
            for (const [index, item] of suggestions.entries()) {
                const checkbox = editor.element.querySelector<HTMLInputElement>(`[data-schema-index="${index}"]`);
                if (!checkbox?.checked) continue;
                const column = project.columns.find(entry => entry.id === item.columnId);
                if (!column) continue;
                const type = editor.element.querySelector<HTMLSelectElement>(`[data-schema-type="${index}"]`)?.value as MatrixColumn["type"] | undefined;
                if (type) column.type = type;
                if (column.type === "select" && !column.options?.length) column.options = item.options || ["未读", "在读", "已读", "已摘录"];
            }
            project.schemaReviewed = true;
            project.updatedAt = Date.now();
            await host.store.save();
            editor.destroy();
            renderOptions();
            render();
        });
    };

    renderProjects();
    renderViewSelect();
    renderOptions();
    render();

    projectSelect.addEventListener("change", () => {
        project = host.store.state.matrixProjects.find(item => item.id === projectSelect.value) || project;
        host.store.state.matrixActiveProjectId = project.id;
        currentViewId = "";
        workingView = null;
        currentFilterColumn = "";
        currentFilterOperator = "contains";
        currentFilterValue = "";
        workingFilters = [];
        currentFilterLogic = "and";
        selectedRows.clear();
        galleryStatusFilter = "";
        void host.store.save();
        renderProjects();
        renderViewSelect();
        renderOptions();
        render();
    });
    for (const tab of Array.from(dialog.element.querySelectorAll<HTMLElement>("[data-matrix-kind]"))) {
        tab.addEventListener("click", () => {
            const kind = tab.dataset.matrixKind;
            currentKind = (kind === "kanban" || kind === "canvas" || kind === "gallery" ? kind : "table") as MatrixViewKind;
            currentViewId = "";
            workingView = null;
            renderViewSelect();
            renderPane();
        });
    }
    for (const button of Array.from(dialog.element.querySelectorAll<HTMLElement>("[data-gallery-mode]"))) {
        button.addEventListener("click", () => {
            gallerySettings = {...gallerySettings, mode: (button.dataset.galleryMode as GallerySettings["mode"]) || "items"};
            saveGalleryPrefs(gallerySettings);
            renderGallery();
        });
    }
    galleryGroupSelect.addEventListener("change", () => {
        gallerySettings = {...gallerySettings, groupBy: galleryGroupSelect.value as GallerySettings["groupBy"]};
        saveGalleryPrefs(gallerySettings);
        renderGallery();
    });
    galleryScopeSelect.addEventListener("change", () => {
        gallerySettings = {...gallerySettings, scope: galleryScopeSelect.value === "project" ? "project" : "library"};
        saveGalleryPrefs(gallerySettings);
        renderGallery();
    });
    galleryRoot.addEventListener("scroll", () => scheduleGalleryVirtual(), {passive: true});
    if (typeof ResizeObserver !== "undefined") {
        const galleryResize = new ResizeObserver(() => {
            if (currentKind === "gallery") scheduleGalleryVirtual();
        });
        galleryResize.observe(galleryRoot);
    }
    galleryRoot.addEventListener("click", event => {
        const cardEl = (event.target as HTMLElement).closest<HTMLElement>(".pz-gallery-card[data-row-id]");
        if (!cardEl || !galleryVirtual) return;
        const row = galleryVirtual.rowsById.get(cardEl.dataset.rowId || "");
        if (!row) return;
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            toggleGallerySelection(row.id);
            return;
        }
        openGalleryRow(row);
    });
    galleryRoot.addEventListener("dblclick", event => {
        const cardEl = (event.target as HTMLElement).closest<HTMLElement>(".pz-gallery-card[data-row-id]");
        if (!cardEl || !galleryVirtual) return;
        const row = galleryVirtual.rowsById.get(cardEl.dataset.rowId || "");
        if (!row) return;
        if (row.id.startsWith("zlib:")) {
            void host.openZoteroItem(row.itemKey);
            return;
        }
        const attachment = attachmentForZoteroItem(host.store, row.itemKey);
        if (attachment) host.openAttachment(attachment);
    });
    const handleGalleryContextMenu = (event: MouseEvent): void => {
        const target = event.target as Node | null;
        if (!target || !galleryRoot.contains(target)) return;
        if (currentKind !== "gallery" || !galleryRoot.isConnected) return;
        if (Date.now() - galleryMenuOpenedAt < 250) return;
        galleryMenuOpenedAt = Date.now();
        event.preventDefault();
        event.stopPropagation();
        const cardEl = (event.target as HTMLElement).closest<HTMLElement>(".pz-gallery-card[data-row-id]");
        if (cardEl && galleryVirtual) {
            const row = galleryVirtual.rowsById.get(cardEl.dataset.rowId || "");
            if (!row) return;
            const ref = galleryCoverRefFor(row);
            const hasCover = Boolean(galleryCovers.get(ref)) || Boolean(galleryRoot.querySelector(`[data-cover-ref="${CSS.escape(ref)}"] img`));
            showGalleryMenu(event.clientX, event.clientY, [
                {label: "打开原文", action: () => openGalleryRow(row)},
                {label: "在矩阵中打开", disabled: row.id.startsWith("zlib:"), action: () => openMatrixRow(host, project, row)},
                {label: "-"},
                {label: "调整封面位置…", disabled: !hasCover, action: () => openGalleryCropDialog(row)},
                {label: "恢复默认封面位置", disabled: !readGalleryCrop(row.itemKey), action: () => {
                    writeGalleryCrop(row.itemKey, 0);
                    renderGallery();
                }},
                {label: "-"},
                {label: "复制", children: [
                    {label: "复制标题", action: () => void copyToClipboard(rowTitle(row), "标题")},
                    {label: "复制 DOI", disabled: !row.values.doi, action: () => void copyToClipboard(String(row.values.doi || ""), " DOI")},
                    {label: "复制作者", disabled: !row.values.authors, action: () => void copyToClipboard(String(row.values.authors || ""), "作者")},
                    {label: "复制 BibTeX", action: () => void copyToClipboard(rowBibtex(row), " BibTeX")},
                ]},
            ]);
            return;
        }
        const groupEl = (event.target as HTMLElement).closest<HTMLElement>(".pz-gallery-group");
        if (!groupEl) return;
        showGalleryMenu(event.clientX, event.clientY, [
            ...GALLERY_GROUP_OPTIONS.map(option => ({
                label: `按${option.label}分列`,
                checked: gallerySettings.groupBy === option.value,
                action: () => {
                    gallerySettings = {...gallerySettings, groupBy: option.value};
                    saveGalleryPrefs(gallerySettings);
                    renderGallery();
                },
            })),
            {label: "-"},
            {label: "竖向卡片", checked: gallerySettings.layout !== "horizontal", action: () => {
                gallerySettings = {...gallerySettings, layout: "vertical"};
                saveGalleryPrefs(gallerySettings);
                renderGallery();
            }},
            {label: "横向卡片", checked: gallerySettings.layout === "horizontal", action: () => {
                gallerySettings = {...gallerySettings, layout: "horizontal"};
                saveGalleryPrefs(gallerySettings);
                renderGallery();
            }},
            {label: "-"},
            {label: gallerySettings.covers ? "隐藏封面" : "显示封面", action: () => {
                gallerySettings = {...gallerySettings, covers: !gallerySettings.covers};
                saveGalleryPrefs(gallerySettings);
                renderGallery();
            }},
            {label: "-"},
            {label: "按年份降序", checked: gallerySettings.sortColumn === "year" && gallerySettings.sortDirection === "desc", action: () => {
                gallerySettings = {...gallerySettings, sortColumn: "year", sortDirection: "desc"};
                saveGalleryPrefs(gallerySettings);
                renderGallery();
            }},
            {label: "按标题升序", checked: gallerySettings.sortColumn === "title" && gallerySettings.sortDirection === "asc", action: () => {
                gallerySettings = {...gallerySettings, sortColumn: "title", sortDirection: "asc"};
                saveGalleryPrefs(gallerySettings);
                renderGallery();
            }},
        ]);
    };
    window.addEventListener("contextmenu", handleGalleryContextMenu, true);
    window.addEventListener("mousedown", event => {
        if (event.button === 2) handleGalleryContextMenu(event);
    }, true);
    galleryRoot.addEventListener("keydown", event => {
        if (currentKind !== "gallery" || !galleryVirtual) return;
        const cards = Array.from(galleryRoot.querySelectorAll<HTMLElement>(".pz-gallery-card[data-row-id]"));
        if (!cards.length) return;
        const current = cards.indexOf(document.activeElement as HTMLElement);
        const focusAt = (index: number) => {
            const target = cards[Math.max(0, Math.min(cards.length - 1, index))];
            target?.focus();
        };
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            event.preventDefault();
            focusAt(current < 0 ? 0 : current + 1);
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            event.preventDefault();
            focusAt(current < 0 ? 0 : current - 1);
        } else if (event.key === "Enter" && current >= 0) {
            event.preventDefault();
            const row = galleryVirtual.rowsById.get(cards[current].dataset.rowId || "");
            if (row) openGalleryRow(row);
        } else if (event.key === " " && current >= 0) {
            event.preventDefault();
            const id = cards[current].dataset.rowId || "";
            if (id) toggleGallerySelection(id);
        } else if (event.key === "Escape") {
            dialog.destroy();
        }
    });
    dialog.element.querySelector('[data-act="gallery-settings"]')?.addEventListener("click", () => openGallerySettings());
    filter.addEventListener("input", () => {
        renderTable();
        if (currentKind === "kanban") renderKanban();
        else if (currentKind === "canvas") renderCanvas();
        else if (currentKind === "gallery") renderGallery();
    });
    sortColumn.addEventListener("change", () => { currentSortColumn = sortColumn.value; render(); });
    sortDirection.addEventListener("change", () => { currentSortDirection = sortDirection.value === "desc" ? "desc" : "asc"; render(); });
    groupColumn.addEventListener("change", () => { currentGroupColumn = groupColumn.value; render(); });
    filterColumn.addEventListener("change", () => { currentFilterColumn = filterColumn.value; render(); });
    filterOp.addEventListener("change", () => { currentFilterOperator = filterOp.value as typeof currentFilterOperator; render(); });
    filterValue.addEventListener("input", () => { currentFilterValue = filterValue.value; render(); });
    dialog.element.querySelector('[data-act="filter-clear"]')?.addEventListener("click", () => {
        currentFilterColumn = "";
        currentFilterOperator = "contains";
        currentFilterValue = "";
        workingFilters = [];
        currentFilterLogic = "and";
        filter.value = "";
        renderOptions();
        render();
    });
    viewSelect.addEventListener("change", () => {
        currentViewId = viewSelect.value;
        workingView = null;
        const view = activeView();
        if (!view) { render(); return; }
        currentKind = viewKind(view);
        filter.value = view.filter;
        currentSortColumn = view.sortColumn;
        currentSortDirection = view.sortDirection;
        currentGroupColumn = view.groupColumn || "";
        currentFilterColumn = view.filterColumn || "";
        currentFilterOperator = view.filterOperator || "contains";
        currentFilterValue = view.filterValue || "";
        workingFilters = view.filters ? view.filters.map(condition => ({...condition})) : [];
        currentFilterLogic = view.filterLogic === "or" ? "or" : "and";
        if (view.kind === "canvas" && view.canvas) {
            canvasZoom = view.canvas.zoom || 1;
            canvasPanX = view.canvas.panX || 0;
            canvasPanY = view.canvas.panY || 0;
        }
        renderOptions();
        render();
    });
    kanbanMode.addEventListener("change", () => {
        const view = ensureActiveView();
        view.kanbanMode = kanbanMode.value === "custom" ? "custom" : "field";
        project.updatedAt = Date.now();
        void host.store.save();
        renderKanban();
    });
    for (const select of [kanbanGroup1, kanbanGroup2, kanbanGroup3]) {
        select.addEventListener("change", () => {
            const view = ensureActiveView();
            view.groupColumns = [kanbanGroup1.value, kanbanGroup2.value, kanbanGroup3.value].filter(Boolean).slice(0, 3);
            project.updatedAt = Date.now();
            void host.store.save();
            renderKanban();
        });
    }
    showFilteredInput.addEventListener("change", () => {
        showFilteredNodes = showFilteredInput.checked;
        renderCanvas();
    });
    edgeFilterSelect.addEventListener("change", () => {
        edgeKindFilter = edgeFilterSelect.value as typeof edgeKindFilter;
        renderCanvas();
    });
    canvasRoot.addEventListener("keydown", event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            for (const node of canvasFor(ensureActiveView()).nodes) selectedNodeIds.add(node.id);
            for (const el of Array.from(canvasNodes.querySelectorAll<HTMLElement>(".pz-matrix-canvas-node"))) {
                el.classList.toggle("is-selected", selectedNodeIds.has(el.dataset.nodeId || ""));
            }
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
            const canvas = canvasFor(ensureActiveView());
            const nodes = canvas.nodes.filter(node => selectedNodeIds.has(node.id) && node.kind !== "row").map(node => ({...node}));
            if (!nodes.length) return;
            const ids = new Set(nodes.map(node => node.id));
            canvasClipboard = {nodes, edges: canvas.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)).map(edge => ({...edge}))};
            canvasHint.textContent = `已复制 ${nodes.length} 个节点`;
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
            if (!canvasClipboard) return;
            event.preventDefault();
            const canvas = canvasFor(ensureActiveView());
            pushCanvasHistory();
            const mapping = new Map<string, string>();
            selectedNodeIds.clear();
            for (const source of canvasClipboard.nodes) {
                const id = newId("mxnode");
                mapping.set(source.id, id);
                canvas.nodes.push({...source, id, x: source.x + 30, y: source.y + 30});
                selectedNodeIds.add(id);
            }
            for (const edge of canvasClipboard.edges) {
                if (!mapping.has(edge.from) || !mapping.has(edge.to)) continue;
                canvas.edges.push({...edge, id: newId("mxedge"), from: mapping.get(edge.from)!, to: mapping.get(edge.to)!});
            }
            project.updatedAt = Date.now();
            void host.store.save();
            renderCanvas();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
            event.preventDefault();
            restoreCanvasHistory(undoStack, redoStack);
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
            event.preventDefault();
            restoreCanvasHistory(redoStack, undoStack);
            return;
        }
        if (event.key === "Escape") {
            connectMode = false;
            connectFrom = "";
            selectedNodeIds.clear();
            canvasSelectedNode = "";
            canvasHint.textContent = "";
            renderCanvas();
            return;
        }
        if ((event.key === "Delete" || event.key === "Backspace") && selectedNodeIds.size) {
            const view = ensureActiveView();
            const canvas = canvasFor(view);
            const ids = new Set(Array.from(selectedNodeIds).filter(id => canvas.nodes.find(node => node.id === id && node.kind !== "row")));
            if (!ids.size) return;
            event.preventDefault();
            pushCanvasHistory();
            for (const node of canvas.nodes) {
                if (ids.has(node.id) && node.thumbnailPath) void removeThumbnailCache(node.thumbnailPath);
            }
            canvas.nodes = canvas.nodes.filter(item => !ids.has(item.id));
            canvas.edges = canvas.edges.filter(edge => !ids.has(edge.from) && !ids.has(edge.to));
            selectedNodeIds.clear();
            canvasSelectedNode = "";
            project.updatedAt = Date.now();
            void host.store.save();
            renderCanvas();
        }
    });
    dialog.element.querySelector('[data-act="matrix-save-view"]')?.addEventListener("click", async () => {
        const name = window.prompt("视图名称", "我的视图");
        if (!name?.trim()) return;
        const view: MatrixView = {
            id: newId("mxview"),
            name: name.trim(),
            filter: filter.value,
            sortColumn: currentSortColumn,
            sortDirection: currentSortDirection,
            groupColumn: currentGroupColumn,
            filterColumn: currentFilterColumn,
            filterOperator: currentFilterOperator,
            filterValue: currentFilterValue,
            filters: workingFilters.map(condition => ({...condition})),
            filterLogic: currentFilterLogic,
            kind: currentKind,
            groupColumns: [kanbanGroup1.value, kanbanGroup2.value, kanbanGroup3.value].filter(Boolean).slice(0, 3),
            kanbanMode: kanbanMode.value === "custom" ? "custom" : "field",
        };
        const source = activeView() || workingView;
        view.customColumns = source?.customColumns ? [...source.customColumns] : undefined;
        view.customColumnByRow = source?.customColumnByRow ? {...source.customColumnByRow} : undefined;
        if (currentKind === "canvas") {
            view.canvas = source?.canvas ? JSON.parse(JSON.stringify(source.canvas)) : {nodes: [], edges: []};
            ensureCanvasNodes(project, view);
        }
        project.views.push(view);
        currentViewId = view.id;
        workingView = null;
        project.updatedAt = Date.now();
        await host.store.save();
        renderViewSelect();
        showMessage("已保存视图", 2000);
    });
    dialog.element.querySelector('[data-act="matrix-rename-view"]')?.addEventListener("click", async () => {
        const view = activeView();
        if (!view) { showMessage("请先选择一个已保存视图", 2000); return; }
        const name = window.prompt("视图名称", view.name);
        if (!name?.trim()) return;
        view.name = name.trim();
        project.updatedAt = Date.now();
        await host.store.save();
        renderViewSelect();
    });
    dialog.element.querySelector('[data-act="matrix-delete-view"]')?.addEventListener("click", async () => {
        const view = activeView();
        if (!view) { showMessage("请先选择一个已保存视图", 2000); return; }
        project.views = project.views.filter(item => item.id !== view.id);
        currentViewId = "";
        project.updatedAt = Date.now();
        await host.store.save();
        renderViewSelect();
        render();
    });
    dialog.element.querySelector('[data-act="filter-builder"]')?.addEventListener("click", openFilterBuilder);
    dialog.element.querySelector('[data-act="matrix-batch-apply"]')?.addEventListener("click", async () => {
        if (!selectedRows.size) { showMessage("请先勾选要批量编辑的行", 2000); return; }
        const column = batchColumn.value;
        for (const row of project.rows) if (selectedRows.has(row.id)) row.values[column] = batchValue.value;
        project.updatedAt = Date.now();
        await host.store.save();
        render();
    });
    dialog.element.querySelector('[data-act="matrix-ai"]')?.addEventListener("click", () => {
        if (!selectedRows.size) { showMessage("请先勾选要填充的行", 2000); return; }
        openMatrixAI(host, project, selectedRows);
    });
    dialog.element.querySelector('[data-act="matrix-new-project"]')?.addEventListener("click", () => {
        const name = window.prompt("项目名称", "新的研究项目");
        if (!name?.trim()) return;
        const next = createMatrixProject(name);
        host.store.state.matrixProjects.push(next);
        host.store.state.matrixActiveProjectId = next.id;
        project = next;
        currentViewId = "";
        workingView = null;
        currentFilterColumn = "";
        currentFilterOperator = "contains";
        currentFilterValue = "";
        void host.store.save();
        renderProjects();
        renderViewSelect();
        renderOptions();
        render();
    });
    dialog.element.querySelector('[data-act="matrix-import"]')?.addEventListener("click", () => {
        const collectionKey = collectionSelect.value;
        if (!collectionKey) { showMessage("请先选择 Collection", 2000); return; }
        const items = (host.store.state.zotero.items || []).filter(item => (item.collections || []).includes(collectionKey));
        const existing = new Set(project.rows.map(row => row.itemKey));
        let added = 0;
        for (const item of items) {
            if (existing.has(item.key)) continue;
            project.rows.push(rowForZoteroItem(item, host.store.state.zotero.libraryId || 0));
            existing.add(item.key);
            added++;
        }
        if (!project.collectionKeys.includes(collectionKey)) project.collectionKeys.push(collectionKey);
        project.updatedAt = Date.now();
        void host.store.save();
        renderOptions();
        render();
        showMessage(`已加入 ${added} 篇文献`, 2000);
    });
    dialog.element.querySelector('[data-act="matrix-add-column"]')?.addEventListener("click", openAddColumnDialog);
    dialog.element.querySelector('[data-act="matrix-manage-columns"]')?.addEventListener("click", openManageColumnsDialog);
    dialog.element.querySelector('[data-act="matrix-schema-suggest"]')?.addEventListener("click", () => openSchemaPreview());
    dialog.element.querySelector('[data-act="matrix-export-csv"]')?.addEventListener("click", () => {
        const columns = project.columns.filter(column => column.visible);
        const csv = [columns.map(column => column.name), ...project.rows.map(row => columns.map(column => String(row.values[column.id] ?? "")))].map(line => line.map(value => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n");
        downloadText(`${project.name}.csv`, csv);
    });
    dialog.element.querySelector('[data-act="matrix-export-siyuan"]')?.addEventListener("click", async () => {
        const editor = getActiveEditor() || getAllEditor()[0];
        const notebookId = String(editor?.protyle?.notebookId || "");
        if (!notebookId) { showMessage("请先打开一个思源文档，以确定导出笔记本", 2500, "error"); return; }
        const columns = project.columns.filter(column => column.visible);
        const escapeCell = (value: unknown) => String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
        const lines = [`| ${columns.map(column => escapeCell(column.name)).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...project.rows.map(row => `| ${columns.map(column => escapeCell(row.values[column.id])).join(" | ")} |`)];
        const safeName = project.name.replace(/[\\/:*?"<>|]/g, "_");
        const docId = await createDocWithMd(notebookId, `/${safeName}-${new Date().toISOString().slice(0, 10)}-矩阵`, lines.join("\n"));
        if (docId) showMessage("已导出 SiYuan 表格", 2500);
    });
    dialog.element.querySelector('[data-act="kanban-edit-columns"]')?.addEventListener("click", () => {
        const view = ensureActiveView();
        const raw = window.prompt("自定义列，用逗号分隔", (view.customColumns || ["待读", "精读", "已用"]).join(","));
        if (!raw?.trim()) return;
        view.customColumns = raw.split(",").map(item => item.trim()).filter(Boolean);
        view.customColumnByRow = view.customColumnByRow || {};
        project.updatedAt = Date.now();
        void host.store.save();
        renderKanban();
    });
    const canvasView = () => ensureActiveView();
    dialog.element.querySelector('[data-act="canvas-auto-layout"]')?.addEventListener("click", () => {
        const view = canvasView();
        pushCanvasHistory();
        autoLayoutCanvas(project, view);
        project.updatedAt = Date.now();
        void host.store.save();
        renderCanvas();
    });
    dialog.element.querySelector('[data-act="canvas-undo"]')?.addEventListener("click", () => restoreCanvasHistory(undoStack, redoStack));
    dialog.element.querySelector('[data-act="canvas-redo"]')?.addEventListener("click", () => restoreCanvasHistory(redoStack, undoStack));
    dialog.element.querySelector('[data-act="canvas-fit"]')?.addEventListener("click", () => {
        canvasZoom = 1; canvasPanX = 0; canvasPanY = 0;
        const view = canvasView();
        const canvas = ensureCanvasNodes(project, view);
        canvas.zoom = 1; canvas.panX = 0; canvas.panY = 0;
        void host.store.save();
        renderCanvas();
    });
    dialog.element.querySelector('[data-act="canvas-edge-list"]')?.addEventListener("click", openEdgeList);
    dialog.element.querySelector('[data-act="canvas-batch-color"]')?.addEventListener("click", openBatchColorDialog);
    dialog.element.querySelector('[data-act="canvas-clean-thumbnails"]')?.addEventListener("click", async () => {
        if (!window.confirm("清理没有被任何画布节点引用的缩略图缓存？")) return;
        try {
            const removed = await cleanOrphanThumbnails(host);
            showMessage(`已清理 ${removed} 个缩略图缓存`, 2500);
        } catch {
            showMessage("缩略图缓存清理失败", 2500, "error");
        }
    });
    dialog.element.querySelector('[data-act="canvas-marquee"]')?.addEventListener("click", () => {
        marqueeMode = !marqueeMode;
        const button = dialog.element.querySelector<HTMLElement>('[data-act="canvas-marquee"]');
        button?.classList.toggle("is-active", marqueeMode);
        canvasHint.textContent = marqueeMode ? "框选模式：拖拽空白区域选择节点" : "";
    });
    dialog.element.querySelector('[data-act="canvas-connect"]')?.addEventListener("click", () => {
        connectFrom = "";
        connectMode = true;
        canvasHint.textContent = "连线模式：依次点击两个节点";
    });
    dialog.element.querySelector('[data-act="canvas-add-note"]')?.addEventListener("click", () => {
        const editor = getActiveEditor() || getAllEditor()[0];
        const block = editor?.protyle?.wysiwyg?.element?.querySelector<HTMLElement>(".protyle-wysiwyg--select, [data-node-id]");
        const blockId = String(block?.dataset.nodeId || editor?.protyle?.block?.rootID || "");
        const docId = String(editor?.protyle?.block?.rootID || "");
        const text = String(block?.innerText || editor?.protyle?.title || "笔记节点").trim().slice(0, 120);
        if (!docId) { showMessage("请先打开一个思源文档", 2200); return; }
        const view = canvasView();
        const canvas = ensureCanvasNodes(project, view);
        pushCanvasHistory();
        canvas.nodes.push({id: newId("mxnode"), kind: "note", docId, blockId, text, x: 80, y: 80, width: 240, height: 90});
        project.updatedAt = Date.now();
        void host.store.save();
        renderCanvas();
    });
    for (const [act, kind] of [["canvas-add-text", "text"], ["canvas-add-tag", "tag"], ["canvas-add-group", "group"], ["canvas-add-image", "image"], ["canvas-add-pdf", "pdf"]] as const) {
        dialog.element.querySelector(`[data-act="${act}"]`)?.addEventListener("click", () => {
            const view = canvasView();
            const canvas = ensureCanvasNodes(project, view);
            const text = kind === "pdf" ? window.prompt("输入要关联的文献标题关键字", "") : window.prompt(kind === "text" ? "文本内容" : kind === "tag" ? "标签名称" : kind === "group" ? "分组名称" : "图片地址", "");
            if (!text?.trim()) return;
            pushCanvasHistory();
            let rowId = "";
            if (kind === "pdf") {
                const row = project.rows.find(item => rowTitle(item).toLowerCase().includes(text.trim().toLowerCase()));
                if (!row) { showMessage("没有找到对应文献", 2000); return; }
                rowId = row.id;
            }
            canvas.nodes.push({id: newId("mxnode"), kind, rowId: rowId || undefined, text: text.trim(), x: kind === "group" ? 1100 : 80, y: kind === "group" ? 56 : 80, width: kind === "tag" ? 160 : kind === "group" ? 320 : 220, height: kind === "tag" ? 44 : kind === "group" ? 160 : 80});
            project.updatedAt = Date.now();
            void host.store.save();
            renderCanvas();
        });
    }
    dialog.element.querySelector('[data-act="matrix-close"]')?.addEventListener("click", () => dialog.destroy());
    window.setTimeout(() => {
        if (!project.schemaReviewed && suggestMatrixSchema(project).length) openSchemaPreview();
    }, 250);
    return dialog;
}
