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
import {openGraph} from "./graph-dialog";
import {openTemplateManager} from "./template-manager";
import {createNoteFromTemplate} from "../template/notes";
import {syncTranslationHistory} from "../translation/history";
import {openDoc2xErrorLogDir, runDoc2xMarkdownAction, runDoc2xParseAction, runDoc2xPdfAction, type Doc2xTarget} from "./doc2x-actions";
import {loadParseLibrary, readParseMarkdown, removeParseRecord, type ParseRecord} from "../doc2x/library";
import {openParseAsDocument, openParsePreview} from "./doc2x-preview";
import {openParseTranslateDialog} from "./doc2x-translate-dialog";
import {applyQaBlockTheme} from "../qa/theme";
import {attachmentForZoteroItem, metaKeyForAttachment, statusForStat} from "../reading/index";
import {fetchJournalFields, formatJournalTags, normalizeJournalName} from "../reading/journal";
import {READING_STATUS_LABEL, formatDuration, progressOf, relativeTime} from "../reading/stats";

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

function copyToClipboard(text: string, label: string): void {
    void navigator.clipboard?.writeText(text)
        .then(() => showMessage(`已复制${label}`, 1500))
        .catch(() => showMessage("复制失败", 2500, "error"));
}

function bibtexFromFields(input: {title?: string; authors?: string[]; year?: string | number; venue?: string; doi?: string}): string {
    const title = String(input.title || "");
    const authors = (input.authors || []).filter(Boolean);
    const year = String(input.year || "");
    const fields: string[] = [];
    if (title) fields.push(`  title = {${title}}`);
    if (authors.length) fields.push(`  author = {${authors.join(" and ")}}`);
    if (year) fields.push(`  year = {${year}}`);
    if (input.venue) fields.push(`  journal = {${input.venue}}`);
    if (input.doi) fields.push(`  doi = {${input.doi}}`);
    const first = (authors[0] || "ref").replace(/[^A-Za-z]/g, "").toLowerCase();
    return `@article{${first || "ref"}${year},\n${fields.join(",\n")}\n}`;
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
const dockFilter: {query: string; collection: string; view: DockView; parseFilter: "all" | "parse" | "translate"} = {
    query: "",
    collection: "",
    parseFilter: "all",
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
    const ZOTERO_BATCH = 40;
    const progressHtml = (ratio: number, label: string) => {
        const width = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
        return `<div class="pz-item-progress" title="${escapeHtml(label)}"><span style="width:${width}%"></span></div>`;
    };
    const ratingHtml = (key: string) => {
        if (!key) return "";
        const rating = host.store.itemMeta(key)?.rating || 0;
        return `<span class="pz-rating" data-meta-key="${escapeHtml(key)}" data-rating="${rating}" title="点击打分，再点同一颗清除"><i data-rating="1" class="${rating >= 1 ? "is-on" : ""}">★</i><i data-rating="2" class="${rating >= 2 ? "is-on" : ""}">★</i><i data-rating="3" class="${rating >= 3 ? "is-on" : ""}">★</i><i data-rating="4" class="${rating >= 4 ? "is-on" : ""}">★</i><i data-rating="5" class="${rating >= 5 ? "is-on" : ""}">★</i></span>`;
    };
    const readingMetaText = (stat: ReturnType<typeof host.store.readingStat>) => {
        if (!stat || !stat.totalSeconds) return "";
        const parts = [formatDuration(stat.totalSeconds)];
        if (stat.lastReadAt) parts.push(relativeTime(stat.lastReadAt));
        return ` · ${parts.join(" · ")}`;
    };
    const metaMenuItems = (key: string) => {
        if (!key) return [];
        const meta = host.store.itemMeta(key);
        const remark = meta?.remark || "";
        return [
            {
                label: `评级${meta?.rating ? `（${"★".repeat(meta.rating)}）` : ""}`,
                children: [0, 1, 2, 3, 4, 5].map(value => ({
                    label: value ? "★".repeat(value) : "清除评级",
                    action: () => {
                        host.store.setItemRating(key, value);
                        void host.store.save();
                        host.refreshDock();
                    },
                })),
            },
            {
                label: remark ? "编辑简记…" : "添加简记…",
                action: () => {
                    const next = window.prompt("简记（留空清除）", remark);
                    if (next === null) return;
                    host.store.setItemRemark(key, next);
                    void host.store.save();
                    host.refreshDock();
                },
            },
        ];
    };
    const zoteroItemHtml = (item: (typeof filteredItems)[number]) => {
        const linked = attachmentForZoteroItem(host.store, item.key);
        const stat = linked ? host.store.readingStat(linked.id) : undefined;
        const ratio = progressOf(stat);
        const status = READING_STATUS_LABEL[statusForStat(host.store, stat)];
        const percent = Math.round(ratio * 100);
        return `
<button draggable="true" class="pz-list-item${host.store.isZoteroItemPinned(item.key) ? " is-pinned" : ""}" data-zotero-key="${escapeHtml(item.key)}" title="打开该文献的 PDF 附件">
  <div class="pz-item-title">${host.store.isZoteroItemPinned(item.key) ? '<span class="pz-pin-badge">📌</span>' : ""}${escapeHtml(item.title || "(无标题)")}</div>
  ${ratio > 0 ? progressHtml(ratio, `阅读进度 ${percent}%`) : ""}
  <div class="pz-item-foot"><span class="pz-item-meta">${escapeHtml(item.creators.join("; ") || "未知作者")}${item.year ? ` · ${escapeHtml(item.year)}` : ""} · ${status}${ratio > 0 ? ` ${percent}%` : ""}${readingMetaText(stat)}</span>${ratingHtml(item.key)}</div>
</button>`;
    };
    const zoteroItems = filteredItems.slice(0, ZOTERO_BATCH).map(zoteroItemHtml).join("");
    const collectionOptions = `<option value="">全部 Collection</option>` + collections
        .map(collection => `<option value="${escapeHtml(collection.key)}" ${dockFilter.collection === collection.key ? "selected" : ""}>${escapeHtml(collection.name)}</option>`)
        .join("");
    const recentAttachments = host.store.recentAttachments();
    const attachmentCard = (attachment: (typeof recentAttachments)[number], current = false) => {
        const book = host.store.getBook(attachment.bookId);
        const stat = host.store.readingStat(attachment.id);
        const ratio = progressOf(stat);
        const status = READING_STATUS_LABEL[statusForStat(host.store, stat)];
        const key = metaKeyForAttachment(attachment);
        const remark = host.store.itemMeta(key)?.remark || "";
        const percent = Math.round(ratio * 100);
        return `
<button draggable="true" class="pz-list-item pz-pdf-item${current ? " is-current" : ""}${attachment.pinned ? " is-pinned" : ""}" data-attachment-id="${escapeHtml(attachment.id)}" title="${escapeHtml(attachment.path || attachment.fileName)}">
  <div class="pz-item-title">${attachment.pinned ? '<span class="pz-pin-badge">📌</span>' : ""}${escapeHtml(book?.title || attachment.fileName)}${current ? `<span class="pz-current-badge">当前</span>` : ""}</div>
  ${ratio > 0 ? progressHtml(ratio, `阅读进度 ${percent}%`) : ""}
  <div class="pz-item-foot"><span class="pz-item-meta">第 ${Math.max(1, attachment.lastPage || 1)} 页 · ${status}${ratio > 0 ? ` ${percent}%` : ""}${attachment.lastOpenedAt ? ` · ${escapeHtml(formatTime(attachment.lastOpenedAt))}` : ""}${readingMetaText(stat)}${remark ? ` · ${escapeHtml(remark)}` : ""}</span>${ratingHtml(key)}</div>
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
    const parseRecords = loadParseLibrary();
    const visibleParses = parseRecords.filter(item => dockFilter.parseFilter === "all" || item.kind === dockFilter.parseFilter);
    const visibleTranslationOutputs = dockFilter.parseFilter === "parse" ? [] : translationOutputs;
    const translationItems = translationOutputs.map(item => `
<button class="pz-list-item" data-translation-id="${escapeHtml(item.id)}" title="${escapeHtml(item.path)}" data-sort-at="${item.createdAt}" data-kind="translate">
  <div class="pz-item-title">${escapeHtml(item.sourceTitle || item.fileName)}</div>
  <div class="pz-item-meta">翻译 · ${escapeHtml(item.provider === "doc2x" ? "Doc2X" : "PDF2zh")} · ${escapeHtml(item.mode)} · ${escapeHtml(formatTime(item.createdAt))}</div>
</button>`).join("");
    const parseItems = visibleParses.map(item => `
<button class="pz-list-item" data-parse-id="${escapeHtml(item.id)}" title="${escapeHtml(item.mdPath)}" data-sort-at="${item.createdAt}" data-kind="${item.kind}">
  <div class="pz-item-title">${item.kind === "translate" ? "译 · " : ""}${escapeHtml(item.sourceTitle || item.fingerprint)}</div>
  <div class="pz-item-meta">${item.kind === "translate" ? "翻译 MD" : "解析 MD"} · ${escapeHtml(item.model || "doc2x")} · ${escapeHtml(formatTime(item.createdAt))} · ${item.imagesCount || 0} 图${item.version > 1 ? ` · v${item.version}` : ""}${item.noteDocId ? " · 已插入" : ""}</div>
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
            {label: "翻译解析结果…", disabled: !target, action: () => target ? runDoc2xMarkdownAction(host, target, "translate-md") : undefined},
            {label: "解析 PDF 为 Markdown…", disabled: !target, action: () => target ? runDoc2xMarkdownAction(host, target, "parse-md") : undefined},
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
  <button role="tab" data-view="translations" class="${dockFilter.view === "translations" ? "is-active" : ""}">解析翻译 <span>${parseRecords.length + translationOutputs.length}</span></button>
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
    const mergedItems = [
        ...Array.from(parseItems ? [parseItems] : []),
    ];
    const orderedItems = (() => {
        const rows: Array<{at: number; html: string}> = [];
        for (const item of visibleParses) {
            const at = item.createdAt;
            rows.push({at, html: `<button class="pz-list-item" data-parse-id="${escapeHtml(item.id)}" title="${escapeHtml(item.mdPath)}">
  <div class="pz-item-title">${item.kind === "translate" ? "译 · " : ""}${escapeHtml(item.sourceTitle || item.fingerprint)}</div>
  <div class="pz-item-meta">${item.kind === "translate" ? "翻译 MD" : "解析 MD"} · ${escapeHtml(item.model || "doc2x")} · ${escapeHtml(formatTime(item.createdAt))} · ${item.imagesCount || 0} 图${item.version > 1 ? ` · v${item.version}` : ""}${item.noteDocId ? " · 已插入" : ""}</div>
</button>`});
        }
        for (const item of visibleTranslationOutputs) {
            rows.push({at: item.createdAt, html: `<button class="pz-list-item" data-translation-id="${escapeHtml(item.id)}" title="${escapeHtml(item.path)}">
  <div class="pz-item-title">${escapeHtml(item.sourceTitle || item.fileName)}</div>
  <div class="pz-item-meta">翻译 · ${escapeHtml(item.provider === "doc2x" ? "Doc2X" : "PDF2zh")} · ${escapeHtml(item.mode)} · ${escapeHtml(formatTime(item.createdAt))}</div>
</button>`});
        }
        return rows.sort((a, b) => b.at - a.at).map(row => row.html).join("");
    })();
    const translationsView = `<section class="pz-dock-view">
  <div class="pz-view-heading"><div><strong>解析与翻译</strong><small>${visibleParses.length} 条解析 MD · ${visibleTranslationOutputs.length} 个翻译结果</small></div><div class="pz-view-heading-actions"><button data-act="open-translations-dir">打开目录</button><button data-act="clear-translations">清空记录</button></div></div>
  <div class="pz-dock-filters" style="margin-bottom:6px"><select class="b3-select fn__block" data-role="parse-filter">
    <option value="all" ${dockFilter.parseFilter === "all" ? "selected" : ""}>全部（解析 + 翻译）</option>
    <option value="parse" ${dockFilter.parseFilter === "parse" ? "selected" : ""}>仅解析结果</option>
    <option value="translate" ${dockFilter.parseFilter === "translate" ? "selected" : ""}>仅翻译结果</option>
  </select></div>
  <div class="pz-list">${orderedItems || `<div class="pz-dock-empty"><strong>还没有解析或翻译结果</strong><span>在 PDF 菜单里使用「解析 PDF 为 Markdown」或「翻译 PDF 为 Markdown」后，结果显示在这里。</span></div>`}</div>
</section>`;
    const offline = Boolean(cache.lastError && hasZoteroCache);
    const syncLabel = cache.updatedAt ? `${formatTime(cache.updatedAt)} 同步` : "";
    const summaryParts = [
        hasZoteroCache ? `${cache.items.length} 条缓存` : "",
        hasZoteroCache ? `${cache.attachments?.length || 0} PDF` : "",
        syncLabel,
    ].filter(Boolean);
    const zoteroSummaryTitle = hasZoteroCache
        ? cachedStatus
        : (cache.lastError ? `Zotero Local API 不可用：${cache.lastError}` : "尚未读取 Zotero，请点击刷新");
    const connection = !hasZoteroCache ? "未连接" : (offline ? "离线" : "在线");
    const connectionTone = !hasZoteroCache ? "is-off" : (offline ? "is-offline" : "is-online");
    const zoteroView = `<section class="pz-dock-view">
  <div class="pz-view-heading"><div class="pz-zotero-summary" title="${escapeHtml(zoteroSummaryTitle)}"><strong>Zotero 文献</strong>${summaryParts.length ? `<span class="pz-muted">· ${escapeHtml(summaryParts.join(" · "))}</span>` : ""}</div><div class="pz-zotero-head-actions"><button type="button" class="pz-zotero-status-btn ${connectionTone}" aria-disabled="true" tabindex="-1" title="${escapeHtml(zoteroSummaryTitle)}">${connection}</button><button data-act="refresh-zotero">刷新</button></div></div>
  <div class="pz-dock-filters">
    <input class="b3-text-field fn__block" data-role="zotero-search" placeholder="搜索标题、作者、年份或 DOI" value="${escapeHtml(dockFilter.query)}" />
    <select class="b3-select fn__block" data-role="zotero-collection">${collectionOptions}</select>
  </div>
  <div class="pz-list pz-zotero-list" data-role="zotero-list">${zoteroItems || `<div class="pz-dock-empty"><strong>没有匹配的文献</strong><span>请刷新 Zotero 或调整搜索条件。</span></div>`}</div>
  <details class="pz-dock-runtime"><summary>连接信息</summary><div class="pz-muted">Node fs ${fsAvailable ? "可用" : "不可用"} · Electron webUtils ${hasWebUtils ? "可用" : "不可用"}<br>${escapeHtml(state.settings.zoteroDataDir || "未设置数据目录")}</div></details>
</section>`;

    element.innerHTML = `
<div class="pz-dock-head">
  <div><h2>${PLUGIN_DISPLAY_NAME}</h2><div class="pz-muted">v${VERSION} · PDF 阅读与 Zotero</div></div>
  <button class="pz-head-settings" data-act="settings" title="设置" aria-label="设置">⚙</button>
</div>
<div class="pz-row pz-dock-actions">
  <button data-act="open-local" title="打开本地 PDF"><span class="pz-act-icon">📄</span>打开 PDF</button>
  <button data-act="open-matrix" title="打开文献矩阵"><span class="pz-act-icon">📊</span>文献矩阵</button>
  <button data-act="open-graph" title="按 Connected Papers 的方式探索文献网络"><span class="pz-act-icon">🕸</span>文献网络</button>
  <button data-act="insert-citation" title="在正文插入 Zotero 引文"><span class="pz-act-icon">✎</span>插入引文</button>
  <button data-act="ocr-menu" title="OCR：识别剪贴板 / 历史"><span class="pz-act-icon">🔍</span>OCR</button>
  <button data-act="open-template-manager" title="管理默认笔记模板"><span class="pz-act-icon">📝</span>笔记模板</button>
</div>
${tabs}
${dockFilter.view === "reading" ? readingView : dockFilter.view === "recent" ? recentView : dockFilter.view === "translations" ? translationsView : zoteroView}`;

    element.querySelector<HTMLInputElement>('[data-role="zotero-search"]')?.addEventListener("input", (event) => {
        dockFilter.query = (event.target as HTMLInputElement).value;
        window.clearTimeout(dockSearchTimer);
        dockSearchTimer = window.setTimeout(() => host.refreshDock(), 260);
    });
    element.querySelector<HTMLSelectElement>('[data-role="zotero-collection"]')?.addEventListener("change", (event) => {
        dockFilter.collection = (event.target as HTMLSelectElement).value;
        host.refreshDock();
    });
    element.querySelector<HTMLSelectElement>('[data-role="parse-filter"]')?.addEventListener("change", (event) => {
        const value = (event.target as HTMLSelectElement).value;
        dockFilter.parseFilter = value === "parse" || value === "translate" ? value : "all";
        host.refreshDock();
    });
    const zoteroList = element.querySelector<HTMLElement>('[data-role="zotero-list"]');
    if (zoteroList) {
        let rendered = Math.min(filteredItems.length, ZOTERO_BATCH);
        let loading = false;
        const loadMore = (): void => {
            if (loading || rendered >= filteredItems.length) return;
            if (zoteroList.scrollTop + zoteroList.clientHeight < zoteroList.scrollHeight - 80) return;
            loading = true;
            const next = filteredItems.slice(rendered, rendered + ZOTERO_BATCH);
            zoteroList.insertAdjacentHTML("beforeend", next.map(zoteroItemHtml).join(""));
            rendered += next.length;
            loading = false;
        };
        zoteroList.addEventListener("scroll", loadMore, {passive: true});
    }
    element.addEventListener("dragstart", (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-zotero-key],[data-attachment-id]");
        if (!target || !event.dataTransfer) return;
        if (target.dataset.zoteroKey) event.dataTransfer.setData("text/plain", `pz-zotero:${target.dataset.zoteroKey}`);
        else if (target.dataset.attachmentId) event.dataTransfer.setData("text/plain", `pz-pdf:${target.dataset.attachmentId}`);
    });
    element.onclick = async (event) => {
        const ratingTarget = (event.target as HTMLElement).closest<HTMLElement>("i[data-rating]");
        const ratingHolder = ratingTarget?.closest<HTMLElement>("[data-meta-key]");
        if (ratingTarget && ratingHolder) {
            event.preventDefault();
            event.stopPropagation();
            const key = ratingHolder.dataset.metaKey || "";
            const current = Number(ratingHolder.dataset.rating || 0);
            const picked = Number(ratingTarget.dataset.rating || 0);
            host.store.setItemRating(key, picked === current ? 0 : picked);
            await host.store.save();
            host.refreshDock();
            return;
        }
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act],[data-view],[data-zotero-key],[data-attachment-id],[data-translation-id],[data-parse-id]");
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
                if (!translationOutputs.length && !loadParseLibrary().length) return;
                if (!window.confirm("清空全部解析与翻译记录？解析结果及其图片缓存会被删除，翻译 PDF 文件不会被删除。")) return;
                for (const output of translationOutputs) host.store.removeTranslationOutput(output.id);
                for (const record of loadParseLibrary()) removeParseRecord(record.id, true);
                void host.store.save();
                host.refreshDock();
            } else if (action === "open-template-manager") {
                openTemplateManager(host);
            } else if (action === "open-matrix") {
                openMatrix(host);
            } else if (action === "open-graph") {
                openGraph(host, {});
            } else if (action === "ocr-menu") {
                const rect = target.getBoundingClientRect();
                showDockContextMenu(rect.left, rect.bottom + 4, [
                    {label: "识别剪贴板图片", action: () => host.ocrClipboardImage()},
                    {label: "OCR 历史与收藏", action: () => openOcrHistory(host)},
                    {label: "OCR 引擎设置", action: () => openSettings(host)},
                ]);
            } else if (action === "ocr-clipboard") {
                host.ocrClipboardImage();
            } else if (action === "ocr-history") {
                openOcrHistory(host);
            } else if (action === "insert-citation") {
                host.openCitationDialog();
            } else if (action === "settings") {
                openSettings(host);
            } else if (target.dataset.zoteroKey) {
                await host.openZoteroItem(target.dataset.zoteroKey);
            } else if (target.dataset.attachmentId) {
                const attachment = host.store.getAttachment(target.dataset.attachmentId);
                if (attachment) {
                    host.openAttachment(attachment);
                }
            } else if (target.dataset.parseId) {
                const record = parseRecords.find(item => item.id === target.dataset.parseId);
                if (record) await openParseAsDocument(host, record);
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
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-zotero-key],[data-attachment-id],[data-translation-id],[data-parse-id]");
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        if (target.dataset.parseId) {
            const record = parseRecords.find(item => item.id === target.dataset.parseId);
            if (!record) return;
            const attachment = record.sourceAttachmentId ? host.store.getAttachment(record.sourceAttachmentId) : undefined;
            showDockContextMenu(event.clientX, event.clientY, [
                {label: "以笔记文档打开", action: () => void openParseAsDocument(host, record)},
                {label: "预览 / 插入…", action: () => openParsePreview(host, record)},
                {label: "翻译…", action: () => openParseTranslateDialog(host, record)},
                {label: "打开 Markdown 所在位置", action: () => revealPath(record.mdPath)},
                {label: "复制 Markdown 路径", action: () => void navigator.clipboard?.writeText(record.mdPath).then(() => showMessage("已复制路径", 1500))},
                {label: "定位原 PDF", action: () => attachment ? host.openAttachment(attachment) : revealPath(record.sourcePdfPath)},
                {label: "删除解析结果", action: () => {
                    if (!window.confirm("删除这条解析结果及其图片缓存？")) return;
                    removeParseRecord(record.id, true);
                    host.refreshDock();
                }},
            ]);
            return;
        }
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
            const zoteroRecord = host.store.state.zotero.items.find(entry => entry.key === itemKey);
            const zoteroCsl = (zoteroRecord?.csl || {}) as Record<string, any>;
            const copyTitle = String(zoteroRecord?.title || zoteroCsl.title || "");
            const copyDoi = String(zoteroCsl.DOI || zoteroRecord?.doi || "");
            const copyAuthors = Array.isArray(zoteroRecord?.creators) ? zoteroRecord!.creators : [];
            const copyYear = zoteroRecord?.year || zoteroCsl.issued?.["date-parts"]?.[0]?.[0] || "";
            const copyVenue = String(zoteroCsl["container-title"] || "");
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
                {
                    label: "获取期刊标签",
                    disabled: !host.store.state.settings.journalApiKey,
                    action: async () => {
                        const record = host.store.state.zotero.items.find(entry => entry.key === itemKey);
                        const csl = (record?.csl || {}) as Record<string, any>;
                        const venue = String(csl["container-title"] || csl.publisher || "");
                        if (!venue) {
                            showMessage("该条目没有期刊 / 会议名称", 3000);
                            return;
                        }
                        const fields = await fetchJournalFields(host.store.state.settings, venue);
                        if (!fields) {
                            showMessage("未获取到期刊数据，请检查 easyScholar 密钥与网络", 4500, "error");
                            return;
                        }
                        host.store.setJournalEntry(normalizeJournalName(venue), fields);
                        await host.store.save();
                        const label = formatJournalTags(fields, host.store.state.settings.journalMap, host.store.state.settings.journalFields);
                        if (label) {
                            showMessage(label, 3500);
                        } else {
                            const available = Object.keys(fields).slice(0, 8).join(", ");
                            showMessage(`已缓存，但该刊没有「${host.store.state.settings.journalFields}」这些字段。可用字段：${available}（在设置里调整显示字段）`, 8000);
                        }
                        host.refreshDock();
                    },
                },
                ...metaMenuItems(itemKey),
                {
                    label: "复制",
                    children: [
                        {label: "复制标题", disabled: !copyTitle, action: () => copyToClipboard(copyTitle, "标题")},
                        {label: "复制 DOI", disabled: !copyDoi, action: () => copyToClipboard(copyDoi, " DOI")},
                        {label: "复制作者", disabled: !copyAuthors.length, action: () => copyToClipboard(copyAuthors.join("; "), "作者")},
                        {label: "复制 BibTeX", disabled: !copyTitle, action: () => copyToClipboard(bibtexFromFields({
                            title: copyTitle,
                            authors: copyAuthors,
                            year: copyYear,
                            venue: copyVenue,
                            doi: copyDoi,
                        }), " BibTeX")},
                    ],
                },
                {
                    label: "文献网络（先期 / 衍生）",
                    action: () => {
                        const record = host.store.state.zotero.items.find(entry => entry.key === itemKey);
                        const csl = (record?.csl || {}) as Record<string, any>;
                        const doi = String(csl.DOI || record?.doi || "");
                        const title = String(record?.title || csl.title || "");
                        if (!doi && !title) {
                            showMessage("该条目没有 DOI 或标题，无法建立网络", 3000);
                            return;
                        }
                        openGraph(host, {doi, title});
                    },
                },
                ...(attachment ? [{label: "打开 PDF", action: () => host.openAttachment(attachment)}] : []),
            ]);
            return;
        }
        const attachment = host.store.getAttachment(target.dataset.attachmentId || "");
        if (!attachment) return;
        const translations = translationsForAttachment(attachment.id);
        const itemKey = attachment.zotero?.itemKey || host.store.getBook(attachment.bookId)?.zoteroKey || "";
        const attachmentRecord = host.store.state.zotero.items.find(entry => entry.key === itemKey);
        const attachmentCsl = (attachmentRecord?.csl || {}) as Record<string, any>;
        const attachmentBook = host.store.getBook(attachment.bookId);
        const attachmentTitle = String(attachmentRecord?.title || attachmentBook?.title || attachment.fileName || "");
        const attachmentDoi = String(attachmentCsl.DOI || attachmentRecord?.doi || "");
        const attachmentAuthors = Array.isArray(attachmentRecord?.creators) ? attachmentRecord!.creators : [];
        const attachmentYear = attachmentRecord?.year || attachmentCsl.issued?.["date-parts"]?.[0]?.[0] || "";
        const attachmentVenue = String(attachmentCsl["container-title"] || "");
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
            ...metaMenuItems(metaKeyForAttachment(attachment)),
            {
                label: "复制",
                children: [
                    {label: "复制标题", disabled: !attachmentTitle, action: () => copyToClipboard(attachmentTitle, "标题")},
                    {label: "复制 DOI", disabled: !attachmentDoi, action: () => copyToClipboard(attachmentDoi, " DOI")},
                    {label: "复制作者", disabled: !attachmentAuthors.length, action: () => copyToClipboard(attachmentAuthors.join("; "), "作者")},
                    {label: "复制 BibTeX", disabled: !attachmentTitle, action: () => copyToClipboard(bibtexFromFields({
                        title: attachmentTitle,
                        authors: attachmentAuthors,
                        year: attachmentYear,
                        venue: attachmentVenue,
                        doi: attachmentDoi,
                    }), " BibTeX")},
                ],
            },
            {
                label: "文献网络（先期 / 衍生）",
                action: () => {
                    const record = host.store.state.zotero.items.find(entry => entry.key === itemKey);
                    const csl = (record?.csl || {}) as Record<string, any>;
                    const book = host.store.getBook(attachment.bookId);
                    const doi = String(csl.DOI || "");
                    const title = String(record?.title || book?.title || attachment.fileName || "");
                    if (!doi && !title) {
                        showMessage("这份 PDF 没有 DOI 或标题，无法建立网络", 3000);
                        return;
                    }
                    openGraph(host, {doi, title});
                },
            },
        ]);
    };
    element.addEventListener("contextmenu", onDockContextMenu, true);

}

import {openSettings as openSettingsFromDialog} from "./settings-dialog";

/** Opens the restructured settings dialog (5 pages, instant apply, search). */
export function openSettings(host: PluginHost): void {
    openSettingsFromDialog(host);
}
