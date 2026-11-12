import {Dialog, showMessage} from "siyuan";
import {PLUGIN_DISPLAY_NAME, VERSION} from "../constants";
import type {PluginHost} from "../host";
import {fileExists, getPathForFile, hasNodeFs, requireNode} from "../runtime";
import {CITATION_STYLES} from "../citation/csl";
import {TRANSLATION_SERVICE_TYPES, defaultTranslationServices} from "../translation/defaults";
import {TRANSLATION_TARGETS} from "../translation/service";
import {checkPdf2zhEnvironment, ensurePdf2zhServer, translationOutputDir} from "../translation/pdf2zh";
import {checkDoc2xEnvironment} from "../translation/doc2x";
import {syncTranslationHistory} from "../translation/history";
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
    });
    const pageSize = 12;
    const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
    dockFilter.page = Math.min(dockFilter.page, pageCount - 1);
    const pageItems = filteredItems.slice(dockFilter.page * pageSize, (dockFilter.page + 1) * pageSize);
    const zoteroItems = pageItems.map(item => `
<button class="pz-list-item" data-zotero-key="${escapeHtml(item.key)}" title="打开该文献的 PDF 附件">
  <div class="pz-item-title">${escapeHtml(item.title || "(无标题)")}</div>
  <div class="pz-item-meta">${escapeHtml(item.creators.join("; ") || "未知作者")}${item.year ? ` · ${escapeHtml(item.year)}` : ""} · ${escapeHtml(item.itemType)}</div>
</button>`).join("");
    const collectionOptions = `<option value="">全部 Collection</option>` + collections
        .map(collection => `<option value="${escapeHtml(collection.key)}" ${dockFilter.collection === collection.key ? "selected" : ""}>${escapeHtml(collection.name)}</option>`)
        .join("");
    const recentAttachments = host.store.recentAttachments();
    const attachmentCard = (attachment: (typeof recentAttachments)[number], current = false) => {
        const book = host.store.getBook(attachment.bookId);
        return `
<button class="pz-list-item pz-pdf-item${current ? " is-current" : ""}" data-attachment-id="${escapeHtml(attachment.id)}" title="${escapeHtml(attachment.path || attachment.fileName)}">
  <div class="pz-item-title">${escapeHtml(book?.title || attachment.fileName)}${current ? `<span class="pz-current-badge">当前</span>` : ""}</div>
  <div class="pz-item-meta">第 ${Math.max(1, attachment.lastPage || 1)} 页${attachment.lastOpenedAt ? ` · ${escapeHtml(formatTime(attachment.lastOpenedAt))}` : ""}</div>
</button>`;
    };
    const currentId = state.lastReaderAttachmentId;
    const readingAttachments = [
        ...(currentId && state.attachments[currentId] ? [state.attachments[currentId]] : []),
        ...recentAttachments.filter(item => item.id !== currentId),
    ].slice(0, 8);
    const readingItems = readingAttachments.map(item => attachmentCard(item, item.id === currentId)).join("");
    const recentItems = recentAttachments.slice(0, 20).map(item => attachmentCard(item, item.id === currentId)).join("");
    const translationOutputs = host.store.translationOutputs();
    const translationItems = translationOutputs.map(item => `
<button class="pz-list-item" data-translation-id="${escapeHtml(item.id)}" title="${escapeHtml(item.path)}">
  <div class="pz-item-title">${escapeHtml(item.fileName)}</div>
  <div class="pz-item-meta">${escapeHtml(item.provider === "doc2x" ? "Doc2X" : "PDF2zh")} · ${escapeHtml(item.mode)} · ${escapeHtml(formatTime(item.createdAt))}${item.sourceTitle ? ` · ${escapeHtml(item.sourceTitle)}` : ""}</div>
</button>`).join("");

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
  <div class="pz-view-heading"><div><strong>译文历史</strong><small>${translationOutputs.length} 个翻译 PDF</small></div><button data-act="open-translations-dir">打开目录</button></div>
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
}

export function openSettings(host: PluginHost): void {
    if (settingsDialog?.element.isConnected) {
        settingsDialog.element.querySelector<HTMLInputElement>('[data-field="baseUrl"]')?.focus();
        return;
    }
    document.querySelectorAll<HTMLElement>(".pz-settings-dialog").forEach(item => item.closest<HTMLElement>(".b3-dialog")?.remove());
    const dialog = new Dialog({
        title: `${PLUGIN_DISPLAY_NAME} · 设置`,
        content: `<div class="b3-dialog__content pz-settings-dialog" style="min-width:760px;max-height:78vh;overflow:hidden;padding:0">
  <div class="pz-settings-shell">
    <nav class="pz-settings-nav">
      <button data-settings-tab="zotero" class="is-active">Zotero 与阅读</button>
      <button data-settings-tab="selection">选区翻译</button>
      <button data-settings-tab="qa">PDF 问答</button>
      <button data-settings-tab="whole">整篇翻译</button>
      <button data-settings-tab="doc2x">Doc2X</button>
      <button data-settings-tab="pdf2zh">PDF2zh</button>
      <button data-settings-tab="automation">AI 自动化</button>
    </nav>
    <div class="pz-settings-pages">
  <section class="pz-settings-page is-active" data-settings-page="zotero">
  <div class="pz-muted" style="margin-bottom:8px">P0 只读取 Zotero 公开 Local API 和 PDF 原文件；不会写 Zotero SQLite，也不会修改 PDF。</div>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px">
    <span>Zotero Local API 地址</span>
    <input class="b3-text-field fn__block" data-field="baseUrl" value="${escapeHtml(host.store.state.settings.zoteroBaseUrl)}" />
  </label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px">
    <span>Zotero 数据目录（用于 storage: 附件路径；auto = 自动读取 Zotero prefs）</span>
    <input class="b3-text-field fn__block" data-field="dataDir" value="${escapeHtml(host.store.state.settings.zoteroDataDir)}" placeholder="自动检测，例如 E:\\Tools\\Zotero" />
  </label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px">
    <span>库 ID（个人库填 0）</span>
    <input class="b3-text-field fn__block" data-field="libraryId" value="${host.store.state.settings.zoteroLibraryId}" />
  </label>
  <div class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px">
    <span>悬浮预览触发方式（PDF 内链、PDF 标注、思源块链接）</span>
    <label><input type="radio" name="pzPreviewTrigger" value="hover" ${host.store.state.settings.previewTrigger !== "alt" ? "checked" : ""}/> 直接悬停</label>
    <label><input type="radio" name="pzPreviewTrigger" value="alt" ${host.store.state.settings.previewTrigger === "alt" ? "checked" : ""}/> 按住 Alt 再悬停</label>
  </div>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px">
    <span>摘录可见模板（支持 {text}、{page}、{title}；链接身份始终是结构化 annotation URL）</span>
    <textarea class="b3-text-field fn__block" data-field="excerptTemplate" rows="3" style="resize:vertical">${escapeHtml(host.store.state.settings.excerptTemplate || "{text}")}</textarea>
  </label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px">
    <span>默认引用样式（参考文献通过 CSL 引擎生成）</span>
    <select class="b3-select fn__block" data-field="citationStyle">
      ${Object.entries(CITATION_STYLES).map(([key, meta]) => `<option value="${key}" ${host.store.state.settings.defaultCitationStyle === key ? "selected" : ""}>${escapeHtml(meta.label)}</option>`).join("")}
    </select>
  </label>
  </section>
  <section class="pz-settings-page" data-settings-page="automation">
  <div class="pz-muted" style="margin-bottom:8px">笔记本 AI 自动摘要（后台，无界面按钮）</div>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
    <input type="checkbox" data-field="automationEnabled" ${host.store.state.settings.automationEnabled ? "checked" : ""}/>
    <span>启用自动摘要</span>
  </label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px">
    <span>目标笔记本 ID</span>
    <input class="b3-text-field fn__block" data-field="automationNotebookId" value="${escapeHtml(host.store.state.settings.automationNotebookId)}" />
  </label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px">
    <span>索引文档名</span>
    <input class="b3-text-field fn__block" data-field="automationIndexTitle" value="${escapeHtml(host.store.state.settings.automationIndexTitle)}" />
  </label>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
    <input type="checkbox" data-field="automationBackfill" ${host.store.state.settings.automationBackfill ? "checked" : ""}/>
    <span>首次运行处理已有文章</span>
  </label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px">
    <span>模型 ID（留空 = 思源当前 AI 模型）</span>
    <input class="b3-text-field fn__block" data-field="automationModelId" value="${escapeHtml(host.store.state.settings.automationModelId)}" />
  </label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px">
    <span>摘要字数上限</span>
    <input class="b3-text-field fn__block" data-field="automationMaxChars" value="${host.store.state.settings.automationMaxChars}" />
  </label>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
    <input type="checkbox" data-field="automationDebug" ${host.store.state.settings.automationDebug ? "checked" : ""}/>
    <span>调试日志（控制台）</span>
  </label>
  </section>
  <section class="pz-settings-page" data-settings-page="selection">
  <div class="pz-muted" style="margin-bottom:8px">PDF 选区翻译</div>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
    <input type="checkbox" data-field="translationEnabled" ${host.store.state.settings.translationEnabled ? "checked" : ""}/>
    <span>启用选区翻译</span>
  </label>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
    <input type="checkbox" data-field="translationAuto" ${host.store.state.settings.translationAuto ? "checked" : ""}/>
    <span>选中文本后自动翻译</span>
  </label>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
    <input type="checkbox" data-field="translationShowOriginal" ${host.store.state.settings.translationShowOriginal ? "checked" : ""}/>
    <span>译文中显示原文</span>
  </label>
  <div class="fn__flex" style="gap:8px;margin-bottom:10px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>目标语言</span>
      <select class="b3-select fn__block" data-field="translationTargetLang">
        ${TRANSLATION_TARGETS.map(code => `<option value="${escapeHtml(code)}" ${host.store.state.settings.translationTargetLang === code ? "selected" : ""}>${escapeHtml(code)}</option>`).join("")}
      </select>
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>最短字符</span>
      <input class="b3-text-field fn__block" data-field="translationMinChars" value="${host.store.state.settings.translationMinChars}" />
    </label>
  </div>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px">
    <span>当前翻译服务</span>
    <select class="b3-select fn__block" data-field="translationActiveService">
      ${(host.store.state.settings.translationServices || defaultTranslationServices()).map(service => `<option value="${escapeHtml(service.id)}" ${host.store.state.settings.translationActiveServiceId === service.id ? "selected" : ""}>${escapeHtml(service.name)}（${escapeHtml(service.type)}）</option>`).join("")}
    </select>
  </label>
  <button class="b3-button b3-button--outline fn__block" data-act="translation-services" style="margin-bottom:10px">配置翻译服务</button>
  </section>
  <section class="pz-settings-page" data-settings-page="qa">
  <div class="pz-muted" style="margin-bottom:8px">PDF 问答默认使用思源当前 AI；也可填写指定模型 ID。</div>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px">
    <span>插入笔记的 Q/A 块标题</span>
    <input class="b3-text-field fn__block" data-field="qaTitle" value="${escapeHtml(host.store.state.settings.qaTitle || "PDF 问答")}" />
  </label>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>AI 模型 ID（留空 = 思源当前模型）</span>
      <input class="b3-text-field fn__block" data-field="qaModelId" value="${escapeHtml(host.store.state.settings.qaModelId)}" />
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>默认上下文页数（前后）</span>
      <input class="b3-text-field fn__block" data-field="qaContextPages" value="${host.store.state.settings.qaContextPages}" />
    </label>
  </div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>历史保留天数</span>
      <input class="b3-text-field fn__block" data-field="qaHistoryDays" value="${host.store.state.settings.qaHistoryDays}" />
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>每个 PDF 最多会话数</span>
      <input class="b3-text-field fn__block" data-field="qaMaxThreadsPerPdf" value="${host.store.state.settings.qaMaxThreadsPerPdf}" />
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>会话列表位置</span>
      <select class="b3-select fn__block" data-field="qaSessionListPlacement">
        <option value="panel" ${host.store.state.settings.qaSessionListPlacement !== "drawer" ? "selected" : ""}>问答面板内</option>
        <option value="drawer" ${host.store.state.settings.qaSessionListPlacement === "drawer" ? "selected" : ""}>左侧抽屉</option>
      </select>
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>知识范围</span>
      <select class="b3-select fn__block" data-field="qaKnowledgeMode">
        <option value="auto" ${host.store.state.settings.qaKnowledgeMode !== "pdf" ? "selected" : ""}>PDF优先 + 通用知识</option>
        <option value="pdf" ${host.store.state.settings.qaKnowledgeMode === "pdf" ? "selected" : ""}>仅依据 PDF</option>
      </select>
    </label>
  </div>
  <div class="pz-muted" style="font-size:12px">默认范围：有选区时带选区，否则带当前页及前后文；“问全文”在问答面板中切换。</div>
  <div class="pz-muted" style="margin:10px 0 6px;border-top:1px solid var(--b3-border-color);padding-top:10px">插入笔记的 Q/A 块样式</div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>圆角（px）</span>
      <input class="b3-text-field fn__block" type="number" min="0" max="24" data-field="qaBlockRadius" value="${host.store.state.settings.qaBlockRadius}" />
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>字体</span>
      <select class="b3-select fn__block" data-field="qaFontFamily">
        ${(() => {
            const current = host.store.state.settings.qaFontFamily || "";
            const fonts = [["", "默认（继承正文）"], ["system-ui", "系统无衬线"], ["Microsoft YaHei", "微软雅黑"], ["SimSun", "宋体"], ["SimHei", "黑体"], ["KaiTi", "楷体"], ["DengXian", "等线"], ["Source Han Sans SC", "思源黑体"], ["Source Han Serif SC", "思源宋体"], ["serif", "衬线体"], ["monospace", "等宽字体"]];
            if (current && !fonts.some(([value]) => value === current)) fonts.push([current, current]);
            return fonts.map(([value, label]) => `<option value="${escapeHtml(value)}" ${current === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
        })()}
      </select>
    </label>
  </div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>边框颜色</span><input type="color" data-field="qaBlockBorderColor" value="${host.store.state.settings.qaBlockBorderColor}" style="width:100%;height:28px" /></label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>背景颜色</span><input type="color" data-field="qaBlockBackground" value="${host.store.state.settings.qaBlockBackground}" style="width:100%;height:28px" /></label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>标题颜色</span><input type="color" data-field="qaTitleColor" value="${host.store.state.settings.qaTitleColor}" style="width:100%;height:28px" /></label>
  </div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>Q 颜色</span><input type="color" data-field="qaQuestionColor" value="${host.store.state.settings.qaQuestionColor}" style="width:100%;height:28px" /></label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>A 颜色</span><input type="color" data-field="qaAnswerColor" value="${host.store.state.settings.qaAnswerColor}" style="width:100%;height:28px" /></label>
  </div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>Q 字号（px）</span><input class="b3-text-field fn__block" type="number" min="10" max="24" data-field="qaQuestionFontSize" value="${host.store.state.settings.qaQuestionFontSize}" /></label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>A 字号（px）</span><input class="b3-text-field fn__block" type="number" min="10" max="24" data-field="qaAnswerFontSize" value="${host.store.state.settings.qaAnswerFontSize}" /></label>
  </div>
  <div class="pz-qa-preview" data-role="qa-preview">
    <div class="pz-qa-preview-title" data-preview="title">PDF 问答</div>
    <div class="pz-qa-preview-q"><strong>Q</strong> 文章中的方法为什么这样设计？</div>
    <div class="pz-qa-preview-a"><strong>A</strong> 这是实时预览，最终样式会应用到插入的笔记块。</div>
  </div>
  </section>
  <section class="pz-settings-page" data-settings-page="whole">
  <div class="pz-muted" style="margin-bottom:8px">整篇 PDF 翻译</div>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px">
    <span>翻译提供方</span>
    <select class="b3-select fn__block" data-field="wholeTranslationProvider">
      <option value="pdf2zh" ${host.store.state.settings.wholeTranslationProvider !== "doc2x" ? "selected" : ""}>PDF2zh（本地）</option>
      <option value="doc2x" ${host.store.state.settings.wholeTranslationProvider === "doc2x" ? "selected" : ""}>Doc2X（个人账号）</option>
    </select>
  </label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px">
    <span>译文保存目录（留空 = 插件数据目录）</span>
    <div class="fn__flex" style="gap:6px">
      <input class="b3-text-field fn__block" data-field="translationOutputDir" value="${escapeHtml(host.store.state.settings.translationOutputDir)}" placeholder="选择一个专门存放译文 PDF 的文件夹" />
      <button class="b3-button b3-button--outline" data-act="pick-translation-dir">选择文件夹</button>
    </div>
  </label>
  </section>
  <section class="pz-settings-page" data-settings-page="doc2x">
  <div class="pz-muted" style="margin-bottom:8px">Doc2X 使用官方 CLI，首次需要在本机运行一次 <code>doc2x login</code>；之后可后台直接调用，不需要打开 Doc2X 客户端。</div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>Doc2X CLI 命令</span>
      <input class="b3-text-field fn__block" data-field="doc2xCommand" value="${escapeHtml(host.store.state.settings.doc2xCommand)}" placeholder="doc2x" />
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>鉴权模式</span>
      <select class="b3-select fn__block" data-field="doc2xAuthMode">
        <option value="oauth" ${host.store.state.settings.doc2xAuthMode !== "client" ? "selected" : ""}>oauth（无需客户端）</option>
        <option value="client" ${host.store.state.settings.doc2xAuthMode === "client" ? "selected" : ""}>client（需客户端）</option>
      </select>
    </label>
  </div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>目标语言</span>
      <select class="b3-select fn__block" data-field="doc2xTargetLang">
        ${["zh", "en", "ja", "fr", "ru", "pt", "es", "de", "ko", "ar"].map(code => `<option value="${code}" ${host.store.state.settings.doc2xTargetLang === code ? "selected" : ""}>${code}</option>`).join("")}
      </select>
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>输出</span>
      <select class="b3-select fn__block" data-field="doc2xOutputMode">
        <option value="dualPdf" ${host.store.state.settings.doc2xOutputMode !== "translatedPdf" ? "selected" : ""}>双语双栏 PDF</option>
        <option value="translatedPdf" ${host.store.state.settings.doc2xOutputMode === "translatedPdf" ? "selected" : ""}>纯译文 PDF（重排）</option>
      </select>
    </label>
  </div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>翻译模型</span>
      <select class="b3-select fn__block" data-field="doc2xModel">
        <option value="">默认（Free / 10001）</option>
        ${host.store.state.settings.doc2xModel ? `<option value="${escapeHtml(host.store.state.settings.doc2xModel)}" selected>${escapeHtml(host.store.state.settings.doc2xModel)}</option>` : ""}
      </select>
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>术语表</span>
      <select class="b3-select fn__block" data-field="doc2xTermId">
        <option value="">不使用术语表</option>
        ${host.store.state.settings.doc2xTermId ? `<option value="${escapeHtml(host.store.state.settings.doc2xTermId)}" selected>${escapeHtml(host.store.state.settings.doc2xTermId)}</option>` : ""}
      </select>
    </label>
  </div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>PDF 字体策略</span>
      <select class="b3-select fn__block" data-field="doc2xFontStrategy">
        <option value="global-consistent" ${host.store.state.settings.doc2xFontStrategy !== "page-optimal" ? "selected" : ""}>全局一致</option>
        <option value="page-optimal" ${host.store.state.settings.doc2xFontStrategy === "page-optimal" ? "selected" : ""}>单页优先</option>
      </select>
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>翻译时忽略</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap;padding-top:4px">
        ${[["table", "表格"], ["code", "代码"], ["figure", "图片"], ["reference", "文献"]].map(([value, label]) => `<label style="display:flex;align-items:center;gap:3px"><input type="checkbox" data-doc2x-ignore="${value}" ${(host.store.state.settings.doc2xIgnoreTypes || []).includes(value) ? "checked" : ""}/>${label}</label>`).join("")}
      </div>
    </label>
  </div>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
    <input type="checkbox" data-field="doc2xContextual" ${host.store.state.settings.doc2xContextual ? "checked" : ""}/>
    <span>上下文增强（会员）</span>
  </label>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
    <input type="checkbox" data-field="doc2xFontColor" ${host.store.state.settings.doc2xFontColor ? "checked" : ""}/>
    <span>保留原 PDF 字体颜色</span>
  </label>
  <div class="pz-muted" style="font-size:11px;margin-bottom:6px">以上为 Doc2X CLI 支持的参数；标识符位置、双语 MD/HTML 输出、排版 Word 输出属于网页/客户端配置，CLI 没有对应参数。</div>
  <button class="b3-button b3-button--outline" data-act="doc2x-check" style="margin-bottom:6px">检测 Doc2X 环境 / 刷新模型</button>
  <div data-role="doc2x-env" class="pz-muted" style="font-size:12px;line-height:1.6;margin-bottom:8px"></div>
  </section>
  <section class="pz-settings-page" data-settings-page="pdf2zh">
  <div class="pz-muted" style="margin-bottom:8px">PDF2zh 设置（本地 Server）</div>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px">
    <span>PDF2zh 地址</span>
    <input class="b3-text-field fn__block" data-field="pdf2zhBaseUrl" value="${escapeHtml(host.store.state.settings.pdf2zhBaseUrl)}" placeholder="http://127.0.0.1:8890" />
  </label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:4px">
    <span>PDF2zh 服务目录（可选，自动启动）</span>
    <input class="b3-text-field fn__block" data-field="pdf2zhServerPath" value="${escapeHtml(host.store.state.settings.pdf2zhServerPath)}" placeholder="例如 D:\\SiYuan-PDF2zh-Portable\\pdf2zh-server" />
  </label>
  <button class="b3-button b3-button--outline" data-act="pdf2zh-check" style="margin-bottom:6px">检测 PDF2zh 环境</button>
  <div data-role="pdf2zh-env" class="pz-muted" style="font-size:12px;line-height:1.6;margin-bottom:8px"></div>
  <div class="pz-muted" style="font-size:12px;margin-bottom:10px">默认便携包使用 pdf2zh + Bing，无需 API Key；联网即可。整篇翻译按钮在 PDF 顶部工具栏。</div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>引擎</span>
      <select class="b3-select fn__block" data-field="pdf2zhEngine">
        <option value="pdf2zh_next" ${host.store.state.settings.pdf2zhEngine === "pdf2zh_next" ? "selected" : ""}>pdf2zh_next</option>
        <option value="pdf2zh" ${host.store.state.settings.pdf2zhEngine === "pdf2zh" ? "selected" : ""}>pdf2zh</option>
      </select>
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>服务名</span>
      <select class="b3-select fn__block" data-field="pdf2zhService">
        ${(() => {
            const current = (host.store.state.settings.pdf2zhService || "bing").toLowerCase();
            const known = ["bing", "google", "deepl", "deepseek", "openai", "siliconflowfree", "azure", "tencent", "qwen-mt", "ollama"];
            if (!known.includes(current)) known.push(current);
            return known.map(name => `<option value="${escapeHtml(name)}" ${current === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
        })()}
      </select>
    </label>
  </div>
  <div class="fn__flex" style="gap:8px;margin-bottom:8px">
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>目标语言</span>
      <select class="b3-select fn__block" data-field="pdf2zhTargetLang">
        ${TRANSLATION_TARGETS.map(code => `<option value="${escapeHtml(code)}" ${host.store.state.settings.pdf2zhTargetLang === code ? "selected" : ""}>${escapeHtml(code)}</option>`).join("")}
      </select>
    </label>
    <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px">
      <span>输出</span>
      <select class="b3-select fn__block" data-field="pdf2zhOutputMode">
        <option value="dual" ${host.store.state.settings.pdf2zhOutputMode === "dual" ? "selected" : ""}>双语对照</option>
        <option value="mono" ${host.store.state.settings.pdf2zhOutputMode === "mono" ? "selected" : ""}>纯译文</option>
      </select>
    </label>
  </div>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px">
    <span>对照方向</span>
    <select class="b3-select fn__block" data-field="pdf2zhDualMode">
      <option value="LR" ${host.store.state.settings.pdf2zhDualMode === "LR" ? "selected" : ""}>左右对照</option>
      <option value="TB" ${host.store.state.settings.pdf2zhDualMode === "TB" ? "selected" : ""}>上下对照</option>
    </select>
  </label>
  </section>
    </div>
  </div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-act="cancel">取消</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-act="save">保存</button>
</div>`,
        width: "900px",
    });
    settingsDialog = dialog;
    const settingsTabs = Array.from(dialog.element.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"));
    const settingsPages = Array.from(dialog.element.querySelectorAll<HTMLElement>("[data-settings-page]"));
    const activateSettingsPage = (name: string) => {
        for (const tab of settingsTabs) tab.classList.toggle("is-active", tab.dataset.settingsTab === name);
        for (const page of settingsPages) page.classList.toggle("is-active", page.dataset.settingsPage === name);
    };
    let doc2xAutoLoaded = false;
    for (const tab of settingsTabs) {
        tab.addEventListener("click", () => {
            const name = tab.dataset.settingsTab || "zotero";
            activateSettingsPage(name);
            // Opening the Doc2X page refreshes the official model/term lists once,
            // so the dropdowns are filled before the user changes anything.
            if (name === "doc2x" && !doc2xAutoLoaded) {
                doc2xAutoLoaded = true;
                dialog.element.querySelector<HTMLButtonElement>('[data-act="doc2x-check"]')?.click();
            }
        });
    }
    const baseUrl = dialog.element.querySelector<HTMLInputElement>('[data-field="baseUrl"]')!;
    const dataDir = dialog.element.querySelector<HTMLInputElement>('[data-field="dataDir"]')!;
    const libraryId = dialog.element.querySelector<HTMLInputElement>('[data-field="libraryId"]')!;
    const template = dialog.element.querySelector<HTMLTextAreaElement>('[data-field="excerptTemplate"]')!;
    const citationStyle = dialog.element.querySelector<HTMLSelectElement>('[data-field="citationStyle"]')!;
    const trigger = dialog.element.querySelector<HTMLInputElement>('input[name="pzPreviewTrigger"]:checked') as HTMLInputElement | null;
    const automationEnabled = dialog.element.querySelector<HTMLInputElement>('[data-field="automationEnabled"]')!;
    const automationNotebookId = dialog.element.querySelector<HTMLInputElement>('[data-field="automationNotebookId"]')!;
    const automationIndexTitle = dialog.element.querySelector<HTMLInputElement>('[data-field="automationIndexTitle"]')!;
    const automationBackfill = dialog.element.querySelector<HTMLInputElement>('[data-field="automationBackfill"]')!;
    const automationModelId = dialog.element.querySelector<HTMLInputElement>('[data-field="automationModelId"]')!;
    const automationMaxChars = dialog.element.querySelector<HTMLInputElement>('[data-field="automationMaxChars"]')!;
    const automationDebug = dialog.element.querySelector<HTMLInputElement>('[data-field="automationDebug"]')!;
    const translationEnabled = dialog.element.querySelector<HTMLInputElement>('[data-field="translationEnabled"]')!;
    const translationAuto = dialog.element.querySelector<HTMLInputElement>('[data-field="translationAuto"]')!;
    const translationShowOriginal = dialog.element.querySelector<HTMLInputElement>('[data-field="translationShowOriginal"]')!;
    const translationTargetLang = dialog.element.querySelector<HTMLSelectElement>('[data-field="translationTargetLang"]')!;
    const translationMinChars = dialog.element.querySelector<HTMLInputElement>('[data-field="translationMinChars"]')!;
    const translationActiveService = dialog.element.querySelector<HTMLSelectElement>('[data-field="translationActiveService"]')!;
    const qaTitle = dialog.element.querySelector<HTMLInputElement>('[data-field="qaTitle"]')!;
    const qaModelId = dialog.element.querySelector<HTMLInputElement>('[data-field="qaModelId"]')!;
    const qaContextPages = dialog.element.querySelector<HTMLInputElement>('[data-field="qaContextPages"]')!;
    const qaHistoryDays = dialog.element.querySelector<HTMLInputElement>('[data-field="qaHistoryDays"]')!;
    const qaMaxThreadsPerPdf = dialog.element.querySelector<HTMLInputElement>('[data-field="qaMaxThreadsPerPdf"]')!;
    const qaSessionListPlacement = dialog.element.querySelector<HTMLSelectElement>('[data-field="qaSessionListPlacement"]')!;
    const qaKnowledgeMode = dialog.element.querySelector<HTMLSelectElement>('[data-field="qaKnowledgeMode"]')!;
    const qaBlockRadius = dialog.element.querySelector<HTMLInputElement>('[data-field="qaBlockRadius"]')!;
    const qaFontFamily = dialog.element.querySelector<HTMLInputElement>('[data-field="qaFontFamily"]')!;
    const qaBlockBorderColor = dialog.element.querySelector<HTMLInputElement>('[data-field="qaBlockBorderColor"]')!;
    const qaBlockBackground = dialog.element.querySelector<HTMLInputElement>('[data-field="qaBlockBackground"]')!;
    const qaTitleColor = dialog.element.querySelector<HTMLInputElement>('[data-field="qaTitleColor"]')!;
    const qaQuestionColor = dialog.element.querySelector<HTMLInputElement>('[data-field="qaQuestionColor"]')!;
    const qaAnswerColor = dialog.element.querySelector<HTMLInputElement>('[data-field="qaAnswerColor"]')!;
    const qaQuestionFontSize = dialog.element.querySelector<HTMLInputElement>('[data-field="qaQuestionFontSize"]')!;
    const qaAnswerFontSize = dialog.element.querySelector<HTMLInputElement>('[data-field="qaAnswerFontSize"]')!;
    const qaPreview = dialog.element.querySelector<HTMLElement>('[data-role="qa-preview"]');
    const updateQaPreview = () => {
        if (!qaPreview) return;
        qaPreview.style.borderColor = qaBlockBorderColor.value;
        qaPreview.style.borderRadius = `${Math.max(0, Math.min(24, Number(qaBlockRadius.value) || 8))}px`;
        qaPreview.style.background = qaBlockBackground.value;
        qaPreview.style.fontFamily = qaFontFamily.value.trim();
        const title = qaPreview.querySelector<HTMLElement>('[data-preview="title"]');
        if (title) {
            title.textContent = qaTitle.value.trim() || "PDF 问答";
            title.style.color = qaTitleColor.value;
        }
        const q = qaPreview.querySelector<HTMLElement>(".pz-qa-preview-q");
        const a = qaPreview.querySelector<HTMLElement>(".pz-qa-preview-a");
        if (q) {
            q.style.color = qaQuestionColor.value;
            q.style.fontSize = `${Math.max(10, Math.min(24, Number(qaQuestionFontSize.value) || 13))}px`;
        }
        if (a) {
            a.style.color = qaAnswerColor.value;
            a.style.fontSize = `${Math.max(10, Math.min(24, Number(qaAnswerFontSize.value) || 14))}px`;
        }
    };
    [qaTitle, qaBlockRadius, qaFontFamily, qaBlockBorderColor, qaBlockBackground, qaTitleColor, qaQuestionColor, qaAnswerColor, qaQuestionFontSize, qaAnswerFontSize]
        .forEach(input => input.addEventListener("input", updateQaPreview));
    updateQaPreview();
    const pdf2zhBaseUrl = dialog.element.querySelector<HTMLInputElement>('[data-field="pdf2zhBaseUrl"]')!;
    const pdf2zhServerPath = dialog.element.querySelector<HTMLInputElement>('[data-field="pdf2zhServerPath"]')!;
    const pdf2zhEngine = dialog.element.querySelector<HTMLSelectElement>('[data-field="pdf2zhEngine"]')!;
    const pdf2zhService = dialog.element.querySelector<HTMLSelectElement>('[data-field="pdf2zhService"]')!;
    const pdf2zhTargetLang = dialog.element.querySelector<HTMLSelectElement>('[data-field="pdf2zhTargetLang"]')!;
    const pdf2zhOutputMode = dialog.element.querySelector<HTMLSelectElement>('[data-field="pdf2zhOutputMode"]')!;
    const pdf2zhDualMode = dialog.element.querySelector<HTMLSelectElement>('[data-field="pdf2zhDualMode"]')!;
    const pdf2zhEnv = dialog.element.querySelector<HTMLElement>('[data-role="pdf2zh-env"]')!;
    const wholeTranslationProvider = dialog.element.querySelector<HTMLSelectElement>('[data-field="wholeTranslationProvider"]')!;
    const translationOutputDirInput = dialog.element.querySelector<HTMLInputElement>('[data-field="translationOutputDir"]')!;
    dialog.element.querySelector('[data-act="pick-translation-dir"]')?.addEventListener("click", async () => {
        const selected = await pickDirectory();
        if (selected) translationOutputDirInput.value = selected;
    });
    const doc2xCommand = dialog.element.querySelector<HTMLInputElement>('[data-field="doc2xCommand"]')!;
    const doc2xAuthMode = dialog.element.querySelector<HTMLSelectElement>('[data-field="doc2xAuthMode"]')!;
    const doc2xTargetLang = dialog.element.querySelector<HTMLSelectElement>('[data-field="doc2xTargetLang"]')!;
    const doc2xOutputMode = dialog.element.querySelector<HTMLSelectElement>('[data-field="doc2xOutputMode"]')!;
    const doc2xModel = dialog.element.querySelector<HTMLSelectElement>('[data-field="doc2xModel"]')!;
    const doc2xTermId = dialog.element.querySelector<HTMLSelectElement>('[data-field="doc2xTermId"]')!;
    const doc2xFontStrategy = dialog.element.querySelector<HTMLSelectElement>('[data-field="doc2xFontStrategy"]')!;
    const doc2xContextual = dialog.element.querySelector<HTMLInputElement>('[data-field="doc2xContextual"]')!;
    const doc2xFontColor = dialog.element.querySelector<HTMLInputElement>('[data-field="doc2xFontColor"]')!;
    const doc2xIgnoreInputs = Array.from(dialog.element.querySelectorAll<HTMLInputElement>("[data-doc2x-ignore]"));
    const doc2xEnv = dialog.element.querySelector<HTMLElement>('[data-role="doc2x-env"]')!;
    dialog.element.querySelector('[data-act="doc2x-check"]')?.addEventListener("click", async () => {
        doc2xEnv.textContent = "检测中…";
        const result = await checkDoc2xEnvironment({
            ...host.store.state.settings,
            doc2xCommand: doc2xCommand.value.trim() || "doc2x",
            doc2xAuthMode: doc2xAuthMode.value === "client" ? "client" : "oauth",
        });
        const fill = (select: HTMLSelectElement, items: any[], emptyLabel: string, toValue: (item: any) => string, toLabel: (item: any) => string) => {
            const current = select.value;
            const options = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
            const seen = new Set<string>();
            for (const item of items || []) {
                const value = toValue(item);
                if (!value || seen.has(value)) continue;
                seen.add(value);
                options.push(`<option value="${escapeHtml(value)}" ${value === current ? "selected" : ""}>${escapeHtml(toLabel(item))}</option>`);
            }
            select.innerHTML = options.join("");
        };
        fill(doc2xModel, result.models || [], "默认（Free / 10001）", item => String(item?.modelId ?? item?.id ?? item?.name ?? ""), item => `${item?.displayName || item?.name || item?.modelId || ""} (${item?.modelId ?? item?.id ?? ""})`);
        fill(doc2xTermId, result.terms || [], "不使用术语表", item => String(item?.id ?? item?.termId ?? item?.name ?? ""), item => String(item?.name ?? item?.title ?? item?.id ?? ""));
        doc2xEnv.innerHTML = result.checks.map(item =>
            `<div>${item.ok ? "✓" : "✗"} ${escapeHtml(item.label)}：${escapeHtml(item.detail)}</div>`,
        ).join("") + (result.ok ? "<div>✓ Doc2X 已就绪，翻译时后台直接调用 CLI</div>" : "<div>✗ 首次使用请先运行 doc2x login</div>");
    });
    dialog.element.querySelector('[data-act="pdf2zh-check"]')?.addEventListener("click", async () => {
        pdf2zhEnv.textContent = "检测中…";
        const probe = {
            ...host.store.state.settings,
            pdf2zhBaseUrl: pdf2zhBaseUrl.value.trim() || "http://127.0.0.1:8890",
            pdf2zhServerPath: pdf2zhServerPath.value.trim(),
        };
        let result = await checkPdf2zhEnvironment(probe);
        let started = false;
        if (!result.health.ok && result.ok) {
            pdf2zhEnv.textContent = "环境完整，正在自动启动 PDF2zh…";
            const server = await ensurePdf2zhServer(probe);
            started = server.ok;
            result = await checkPdf2zhEnvironment(probe);
        }
        const legacy = result.health.ok && /pdf2zh-1\./i.test(result.health.version || "");
        if (legacy) {
            if (pdf2zhEngine.value !== "pdf2zh") pdf2zhEngine.value = "pdf2zh";
            if (!pdf2zhService.value.trim() || pdf2zhService.value.trim() === "siliconflowfree") pdf2zhService.value = "bing";
        }
        pdf2zhEnv.innerHTML = result.checks.map(item =>
            `<div>${item.ok ? "✓" : "✗"} ${escapeHtml(item.label)}：${escapeHtml(item.detail)}</div>`,
        ).join("") + (started ? "<div>✓ 已自动启动 PDF2zh 服务</div>" : "")
          + (legacy ? "<div>ℹ 检测到便携版 PDF2zh，已切换引擎为 pdf2zh、服务为 bing；请点击保存。</div>" : "");
    });
    dialog.element.querySelector('[data-act="translation-services"]')?.addEventListener("click", () => {
        openTranslationServiceSettings(host);
    });
    dialog.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => {
        dialog.destroy();
        settingsDialog = null;
    });
    dialog.element.querySelector('[data-act="save"]')?.addEventListener("click", async () => {
        host.store.updateSettings({
            zoteroBaseUrl: baseUrl.value.trim() || "http://127.0.0.1:23119",
            zoteroDataDir: dataDir.value.trim(),
            zoteroLibraryId: Number.parseInt(libraryId.value, 10) || 0,
            previewTrigger: trigger?.value === "alt" ? "alt" : "hover",
            excerptTemplate: template.value.trim() || "{text}",
            defaultCitationStyle: citationStyle.value as any,
            automationEnabled: automationEnabled.checked,
            automationNotebookId: automationNotebookId.value.trim(),
            automationIndexTitle: automationIndexTitle.value.trim() || "📚 网页资源 · 文章索引",
            automationBackfill: automationBackfill.checked,
            automationModelId: automationModelId.value.trim(),
            automationMaxChars: Math.max(120, Number.parseInt(automationMaxChars.value, 10) || 450),
            automationDebug: automationDebug.checked,
            translationEnabled: translationEnabled.checked,
            translationAuto: translationAuto.checked,
            translationShowOriginal: translationShowOriginal.checked,
            translationTargetLang: translationTargetLang.value || "zh-CN",
            translationMinChars: Math.max(1, Number.parseInt(translationMinChars.value, 10) || 2),
            translationActiveServiceId: translationActiveService.value || "translation-siyuan-ai",
            qaTitle: qaTitle.value.trim() || "PDF 问答",
            qaModelId: qaModelId.value.trim(),
            qaContextPages: Math.max(1, Math.min(4, Number.parseInt(qaContextPages.value, 10) || 2)),
            qaHistoryDays: Math.max(1, Number.parseInt(qaHistoryDays.value, 10) || 15),
            qaMaxThreadsPerPdf: Math.max(1, Math.min(200, Number.parseInt(qaMaxThreadsPerPdf.value, 10) || 50)),
            qaSessionListPlacement: qaSessionListPlacement.value === "drawer" ? "drawer" : "panel",
            qaKnowledgeMode: qaKnowledgeMode.value === "pdf" ? "pdf" : "auto",
            qaBlockRadius: Math.max(0, Math.min(24, Number.parseInt(qaBlockRadius.value, 10) || 8)),
            qaFontFamily: qaFontFamily.value.trim(),
            qaBlockBorderColor: qaBlockBorderColor.value || "#d7dcef",
            qaBlockBackground: qaBlockBackground.value || "#f7f8fd",
            qaTitleColor: qaTitleColor.value || "#4f63d2",
            qaQuestionColor: qaQuestionColor.value || "#2563eb",
            qaAnswerColor: qaAnswerColor.value || "#15803d",
            qaQuestionFontSize: Math.max(10, Math.min(24, Number.parseInt(qaQuestionFontSize.value, 10) || 13)),
            qaAnswerFontSize: Math.max(10, Math.min(24, Number.parseInt(qaAnswerFontSize.value, 10) || 14)),
            pdf2zhBaseUrl: pdf2zhBaseUrl.value.trim() || "http://127.0.0.1:8890",
            pdf2zhServerPath: pdf2zhServerPath.value.trim(),
            pdf2zhEngine: pdf2zhEngine.value === "pdf2zh" ? "pdf2zh" : "pdf2zh_next",
            pdf2zhService: pdf2zhService.value.trim() || "siliconflowfree",
            pdf2zhTargetLang: pdf2zhTargetLang.value || "zh-CN",
            pdf2zhOutputMode: pdf2zhOutputMode.value === "mono" ? "mono" : "dual",
            pdf2zhDualMode: pdf2zhDualMode.value === "TB" ? "TB" : "LR",
            wholeTranslationProvider: wholeTranslationProvider.value === "doc2x" ? "doc2x" : "pdf2zh",
            doc2xCommand: doc2xCommand.value.trim() || "doc2x",
            doc2xAuthMode: doc2xAuthMode.value === "client" ? "client" : "oauth",
            doc2xTargetLang: doc2xTargetLang.value || "zh",
            doc2xOutputMode: doc2xOutputMode.value === "translatedPdf" ? "translatedPdf" : "dualPdf",
            doc2xModel: doc2xModel.value.trim(),
            doc2xTermId: doc2xTermId.value.trim(),
            doc2xFontStrategy: doc2xFontStrategy.value === "page-optimal" ? "page-optimal" : "global-consistent",
            doc2xContextual: doc2xContextual.checked,
            translationOutputDir: translationOutputDirInput.value.trim(),
            doc2xFontColor: doc2xFontColor.checked,
            doc2xIgnoreTypes: doc2xIgnoreInputs.filter(input => input.checked).map(input => input.dataset.doc2xIgnore || "").filter(Boolean),
        });
        await host.store.save();
        host.restartAutomation();
        dialog.destroy();
        settingsDialog = null;
        host.refreshDock();
        applyQaBlockTheme(host.store.state.settings);
        void syncTranslationHistory(host);
        showMessage("设置已保存");
    });
}

export function openTranslationServiceSettings(host: PluginHost): void {
    const settings = host.store.state.settings;
    const services = settings.translationServices?.length ? settings.translationServices : defaultTranslationServices();
    const dialog = new Dialog({
        title: "翻译服务配置",
        width: "680px",
        content: `<div class="b3-dialog__content" style="max-height:70vh;overflow:auto">
  <div class="pz-muted" style="margin-bottom:10px">可配置多个服务；在插件设置中选择当前使用的服务。API Key 保存在插件本地状态中。</div>
  ${services.map((service, index) => `<details class="pz-translation-service" data-translation-index="${index}" ${service.id === settings.translationActiveServiceId ? "open" : ""} style="margin-bottom:8px;border:1px solid var(--b3-border-color);border-radius:8px;padding:8px">
    <summary style="cursor:pointer">${escapeHtml(service.name || service.type)} <span class="pz-muted">· ${escapeHtml(TRANSLATION_SERVICE_TYPES.find(item => item.type === service.type)?.label || service.type)}</span></summary>
    <label style="display:flex;align-items:center;gap:6px;margin:8px 0">
      <input type="checkbox" data-t-field="enabled" ${service.enabled ? "checked" : ""}/> 启用
    </label>
    <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:6px"><span>名称</span><input class="b3-text-field fn__block" data-t-field="name" value="${escapeHtml(service.name)}"/></label>
    <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:6px"><span>Base URL（留空使用默认）</span><input class="b3-text-field fn__block" data-t-field="baseURL" value="${escapeHtml(service.baseURL)}"/></label>
    <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:6px"><span>API Key / 凭证</span><input class="b3-text-field fn__block" data-t-field="apiKey" type="password" value="${escapeHtml(service.apiKey)}"/></label>
    <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:6px"><span>模型（OpenAI/思源 AI）</span><input class="b3-text-field fn__block" data-t-field="model" value="${escapeHtml(service.model)}"/></label>
    <div class="pz-muted" style="font-size:11px">${escapeHtml(serviceHint(service.type))}</div>
  </details>`).join("")}
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="save">保存</button></div>`,
    });
    dialog.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector('[data-act="save"]')?.addEventListener("click", async () => {
        const cards = Array.from(dialog.element.querySelectorAll<HTMLElement>("[data-translation-index]"));
        const next = services.map((service, index) => {
            const card = cards[index];
            if (!card) return service;
            const field = (name: string) => card.querySelector<HTMLInputElement>(`[data-t-field="${name}"]`)?.value || "";
            return {
                ...service,
                enabled: Boolean(card.querySelector<HTMLInputElement>('[data-t-field="enabled"]')?.checked),
                name: field("name").trim() || service.name,
                baseURL: field("baseURL").trim(),
                apiKey: field("apiKey").trim(),
                model: field("model").trim(),
            };
        });
        host.store.updateSettings({translationServices: next});
        await host.store.save();
        dialog.destroy();
        host.refreshDock();
        showMessage("翻译服务已保存");
    });
}

function serviceHint(type: string): string {
    const hints: Record<string, string> = {
        "siyuan-ai": "使用思源当前 AI provider；模型留空则跟随当前模型。",
        openai: "OpenAI/DeepSeek/硅基流动等兼容接口；Base URL 写到 /v1。",
        deepl: "填入 DeepL Auth Key；免费版 Base URL 为 https://api-free.deepl.com/v2。",
        google: "免费网页接口无需 Key；也可填入 Google API Key。",
        baidu: "凭证格式：appid#secret。",
        youdao: "凭证格式：appKey#appSecret。",
        tencent: "凭证格式：secretId#secretKey#region。",
        aliyun: "凭证格式：accessKeyId#accessKeySecret。",
        azure: "凭证格式：key#region。",
        caiyun: "填入彩云小译 token。",
    };
    return hints[type] || "按服务商文档填写凭证。";
}
