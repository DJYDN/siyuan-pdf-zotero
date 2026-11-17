import {Dialog, showMessage} from "siyuan";
import {PLUGIN_DISPLAY_NAME, VERSION} from "../constants";
import type {PluginHost} from "../host";
import {fileExists, getPathForFile, hasNodeFs, requireNode, resolveZoteroAttachmentPath} from "../runtime";
import {citationStyleOptions, openCitationStylePicker} from "./style-picker";
import {TRANSLATION_SERVICE_TYPES, defaultTranslationServices} from "../translation/defaults";
import {TRANSLATION_TARGETS} from "../translation/service";
import {checkPdf2zhEnvironment, ensurePdf2zhServer, translationOutputDir} from "../translation/pdf2zh";
import {checkDoc2xEnvironment} from "../translation/doc2x";
import {checkOcrEngineEnvironment, checkOcrEnvironment, ensureOcrEngine, restartOcrEngine, stopOcrEngine} from "../ocr/service";
import {defaultFormulaOrder, engineConfig, isOcrEngineId, OCR_ENGINE_DEFS, OCR_ENGINE_IDS} from "../ocr/engines";
import {getOcrHealth} from "../ocr/client";
import type {OcrEngineConfig, OcrEngineId, OcrEngineMap, Settings} from "../types";
import {openOcrHistory} from "./ocr-history";
import {openMatrix} from "./matrix-workspace";
import {openTemplateManager} from "./template-manager";
import {createNoteFromTemplate} from "../template/notes";
import {syncTranslationHistory} from "../translation/history";
import {openDoc2xErrorLogDir, runDoc2xMarkdownAction, runDoc2xPdfAction, type Doc2xTarget} from "./doc2x-actions";
import {applyQaBlockTheme} from "../qa/theme";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch] as string));
}

async function pickDirectory(): Promise<string> {
    try {
        const remote = requireNode("@electron/remote");
        if (remote?.dialog?.showOpenDialog) {
            const result = await remote.dialog.showOpenDialog({properties: ["openDirectory", "createDirectory"]});
            if (!result.canceled && result.filePaths?.[0]) return result.filePaths[0];
            return "";
        }
    } catch {
        // fall through to the directory input
    }
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        (input as any).webkitdirectory = true;
        input.style.position = "fixed";
        input.style.left = "-10000px";
        document.body.append(input);
        let settled = false;
        const finish = (value: string) => {
            if (settled) return;
            settled = true;
            input.remove();
            resolve(value);
        };
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            const filePath = file ? getPathForFile(file) : "";
            if (!filePath) {
                finish("");
                return;
            }
            const path = requireNode("path");
            finish(path?.dirname?.(filePath) || "");
        });
        input.addEventListener("cancel", () => finish(""));
        input.click();
    });
}

interface DockMenuItem {
    label: string;
    action?: () => void | Promise<void>;
    disabled?: boolean;
    danger?: boolean;
    children?: DockMenuItem[];
}

function showDockContextMenu(x: number, y: number, items: DockMenuItem[]): void {
    document.querySelectorAll(".pz-dock-context-menu").forEach(node => node.remove());
    const menu = document.createElement("div");
    menu.className = "pz-dock-context-menu";
    const appendItems = (container: HTMLElement, entries: DockMenuItem[]) => {
        for (const item of entries) {
            const wrapper = document.createElement("div");
            wrapper.className = "pz-dock-context-entry";
            const button = document.createElement("button");
            button.textContent = item.label;
            button.disabled = Boolean(item.disabled);
            if (item.danger) button.classList.add("is-danger");
            if (item.children?.length) button.classList.add("has-submenu");
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                if (item.children?.length) {
                    wrapper.classList.toggle("is-open");
                    return;
                }
                menu.remove();
                if (item.disabled || !item.action) return;
                void Promise.resolve(item.action()).catch((error: any) => {
                    showMessage(`操作失败：${error?.message || String(error)}`, 5000, "error");
                });
            });
            wrapper.append(button);
            if (item.children?.length) {
                const submenu = document.createElement("div");
                submenu.className = "pz-dock-context-submenu";
                appendItems(submenu, item.children);
                wrapper.append(submenu);
            }
            container.append(wrapper);
        }
    };
    appendItems(menu, items);
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(window.innerWidth - rect.width - 6, x))}px`;
    menu.style.top = `${Math.max(6, Math.min(window.innerHeight - rect.height - 6, y))}px`;
    const close = (event: PointerEvent) => {
        if (menu.contains(event.target as Node)) return;
        menu.remove();
        document.removeEventListener("pointerdown", close, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

function formatTime(ts: number): string {
    if (!ts) {
        return "从未";
    }
    return new Date(ts).toLocaleString();
}

type DockView = "reading" | "recent" | "translations" | "zotero";
const DOCK_VIEW_KEY = "pdf-zotero-dock-view";
const storedDockView = localStorage.getItem(DOCK_VIEW_KEY);
const dockFilter: {query: string; collection: string; page: number; view: DockView} = {
    query: "",
    collection: "",
    page: 0,
    view: storedDockView === "recent" || storedDockView === "zotero" || storedDockView === "translations" ? storedDockView : "reading",
};
let dockSearchTimer = 0;
let settingsDialog: Dialog | null = null;

export function renderDock(host: PluginHost, element: HTMLElement): void {
    element.classList.add("pz-dock");
    const state = host.store.state;
    const cache = state.zotero;
    const fsAvailable = hasNodeFs();
    const electron = requireNode("electron");
    const hasWebUtils = Boolean(electron?.webUtils?.getPathForFile);
    const hasZoteroCache = cache.items.length > 0;
    const statusClass = hasZoteroCache ? "ok" : (cache.lastError ? "err" : "");
    const cachedStatus = `Zotero 缓存：${cache.items.length} 条 · ${cache.attachments?.length || 0} 个 PDF（最后同步 ${escapeHtml(formatTime(cache.updatedAt))}）`;
    const zoteroStatus = hasZoteroCache
        ? `${cachedStatus}${cache.lastError ? " · 当前离线" : ""}`
        : cache.lastError
            ? `Zotero Local API 不可用：${escapeHtml(cache.lastError)}`
            : "尚未读取 Zotero。请点击「检测 / 刷新 Zotero」建立离线缓存。";
    const collections = cache.collections || [];
    const selectedCollectionKeys = new Set<string>();
    if (dockFilter.collection) {
        selectedCollectionKeys.add(dockFilter.collection);
        let added = true;
        while (added) {
            added = false;
            for (const collection of collections) {
                if (collection.parent && selectedCollectionKeys.has(collection.parent) && !selectedCollectionKeys.has(collection.key)) {
                    selectedCollectionKeys.add(collection.key);
                    added = true;
                }
            }
        }
    }
    const filteredItems = cache.items.filter(item => {
        if (dockFilter.collection && !item.collections.some(key => selectedCollectionKeys.has(key))) {
            return false;
        }
        if (!dockFilter.query) {
            return true;
        }
        const haystack = [item.title, item.creators.join(" "), item.year, item.doi || ""].join(" ").toLowerCase();
        return haystack.includes(dockFilter.query.toLowerCase());
    }).sort((a, b) => Number(host.store.isZoteroItemPinned(b.key)) - Number(host.store.isZoteroItemPinned(a.key)));
    const pageSize = 12;
    const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
    dockFilter.page = Math.min(dockFilter.page, pageCount - 1);
    const pageItems = filteredItems.slice(dockFilter.page * pageSize, (dockFilter.page + 1) * pageSize);
    const zoteroItems = pageItems.map(item => `
<button draggable="true" class="pz-list-item${host.store.isZoteroItemPinned(item.key) ? " is-pinned" : ""}" data-zotero-key="${escapeHtml(item.key)}" title="打开该文献的 PDF 附件">
  <div class="pz-item-title">${host.store.isZoteroItemPinned(item.key) ? '<span class="pz-pin-badge">📌</span>' : ""}${escapeHtml(item.title || "(无标题)")}</div>
  <div class="pz-item-meta">${escapeHtml(item.creators.join("; ") || "未知作者")}${item.year ? ` · ${escapeHtml(item.year)}` : ""} · ${escapeHtml(item.itemType)}</div>
</button>`).join("");
    const collectionOptions = `<option value="">全部 Collection</option>` + collections
        .map(collection => `<option value="${escapeHtml(collection.key)}" ${dockFilter.collection === collection.key ? "selected" : ""}>${escapeHtml(collection.name)}</option>`)
        .join("");
    const recentAttachments = host.store.recentAttachments();
    const attachmentCard = (attachment: (typeof recentAttachments)[number], current = false) => {
        const book = host.store.getBook(attachment.bookId);
        return `
<button draggable="true" class="pz-list-item pz-pdf-item${current ? " is-current" : ""}${attachment.pinned ? " is-pinned" : ""}" data-attachment-id="${escapeHtml(attachment.id)}" title="${escapeHtml(attachment.path || attachment.fileName)}">
  <div class="pz-item-title">${attachment.pinned ? '<span class="pz-pin-badge">📌</span>' : ""}${escapeHtml(book?.title || attachment.fileName)}${current ? `<span class="pz-current-badge">当前</span>` : ""}</div>
  <div class="pz-item-meta">第 ${Math.max(1, attachment.lastPage || 1)} 页${attachment.lastOpenedAt ? ` · ${escapeHtml(formatTime(attachment.lastOpenedAt))}` : ""}</div>
</button>`;
    };
    const currentId = state.lastReaderAttachmentId;
    const readingAttachments = [
        ...(currentId && state.attachments[currentId] ? [state.attachments[currentId]] : []),
        ...recentAttachments.filter(item => item.id !== currentId),
    ].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))).slice(0, 8);
    const readingItems = readingAttachments.map(item => attachmentCard(item, item.id === currentId)).join("");
    const recentItems = recentAttachments.slice(0, 20).map(item => attachmentCard(item, item.id === currentId)).join("");
    const translationOutputs = host.store.translationOutputs();
    const translationItems = translationOutputs.map(item => `
<button class="pz-list-item" data-translation-id="${escapeHtml(item.id)}" title="${escapeHtml(item.path)}">
  <div class="pz-item-title">${escapeHtml(item.sourceTitle || item.fileName)}</div>
  <div class="pz-item-meta">${escapeHtml(item.provider === "doc2x" ? "Doc2X" : "PDF2zh")} · ${escapeHtml(item.mode)} · ${escapeHtml(formatTime(item.createdAt))}${item.sourceTitle ? "" : ` · ${escapeHtml(item.fileName)}`}</div>
</button>`).join("");

    const translationsForAttachment = (attachmentId: string) => translationOutputs
        .filter(item => item.sourceAttachmentId === attachmentId);
    const translationsForZotero = (itemKey: string) => {
        const cached = (cache.attachments || []).filter(item => item.parentItemKey === itemKey);
        const attachmentIds = new Set(Object.values(state.attachments)
            .filter(attachment => cached.some(c => c.attachmentKey === attachment.zotero?.attachmentKey))
            .map(attachment => attachment.id));
        return translationOutputs.filter(output => output.sourceAttachmentId && attachmentIds.has(output.sourceAttachmentId));
    };
    const attachmentForZotero = (itemKey: string) => {
        const cached = (cache.attachments || []).find(item => item.parentItemKey === itemKey);
        if (!cached) return undefined;
        return Object.values(state.attachments)
            .find(attachment => attachment.zotero?.attachmentKey === cached.attachmentKey);
    };
    const pathForZotero = (itemKey: string) => {
        const cached = (cache.attachments || []).find(item => item.parentItemKey === itemKey);
        if (!cached) return "";
        return resolveZoteroAttachmentPath({
            dataDir: cache.dataDir,
            attachmentKey: cached.attachmentKey,
            path: cached.rawPath,
            filename: cached.filename,
        });
    };
    const doc2xMenuItems = (target: Doc2xTarget | null): DockMenuItem[] => {
        const doc2x = host.store.state.settings;
        const docType = doc2x.doc2xTranslateType === "md";
        return [
            {label: "翻译PDF为Md到笔记", disabled: !target, action: () => target ? runDoc2xMarkdownAction(host, target, "translate-md") : undefined},
            {label: "解析PDF为Md到笔记", disabled: !target, action: () => target ? runDoc2xMarkdownAction(host, target, "parse-md") : undefined},
            {label: "保留排版翻译（纯译文）", disabled: !target, action: () => target ? runDoc2xPdfAction(host, target, "translatedPdf") : undefined},
            {label: docType ? "双语对照+文档型翻译（插入笔记）" : "双语对照+排版翻译（Pro）", disabled: !target, action: () => target ? runDoc2xPdfAction(host, target, "dualPdf") : undefined},
            {label: "Doc2x:打开报错日志目录", action: () => openDoc2xErrorLogDir(host)},
        ];
    };
    const doc2xTargetForAttachment = (attachment: any): Doc2xTarget => ({
        id: attachment.id,
        path: attachment.path,
        fingerprint: attachment.fingerprint || attachment.id,
        sourceAttachmentId: attachment.id,
        sourceTitle: host.store.getBook(attachment.bookId)?.title || attachment.fileName,
    });
    const doc2xTargetForZotero = (itemKey: string): Doc2xTarget | null => {
        const attachment = attachmentForZotero(itemKey);
        if (attachment) return doc2xTargetForAttachment(attachment);
        const pathValue = pathForZotero(itemKey);
        if (!pathValue || !fileExists(pathValue)) return null;
        return {
            id: `zotero-${itemKey}`,
            path: pathValue,
            fingerprint: itemKey,
            sourceTitle: cache.items.find(item => item.key === itemKey)?.title,
        };
    };
    const openTranslationOutput = async (output: typeof translationOutputs[number]) => {
        if (!fileExists(output.path)) {
            showMessage("译文文件不存在，可能已被移动或删除", 5000, "error");
            return;
        }
        const imported = await host.importLocalPath(output.path);
        if (imported) host.openAttachment(imported);
    };
    const openOriginalOutput = (output: typeof translationOutputs[number]) => {
        const attachment = output.sourceAttachmentId
            ? host.store.getAttachment(output.sourceAttachmentId)
            : undefined;
        if (!attachment) {
            showMessage("找不到该译文对应的原文 PDF", 4000, "error");
            return;
        }
        host.openAttachment(attachment);
    };
    const revealPath = (pathValue: string) => {
        if (!pathValue) {
            showMessage("找不到文件路径", 3000, "error");
            return;
        }
        electron?.shell?.showItemInFolder?.(pathValue);
    };

    const tabs = `
<div class="pz-dock-tabs" role="tablist" aria-label="PDF 与 Zotero 视图">
  <button role="tab" data-view="reading" class="${dockFilter.view === "reading" ? "is-active" : ""}">阅读中 <span>${readingAttachments.length}</span></button>
  <button role="tab" data-view="recent" class="${dockFilter.view === "recent" ? "is-active" : ""}">最近 <span>${recentAttachments.length}</span></button>
  <button role="tab" data-view="translations" class="${dockFilter.view === "translations" ? "is-active" : ""}">译文 <span>${translationOutputs.length}</span></button>
  <button role="tab" data-view="zotero" class="${dockFilter.view === "zotero" ? "is-active" : ""}">Zotero <span>${cache.items.length}</span></button>
</div>`;

    const readingView = `<section class="pz-dock-view">
  <div class="pz-view-heading"><div><strong>继续阅读</strong><small>保留最近阅读位置</small></div><button data-act="open-local">＋ 打开 PDF</button></div>
  <div class="pz-list">${readingItems || `<div class="pz-dock-empty"><strong>还没有正在阅读的 PDF</strong><span>打开一篇 PDF 后，它会显示在这里并记住阅读页码。</span><button data-act="open-local">打开本地 PDF</button></div>`}</div>
</section>`;
    const recentView = `<section class="pz-dock-view">
  <div class="pz-view-heading"><div><strong>最近打开</strong><small>最多显示 20 篇</small></div><button data-act="open-local">＋ 打开 PDF</button></div>
  <div class="pz-list">${recentItems || `<div class="pz-dock-empty"><strong>暂无历史记录</strong><span>打开过的 PDF 会按时间排列在这里。</span></div>`}</div>
</section>`;
    const translationsView = `<section class="pz-dock-view">
  <div class="pz-view-heading"><div><strong>译文历史</strong><small>${translationOutputs.length} 个翻译 PDF</small></div><div class="pz-view-heading-actions"><button data-act="open-translations-dir">打开目录</button><button data-act="clear-translations">清空记录</button></div></div>
  <div class="pz-list">${translationItems || `<div class="pz-dock-empty"><strong>还没有译文</strong><span>在 PDF 顶部使用整篇翻译后，生成的 PDF 会显示在这里。</span></div>`}</div>
</section>`;
    const zoteroView = `<section class="pz-dock-view">
  <div class="pz-view-heading"><div><strong>Zotero 文献</strong><small>${filteredItems.length} 条匹配结果</small></div><button data-act="refresh-zotero">刷新</button></div>
  <div class="pz-status ${statusClass}">${zoteroStatus}</div>
  <div class="pz-dock-filters">
    <input class="b3-text-field fn__block" data-role="zotero-search" placeholder="搜索标题、作者、年份或 DOI" value="${escapeHtml(dockFilter.query)}" />
    <select class="b3-select fn__block" data-role="zotero-collection">${collectionOptions}</select>
  </div>
  <div class="pz-list pz-zotero-list">${zoteroItems || `<div class="pz-dock-empty"><strong>没有匹配的文献</strong><span>请刷新 Zotero 或调整搜索条件。</span></div>`}</div>
  <div class="pz-pagination">
    <button data-act="zotero-prev" ${dockFilter.page <= 0 ? "disabled" : ""}>上一页</button>
    <span>第 ${dockFilter.page + 1} / ${pageCount} 页</span>
    <button data-act="zotero-next" ${dockFilter.page >= pageCount - 1 ? "disabled" : ""}>下一页</button>
  </div>
  <details class="pz-dock-runtime"><summary>连接信息</summary><div class="pz-muted">Node fs ${fsAvailable ? "可用" : "不可用"} · Electron webUtils ${hasWebUtils ? "可用" : "不可用"}<br>${escapeHtml(state.settings.zoteroDataDir || "未设置数据目录")}</div></details>
</section>`;

    element.innerHTML = `
<div class="pz-dock-head">
  <div><h2>${PLUGIN_DISPLAY_NAME}</h2><div class="pz-muted">v${VERSION} · PDF 阅读与 Zotero</div></div>
  <button class="pz-head-settings" data-act="settings" title="设置" aria-label="设置">⚙</button>
</div>
<div class="pz-row pz-dock-actions">
  <button data-act="open-local">打开本地 PDF</button>
  <button data-view="zotero">查找文献</button>
  <button data-act="insert-citation">插入引文</button>
  <button data-act="ocr-clipboard" title="识别剪贴板中的图片">OCR 剪贴板</button>
  <button data-act="ocr-history" title="查看 OCR 历史与收藏">OCR 历史</button>
      <button data-act="open-matrix" title="打开文献矩阵">文献矩阵</button>
      <button data-act="open-template-manager" title="管理默认笔记模板">笔记模板</button>
</div>
${tabs}
${dockFilter.view === "reading" ? readingView : dockFilter.view === "recent" ? recentView : dockFilter.view === "translations" ? translationsView : zoteroView}`;

    element.querySelector<HTMLInputElement>('[data-role="zotero-search"]')?.addEventListener("input", (event) => {
        dockFilter.query = (event.target as HTMLInputElement).value;
        dockFilter.page = 0;
        window.clearTimeout(dockSearchTimer);
        dockSearchTimer = window.setTimeout(() => host.refreshDock(), 260);
    });
    element.querySelector<HTMLSelectElement>('[data-role="zotero-collection"]')?.addEventListener("change", (event) => {
        dockFilter.collection = (event.target as HTMLSelectElement).value;
        dockFilter.page = 0;
        host.refreshDock();
    });
    element.addEventListener("dragstart", (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-zotero-key],[data-attachment-id]");
        if (!target || !event.dataTransfer) return;
        if (target.dataset.zoteroKey) event.dataTransfer.setData("text/plain", `pz-zotero:${target.dataset.zoteroKey}`);
        else if (target.dataset.attachmentId) event.dataTransfer.setData("text/plain", `pz-pdf:${target.dataset.attachmentId}`);
    });
    element.onclick = async (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act],[data-view],[data-zotero-key],[data-attachment-id],[data-translation-id]");
        if (!target) {
            return;
        }
        const view = target.dataset.view as DockView | undefined;
        if (view) {
            dockFilter.view = view;
            localStorage.setItem(DOCK_VIEW_KEY, view);
            host.refreshDock();
            return;
        }
        const action = target.dataset.act || "";
        try {
            if (action === "open-local") {
                await host.importLocalPdfFromPicker();
            } else if (action === "refresh-zotero") {
                await host.refreshZotero();
            } else if (action === "open-translations-dir") {
                electron?.shell?.openPath?.(translationOutputDir(host.store.state.settings));
            } else if (action === "clear-translations") {
                if (!translationOutputs.length) return;
                if (!window.confirm("清空全部翻译历史记录？不会删除实际 PDF 文件。")) return;
                for (const output of translationOutputs) host.store.removeTranslationOutput(output.id);
                void host.store.save();
                host.refreshDock();
            } else if (action === "open-template-manager") {
                openTemplateManager(host);
            } else if (action === "open-matrix") {
                openMatrix(host);
            } else if (action === "ocr-clipboard") {
                host.ocrClipboardImage();
            } else if (action === "ocr-history") {
                openOcrHistory(host);
            } else if (action === "insert-citation") {
                host.openCitationDialog();
            } else if (action === "settings") {
                openSettings(host);
            } else if (action === "zotero-prev") {
                dockFilter.page = Math.max(0, dockFilter.page - 1);
                host.refreshDock();
            } else if (action === "zotero-next") {
                dockFilter.page++;
                host.refreshDock();
            } else if (target.dataset.zoteroKey) {
                await host.openZoteroItem(target.dataset.zoteroKey);
            } else if (target.dataset.attachmentId) {
                const attachment = host.store.getAttachment(target.dataset.attachmentId);
                if (attachment) {
                    host.openAttachment(attachment);
                }
            } else if (target.dataset.translationId) {
                const output = host.store.state.translationOutputs[target.dataset.translationId];
                if (!output) return;
                if (!fileExists(output.path)) {
                    showMessage("译文文件不存在，可能已被移动或删除", 5000, "error");
                    return;
                }
                const imported = await host.importLocalPath(output.path);
                if (imported) host.openAttachment(imported);
            }
        } catch (error: any) {
            showMessage(`操作失败：${error?.message || String(error)}`, 6000, "error");
        }


    };

    const onDockContextMenu = (event: MouseEvent) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-zotero-key],[data-attachment-id],[data-translation-id]");
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        if (target.dataset.translationId) {
            const output = host.store.state.translationOutputs[target.dataset.translationId];
            if (!output) return;
            showDockContextMenu(event.clientX, event.clientY, [
                {label: "打开译文", action: () => openTranslationOutput(output)},
                {label: "打开原文", action: () => openOriginalOutput(output), disabled: !output.sourceAttachmentId},
                {label: "打开文件所在位置", action: () => revealPath(output.path)},
                {label: "复制文件路径", action: () => void navigator.clipboard?.writeText(output.path).then(() => showMessage("已复制路径", 1500))},
                {label: "删除历史记录", danger: true, action: () => {
                    if (!window.confirm("删除这条翻译历史记录？不会删除实际 PDF 文件。")) return;
                    host.store.removeTranslationOutput(output.id);
                    void host.store.save();
                    host.refreshDock();
                }},
            ]);
            return;
        }
        if (target.dataset.zoteroKey) {
            const itemKey = target.dataset.zoteroKey;
            const translations = translationsForZotero(itemKey);
            const attachment = attachmentForZotero(itemKey);
            const pinned = host.store.isZoteroItemPinned(itemKey);
            showDockContextMenu(event.clientX, event.clientY, [
                {label: "打开译文", action: () => translations.length ? openTranslationOutput(translations[0]) : showMessage("该文献还没有译文", 2500), disabled: !translations.length},
                {label: pinned ? "取消置顶" : "置顶", action: () => {
                    host.store.toggleZoteroItemPin(itemKey);
                    void host.store.save();
                    host.refreshDock();
                }},
                {label: "打开文件所在位置", action: () => revealPath(pathForZotero(itemKey)), disabled: !pathForZotero(itemKey)},
                {label: "用所选条目创建参考文献", action: () => host.openCitationDialog(undefined, [itemKey]), disabled: !host.store.state.zotero.items.some(item => item.key === itemKey)},
                {label: "用模板创建笔记", action: () => createNoteFromTemplate(host, itemKey), disabled: !host.store.state.zotero.items.some(item => item.key === itemKey)},
                {label: "Doc2X", children: doc2xMenuItems(doc2xTargetForZotero(itemKey))},
                ...(attachment ? [{label: "打开 PDF", action: () => host.openAttachment(attachment)}] : []),
            ]);
            return;
        }
        const attachment = host.store.getAttachment(target.dataset.attachmentId || "");
        if (!attachment) return;
        const translations = translationsForAttachment(attachment.id);
        const itemKey = attachment.zotero?.itemKey || host.store.getBook(attachment.bookId)?.zoteroKey || "";
        showDockContextMenu(event.clientX, event.clientY, [
            {label: "打开译文", action: () => translations.length ? openTranslationOutput(translations[0]) : showMessage("该 PDF 还没有译文", 2500), disabled: !translations.length},
            {label: attachment.pinned ? "取消置顶" : "置顶", action: () => {
                host.store.toggleAttachmentPin(attachment.id);
                void host.store.save();
                host.refreshDock();
            }},
            {label: "打开文件所在位置", action: () => revealPath(attachment.path)},
            {label: "用所选条目创建参考文献", action: () => host.openCitationDialog(undefined, [itemKey]), disabled: !itemKey},
            {label: "用模板创建笔记", action: () => itemKey ? createNoteFromTemplate(host, itemKey) : undefined, disabled: !itemKey},
            {label: "Doc2X", children: doc2xMenuItems(doc2xTargetForAttachment(attachment))},
        ]);
    };
    element.addEventListener("contextmenu", onDockContextMenu, true);

}

import {openSettings as openSettingsFromDialog} from "./settings-dialog";

/** Opens the restructured settings dialog (5 pages, instant apply, search). */
export function openSettings(host: PluginHost): void {
    openSettingsFromDialog(host);
}
