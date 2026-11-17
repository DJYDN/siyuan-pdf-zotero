import {Dialog, showMessage} from "siyuan";
import {PLUGIN_DISPLAY_NAME} from "../constants";
import type {PluginHost} from "../host";
import {requireNode} from "../runtime";
import {citationStyleOptions, openCitationStylePicker} from "./style-picker";
import {TRANSLATION_SERVICE_TYPES, defaultTranslationServices} from "../translation/defaults";
import {TRANSLATION_TARGETS, translateText} from "../translation/service";
import {checkPdf2zhEnvironment, ensurePdf2zhServer} from "../translation/pdf2zh";
import {checkDoc2xEnvironment, fetchDoc2xModelList} from "../translation/doc2x";
import {checkOcrEngineEnvironment, checkOcrEnvironment, ensureOcrEngine, restartOcrEngine, stopOcrEngine} from "../ocr/service";
import {defaultFormulaOrder, engineConfig, isOcrEngineId, normalizeDirKey, OCR_ENGINE_DEFS, OCR_ENGINE_IDS} from "../ocr/engines";
import {detectOcrBundle, detectPdf2zhServer, discoverBundles, isBundleCompatible, readBundleLogTail} from "../ocr/bundles";
import {getOcrHealth} from "../ocr/client";
import type {OcrEngineConfig, OcrEngineId, OcrEngineMap, Settings, TranslationServiceConfig} from "../types";
import {applyQaBlockTheme} from "../qa/theme";
import {syncTranslationHistory} from "../translation/history";
import {effectiveTargetLang} from "../translation/target-lang";

declare const __PZ_REPO_ROOT__: string;

let settingsDialog: Dialog | null = null;

function escapeHtml(text: string): string {
    return String(text ?? "").replace(/[&<>"']/g, ch => ({
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
        input.webkitdirectory = true;
        input.style.display = "none";
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            const relative = file?.webkitRelativePath || "";
            const dir = relative.split("/")[0];
            input.remove();
            resolve(dir || "");
        });
        document.body.append(input);
        input.click();
    });
}

const TARGET_LANG_OPTIONS = (selected: string): string => {
    const current = String(selected || "");
    return ['<option value="">跟随默认目标语言</option>']
        .concat(TRANSLATION_TARGETS.map(code => `<option value="${escapeHtml(code)}" ${current === code ? "selected" : ""}>${escapeHtml(code)}</option>`))
        .join("");
};

const DOC2X_TARGETS = ["zh", "en", "ja", "fr", "ru", "pt", "es", "de", "ko", "ar"];

function serviceHint(type: string): string {
    const hints: Record<string, string> = {
        "siyuan-ai": "使用思源当前 AI provider；模型留空则跟随当前模型。",
        openai: "OpenAI/DeepSeek/硅基流动等兼容接口；Base URL 写到 /v1。",
        deepl: "填入 DeepL Auth Key；免费版 Base URL 为 https://api-free.deepl.com/v2。",
        google: "免费网页接口无需 Key；也可填入 Google API Key。",
        bing: "免费网页接口，无需 Key；Base URL 默认 https://www.bing.com/translator。",
        mymemory: "免费接口，无需 Key；有每日字符额度，适合轻量划词。",
        baidu: "凭证格式：appid#secret。",
        youdao: "凭证格式：appKey#appSecret。",
        tencent: "凭证格式：secretId#secretKey#region。",
        aliyun: "凭证格式：accessKeyId#accessKeySecret。",
        azure: "凭证格式：key#region。",
        caiyun: "填入彩云小译 token。",
    };
    return hints[type] || "按服务商文档填写凭证。";
}

function ocrEngineCardHtml(id: OcrEngineId, settings: Settings): string {
    const def = OCR_ENGINE_DEFS[id];
    const config = engineConfig(settings, id);
    return `<div class="pz-engine-card" data-ocr-engine="${id}" data-apply="true">
    <div class="pz-engine-head">
      <label class="pz-engine-toggle"><input type="checkbox" data-engine-field="enabled" ${config.enabled ? "checked" : ""}/> <strong>${escapeHtml(def.name)}</strong></label>
      <span class="pz-muted" style="font-size:11px">${escapeHtml(def.summary)} · 默认端口 ${def.defaultPort}</span>
      <span class="pz-engine-status" data-role="engine-status">未检测</span>
      <span class="pz-muted pz-shared-port" data-role="shared-port" hidden style="font-size:11px"></span>
    </div>
    <div class="fn__flex" style="gap:6px;margin-top:6px">
      <input class="b3-text-field fn__block" data-engine-field="dir" value="${escapeHtml(config.dir)}" placeholder="${escapeHtml(def.dirHint)}" style="flex:1" />
      <button class="b3-button b3-button--outline" data-act="engine-pick-dir" style="flex:0 0 auto">选择目录</button>
    </div>
    <div class="fn__flex" style="gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap">
      <label class="fn__flex" style="align-items:center;gap:4px"><span>端口</span><input class="b3-text-field" type="number" data-engine-field="port" value="${config.port}" style="width:80px" /></label>
      <label class="fn__flex" style="align-items:center;gap:4px"><input type="checkbox" data-engine-field="autoStart" ${config.autoStart ? "checked" : ""}/> 自动启动</label>
      <button class="b3-button b3-button--outline" data-act="engine-check">检测</button>
      <button class="b3-button b3-button--outline" data-act="engine-start">启动</button>
      <button class="b3-button b3-button--outline" data-act="engine-stop">停止</button>
      <button class="b3-button b3-button--outline" data-act="engine-restart">重启</button>
    </div>
    <div data-role="engine-env" class="pz-muted" style="font-size:11px;line-height:1.6;margin-top:4px"></div>
  </div>`;
}

function ocrRoutingHtml(settings: Settings): string {
    const order = Array.isArray(settings.ocrFormulaOrder) && settings.ocrFormulaOrder.length
        ? settings.ocrFormulaOrder
        : defaultFormulaOrder();
    const formulaEngines = OCR_ENGINE_IDS.filter(id => OCR_ENGINE_DEFS[id].capabilities.formula);
    const prioritySelects = [0, 1, 2].map(index => {
        const current = order[index] || "";
        const options = [`<option value="">不使用</option>`]
            .concat(formulaEngines.map(id => `<option value="${id}" ${current === id ? "selected" : ""}>${escapeHtml(OCR_ENGINE_DEFS[id].name)}</option>`))
            .join("");
        return `<label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>公式第 ${index + 1} 优先</span><select class="b3-select fn__block" data-role="formula-order">${options}</select></label>`;
    }).join("");
    const textEngines = OCR_ENGINE_IDS.filter(id => OCR_ENGINE_DEFS[id].capabilities.text);
    const textEngine = settings.ocrTextEngine && textEngines.includes(settings.ocrTextEngine) ? settings.ocrTextEngine : textEngines[0];
    return `<div class="fn__flex" style="gap:8px;margin-bottom:8px">${prioritySelects}</div>
    <div class="fn__flex" style="gap:8px">
      <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>文本 / 混合引擎</span><select class="b3-select fn__block" data-role="text-engine">${textEngines.map(id => `<option value="${id}" ${textEngine === id ? "selected" : ""}>${escapeHtml(OCR_ENGINE_DEFS[id].name)}</option>`).join("")}</select></label>
    </div>
    <div class="pz-help">公式识别按上面的优先级依次尝试，失败会自动降级到下一个已启用的引擎。</div>`;
}

const COPY_FORMATS: Array<{value: Settings["ocrAutoCopyFormat"]; label: string}> = [
    {value: "latex", label: "LaTeX"},
    {value: "inline", label: "$...$"},
    {value: "display", label: "$$...$$"},
    {value: "paren", label: "\\(...\\)"},
    {value: "bracket", label: "\\[...\\]"},
    {value: "align", label: "align"},
    {value: "equation", label: "equation"},
    {value: "typst", label: "Typst"},
    {value: "mathml", label: "MathML"},
];

const TRANSLATION_SERVICE_HTML = (services: TranslationServiceConfig[], activeId: string): string => `
  <div class="pz-service-list" data-role="service-list">
    ${services.map((service, index) => `<div class="pz-service-row" data-service-index="${index}">
      <label class="fn__flex" style="align-items:center;gap:6px;flex:1;min-width:0">
        <input type="radio" name="pzActiveService" value="${escapeHtml(service.id)}" ${service.id === activeId ? "checked" : ""}/>
        <strong>${escapeHtml(service.name)}</strong>
        <span class="pz-muted" style="font-size:11px">${escapeHtml(TRANSLATION_SERVICE_TYPES.find(item => item.type === service.type)?.label || service.type)}</span>
      </label>
      <label class="fn__flex" style="align-items:center;gap:4px"><input type="checkbox" data-service-field="enabled" ${service.enabled ? "checked" : ""}/> 启用</label>
      <button class="b3-button b3-button--outline" data-act="service-edit" data-service-index="${index}">编辑</button>
      <button class="b3-button b3-button--outline" data-act="service-test" data-service-index="${index}">测试连接</button>
    </div>`).join("")}
  </div>
  <div class="pz-help">修改名称 / 地址 / 密钥请点「编辑」，保存后立即生效。当前选中的服务用于选区翻译。</div>`;

const QA_STYLE_HTML = (settings: Settings, fonts: string[][]): string => `
  <div class="pz-qa-preview" data-role="qa-preview">
    <div class="pz-qa-preview-title" data-preview="title">${escapeHtml(settings.qaTitle || "PDF 问答")}</div>
    <div class="pz-qa-preview-q"><strong>Q</strong> 文章中的方法为什么这样设计？</div>
    <div class="pz-qa-preview-a"><strong>A</strong> 这是实时预览，最终样式会应用到插入的笔记块。</div>
  </div>`;

export function openSettings(host: PluginHost): void {
    if (settingsDialog?.element.isConnected) {
        settingsDialog.element.querySelector<HTMLInputElement>('[data-role="settings-search"]')?.focus();
        return;
    }
    document.querySelectorAll<HTMLElement>(".pz-settings-dialog").forEach(item => item.closest<HTMLElement>(".b3-dialog")?.remove());
    const settings = host.store.state.settings;
    const services = settings.translationServices?.length ? settings.translationServices : defaultTranslationServices();
    const qaFonts: string[][] = [["", "默认（继承正文）"], ["system-ui", "系统无衬线"], ["Microsoft YaHei", "微软雅黑"], ["SimSun", "宋体"], ["SimHei", "黑体"], ["KaiTi", "楷体"], ["DengXian", "等线"], ["Source Han Sans SC", "思源黑体"], ["Source Han Serif SC", "思源宋体"], ["serif", "衬线体"], ["monospace", "等宽字体"]];
    if (settings.qaFontFamily && !qaFonts.some(([value]) => value === settings.qaFontFamily)) {
        qaFonts.push([settings.qaFontFamily, settings.qaFontFamily]);
    }

    const dialog = new Dialog({
        title: `${PLUGIN_DISPLAY_NAME} · 设置`,
        width: "980px",
        content: `<div class="b3-dialog__content pz-settings-dialog" style="padding:0">
  <div class="pz-settings-searchbar">
    <input class="b3-text-field fn__block" data-role="settings-search" placeholder="搜索设置项（名称 / 路径 / 格式）" />
    <div class="pz-settings-search-results" data-role="search-results" hidden></div>
  </div>
  <div class="pz-settings-banner" data-role="apply-banner" hidden>有需要应用的修改（引擎目录 / 地址等） <button class="b3-button b3-button--text pz-settings-apply" data-act="apply">立即应用</button></div>
  <div class="pz-settings-shell">
    <nav class="pz-settings-nav">
      <button data-settings-tab="connection" class="is-active">连接与阅读</button>
      <button data-settings-tab="translation">翻译</button>
      <button data-settings-tab="ocr">OCR</button>
      <button data-settings-tab="ai">AI 与自动化</button>
      <button data-settings-tab="advanced">高级</button>
    </nav>
    <div class="pz-settings-pages">

  <section class="pz-settings-page is-active" data-settings-page="connection">
    <div class="pz-ocr-section">
      <div class="pz-ocr-section-title">Zotero 连接</div>
      <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px"><span>Zotero Local API 地址</span><input class="b3-text-field fn__block" data-field="baseUrl" value="${escapeHtml(settings.zoteroBaseUrl)}" /></label>
      <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px"><span>Zotero 数据目录</span><input class="b3-text-field fn__block" data-field="dataDir" value="${escapeHtml(settings.zoteroDataDir)}" placeholder="自动检测，例如 E:\\Tools\\Zotero" /><span class="pz-help">用于解析 storage: 附件路径；留空=自动读取 Zotero prefs。</span></label>
      <label class="fn__flex" style="flex-direction:column;gap:4px"><span>库 ID（个人库填 0）</span><input class="b3-text-field fn__block" data-field="libraryId" value="${settings.zoteroLibraryId}" /></label>
    </div>
    <div class="pz-ocr-section">
      <div class="pz-ocr-section-title">阅读与摘录</div>
      <div class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px">
        <span>悬浮预览触发方式（PDF 内链、PDF 标注、思源块链接）</span>
        <label><input type="radio" name="pzPreviewTrigger" value="hover" ${settings.previewTrigger !== "alt" ? "checked" : ""}/> 直接悬停</label>
        <label><input type="radio" name="pzPreviewTrigger" value="alt" ${settings.previewTrigger === "alt" ? "checked" : ""}/> 按住 Alt 再悬停</label>
      </div>
      <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:12px"><span>摘录可见模板</span><textarea class="b3-text-field fn__block" data-field="excerptTemplate" rows="3" style="resize:vertical">${escapeHtml(settings.excerptTemplate || "{text}")}</textarea><span class="pz-help">支持 {text}、{page}、{title}；链接身份始终是结构化 annotation URL。</span></label>
      <label class="fn__flex" style="flex-direction:column;gap:4px"><span>默认引用样式</span><select class="b3-select fn__block" data-field="citationStyle">${citationStyleOptions(settings.defaultCitationStyle)}</select><span class="pz-help">参考文献通过 CSL 引擎生成。</span></label>
    </div>
  </section>

  <section class="pz-settings-page" data-settings-page="translation">
    <div class="pz-subtabs">
      <button data-settings-subtab="selection" class="is-active">选区翻译</button>
      <button data-settings-subtab="whole">整篇翻译</button>
      <button data-settings-subtab="service">翻译服务</button>
    </div>
    <div class="pz-subpage is-active" data-settings-subpage="selection">
      <div class="pz-ocr-section">
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px"><input type="checkbox" data-field="translationEnabled" ${settings.translationEnabled ? "checked" : ""}/> 启用选区翻译</label>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px"><input type="checkbox" data-field="translationAuto" ${settings.translationAuto ? "checked" : ""}/> 选中文本后自动翻译</label>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px"><input type="checkbox" data-field="translationShowOriginal" ${settings.translationShowOriginal ? "checked" : ""}/> 译文中显示原文</label>
        <div class="fn__flex" style="gap:8px;margin-bottom:10px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>默认目标语言</span><select class="b3-select fn__block" data-field="translationDefaultTargetLang">${TRANSLATION_TARGETS.map(code => `<option value="${escapeHtml(code)}" ${settings.translationDefaultTargetLang === code ? "selected" : ""}>${escapeHtml(code)}</option>`).join("")}</select><span class="pz-help">所有翻译默认使用；下方各引擎可单独覆盖。</span></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>最短字符</span><input class="b3-text-field fn__block" data-field="translationMinChars" value="${settings.translationMinChars}" /></label>
        </div>
        <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px"><span>选区翻译目标语言</span><select class="b3-select fn__block" data-field="translationTargetLang">${TARGET_LANG_OPTIONS(settings.translationTargetLang)}</select></label>
        <label class="fn__flex" style="flex-direction:column;gap:4px"><span>当前翻译服务</span><select class="b3-select fn__block" data-field="translationActiveService">${services.map(service => `<option value="${escapeHtml(service.id)}" ${settings.translationActiveServiceId === service.id ? "selected" : ""}>${escapeHtml(service.name)}（${escapeHtml(service.type)}）</option>`).join("")}</select></label>
      </div>
    </div>
    <div class="pz-subpage" data-settings-subpage="whole">
      <div class="pz-ocr-section">
        <div class="pz-ocr-section-title">整篇翻译</div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>翻译提供方</span><select class="b3-select fn__block" data-field="wholeTranslationProvider">
            <option value="pdf2zh" ${settings.wholeTranslationProvider !== "doc2x" ? "selected" : ""}>PDF2zh（本地）</option>
            <option value="doc2x" ${settings.wholeTranslationProvider === "doc2x" ? "selected" : ""}>Doc2X（个人账号）</option>
          </select></label>
          <label class="fn__flex" style="flex:2;flex-direction:column;gap:4px"><span>译文保存目录（留空 = 插件数据目录）</span>
            <div class="fn__flex" style="gap:6px"><input class="b3-text-field fn__block" data-field="translationOutputDir" value="${escapeHtml(settings.translationOutputDir)}" placeholder="专门存放译文 PDF 的文件夹" style="flex:1"/><button class="b3-button b3-button--outline" data-act="pick-translation-dir">选择文件夹</button></div>
            <span class="pz-help">译文 PDF 与「译文历史」列表都使用这个目录；留空 = 插件数据目录。</span>
          </label>
        </div>
      </div>
      <details class="pz-ocr-section" open>
        <summary class="pz-ocr-section-title">PDF2zh（本地 Server）</summary>
        <div data-apply="true">
          <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>PDF2zh 地址</span><input class="b3-text-field fn__block" data-field="pdf2zhBaseUrl" value="${escapeHtml(settings.pdf2zhBaseUrl)}" placeholder="http://127.0.0.1:8890" /><span class="pz-help">修改后需点「立即应用」生效。</span></label>
          <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>PDF2zh 服务目录（可选，自动启动）</span><div class="fn__flex" style="gap:6px"><input class="b3-text-field fn__block" data-field="pdf2zhServerPath" value="${escapeHtml(settings.pdf2zhServerPath)}" placeholder="选择 SiYuan-PDF2zh-Portable 里的 pdf2zh-server 目录" style="flex:1" /><button class="b3-button b3-button--outline" data-act="pdf2zh-dir-pick" style="flex:0 0 auto">选择目录</button></div><span class="pz-help">指向便携包里的 pdf2zh-server 目录（含 pz_server.py）；留空则只连接已运行的地址。修改后需点「立即应用」。</span></label>
        </div>
        <button class="b3-button b3-button--outline" data-act="pdf2zh-check" style="margin-bottom:6px">检测 PDF2zh 环境</button><button class="b3-button b3-button--outline" data-act="pdf2zh-auto-index" style="margin-bottom:6px;margin-left:6px">自动检测目录</button>
        <div data-role="pdf2zh-env" class="pz-muted" style="font-size:12px;line-height:1.6;margin-bottom:8px"></div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>引擎</span><select class="b3-select fn__block" data-field="pdf2zhEngine"><option value="pdf2zh_next" ${settings.pdf2zhEngine === "pdf2zh_next" ? "selected" : ""}>pdf2zh_next</option><option value="pdf2zh" ${settings.pdf2zhEngine === "pdf2zh" ? "selected" : ""}>pdf2zh</option></select></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>服务名</span><select class="b3-select fn__block" data-field="pdf2zhService">${(() => {
            const current = (settings.pdf2zhService || "bing").toLowerCase();
            const known = ["bing", "google", "deepl", "deepseek", "openai", "siliconflowfree", "azure", "tencent", "qwen-mt", "ollama"];
            if (!known.includes(current)) known.push(current);
            return known.map(name => `<option value="${escapeHtml(name)}" ${current === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
          })()}</select></label>
        </div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>目标语言</span><select class="b3-select fn__block" data-field="pdf2zhTargetLang">${TARGET_LANG_OPTIONS(settings.pdf2zhTargetLang)}</select></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>输出</span><select class="b3-select fn__block" data-field="pdf2zhOutputMode"><option value="dual" ${settings.pdf2zhOutputMode === "dual" ? "selected" : ""}>双语对照</option><option value="mono" ${settings.pdf2zhOutputMode === "mono" ? "selected" : ""}>纯译文</option></select></label>
        </div>
        <div class="fn__flex" style="gap:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>源语言</span><select class="b3-select fn__block" data-field="pdf2zhSourceLang">${["en", "zh", "ja", "ko", "fr", "de", "es", "ru"].map(code => `<option value="${code}" ${(settings.pdf2zhSourceLang || "en") === code ? "selected" : ""}>${code}</option>`).join("")}</select></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px" data-role="pdf2zh-dual-row" ${settings.pdf2zhOutputMode === "dual" ? "" : "hidden"}><span>对照方向</span><select class="b3-select fn__block" data-field="pdf2zhDualMode"><option value="LR" ${settings.pdf2zhDualMode !== "TB" ? "selected" : ""}>左右对照</option><option value="TB" ${settings.pdf2zhDualMode === "TB" ? "selected" : ""}>上下对照</option></select></label>
        </div>
      </details>
      <details class="pz-ocr-section">
        <summary class="pz-ocr-section-title">Doc2X（个人账号）</summary>
        <div class="pz-help" style="margin-bottom:8px">首次需要在本机运行一次 doc2x login；之后后台直接调用 CLI，不需要打开 Doc2X 客户端。</div>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px"><input type="checkbox" data-field="doc2xConfigured" ${settings.doc2xConfigured ? "checked" : ""}/> 我已配置完成解析&amp;翻译设置（勾选后才能翻译/解析）</label>
        <div data-apply="true">
          <div class="fn__flex" style="gap:8px;margin-bottom:8px">
            <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>Doc2X CLI 命令</span><input class="b3-text-field fn__block" data-field="doc2xCommand" value="${escapeHtml(settings.doc2xCommand)}" placeholder="doc2x" /></label>
            <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>鉴权模式</span><select class="b3-select fn__block" data-field="doc2xAuthMode"><option value="oauth" ${settings.doc2xAuthMode !== "client" ? "selected" : ""}>oauth（无需客户端）</option><option value="client" ${settings.doc2xAuthMode === "client" ? "selected" : ""}>client（需客户端）</option></select></label>
          </div>
        </div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>目标语言</span><select class="b3-select fn__block" data-field="doc2xTargetLang">${['<option value="">跟随默认目标语言</option>'].concat(DOC2X_TARGETS.map(code => `<option value="${code}" ${settings.doc2xTargetLang === code ? "selected" : ""}>${code}</option>`)).join("")}</select></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>输出</span><select class="b3-select fn__block" data-field="doc2xOutputMode"><option value="translatedPdf" ${settings.doc2xOutputMode === "translatedPdf" ? "selected" : ""}>纯译文</option><option value="dualPdf" ${settings.doc2xOutputMode !== "translatedPdf" ? "selected" : ""}>对照翻译</option></select></label>
        </div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px" data-role="doc2x-dual-row">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>翻译类型</span><select class="b3-select fn__block" data-field="doc2xTranslateType"><option value="pdf" ${settings.doc2xTranslateType !== "md" ? "selected" : ""}>固定排版（双栏 PDF）</option><option value="md" ${settings.doc2xTranslateType === "md" ? "selected" : ""}>文档型（Markdown / Word）</option></select></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px" data-role="doc2x-font-row"><span>PDF 字体策略</span><select class="b3-select fn__block" data-field="doc2xFontStrategy"><option value="global-consistent" ${settings.doc2xFontStrategy !== "page-optimal" ? "selected" : ""}>全局一致</option><option value="page-optimal" ${settings.doc2xFontStrategy === "page-optimal" ? "selected" : ""}>单页优先</option></select></label>
        </div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>翻译模型</span><div style="display:flex;gap:5px"><select class="b3-select fn__block" data-field="doc2xModel" style="flex:1"><option value="">官方默认（Free）</option>${settings.doc2xModel ? `<option value="${escapeHtml(settings.doc2xModel)}" selected>${escapeHtml(settings.doc2xModel)}</option>` : ""}</select><button type="button" class="b3-button b3-button--outline" data-act="doc2x-refresh-models" style="flex:0 0 auto;font-size:11px;padding:3px 8px">刷新</button></div><span class="pz-help">读取自 doc2x models list，仅显示当前账号可用模型。</span></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>术语表</span><div style="display:flex;gap:5px"><select class="b3-select fn__block" data-field="doc2xTermId" style="flex:1"><option value="">不使用术语表</option>${settings.doc2xTermId ? `<option value="${escapeHtml(settings.doc2xTermId)}" selected>${escapeHtml(settings.doc2xTermId)}</option>` : ""}</select><button type="button" class="b3-button b3-button--outline" data-act="doc2x-refresh-terms" style="flex:0 0 auto;font-size:11px;padding:3px 8px">更新</button></div></label>
        </div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>解析模型 · 图片 OCR</span><select class="b3-select fn__block" data-field="doc2xParseImageModel"><option value="doc2x" ${settings.doc2xParseImageModel !== "mathpix" ? "selected" : ""}>doc2x</option><option value="mathpix" ${settings.doc2xParseImageModel === "mathpix" ? "selected" : ""}>mathpix（需权限）</option></select></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>解析模型 · 视觉模型</span><select class="b3-select fn__block" data-field="doc2xVisionModel"><option value="">不使用视觉模型</option>${settings.doc2xVisionModel ? `<option value="${escapeHtml(settings.doc2xVisionModel)}" selected>${escapeHtml(settings.doc2xVisionModel)}</option>` : ""}</select><span class="pz-help">用于 PDF→Markdown 解析；同样来自官方模型列表。</span></label>
        </div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <div class="fn__flex" style="flex-direction:column;gap:4px"><span>翻译时忽略</span><div style="display:flex;gap:8px;flex-wrap:wrap;padding-top:4px">${[["table", "表格"], ["code", "代码"], ["figure", "图片"], ["reference", "文献"]].map(([value, label]) => `<label style="display:flex;align-items:center;gap:3px"><input type="checkbox" data-doc2x-ignore="${value}" ${(settings.doc2xIgnoreTypes || []).includes(value) ? "checked" : ""}/>${label}</label>`).join("")}</div></div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><input type="checkbox" data-field="doc2xContextual" ${settings.doc2xContextual ? "checked" : ""}/> 上下文增强（会员）</label>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px"><input type="checkbox" data-field="doc2xFontColor" ${settings.doc2xFontColor ? "checked" : ""}/> 保留原 PDF 字体颜色</label>
        <button class="b3-button b3-button--outline" data-act="doc2x-check" style="margin-bottom:6px">检测 Doc2X 环境 / 刷新模型</button>
        <div data-role="doc2x-env" class="pz-muted" style="font-size:12px;line-height:1.6;margin-bottom:4px"></div>
        <div class="pz-help">翻译模型/解析模型均来自官方 doc2x models list，只显示当前账号可用项；对照翻译选择「文档型」时输出 Markdown 并插入笔记。PDF→Markdown 转换在 Dock 菜单：「解析PDF为Md到笔记」使用解析模型，「翻译PDF为Md到笔记」使用翻译模型。</div>
      </details>
    </div>
    <div class="pz-subpage" data-settings-subpage="service">
      <div class="pz-ocr-section">
        <div class="pz-ocr-section-title">翻译服务</div>
        ${TRANSLATION_SERVICE_HTML(services, settings.translationActiveServiceId)}
      </div>
    </div>
  </section>

  <section class="pz-settings-page" data-settings-page="ocr">
    <details class="pz-ocr-section" open>
      <summary class="pz-ocr-section-title">引擎与服务</summary>
      <div class="pz-help" style="margin-bottom:8px">每个引擎是独立本地服务：解压引擎包后选择目录即可。指向同一目录的引擎共用同一个服务进程（兼容旧版 OCR-Service-Portable）。修改目录/端口后点顶部「立即应用」。</div>
      ${OCR_ENGINE_IDS.map(id => ocrEngineCardHtml(id, settings)).join("")}
      <div data-apply="true">
        <label class="fn__flex" style="flex-direction:column;gap:4px;margin-top:8px"><span>共享 Python 运行时目录（可选）</span><div style="display:flex;gap:6px"><input class="b3-text-field fn__block" data-field="ocrSharedRuntimeDir" value="${escapeHtml(settings.ocrSharedRuntimeDir)}" placeholder="例如 D:\\SiYuan\\OCR-Runtime" style="flex:1" /><button class="b3-button b3-button--outline" data-act="ocr-shared-runtime-pick" style="flex:0 0 auto">选择目录</button></div><span class="pz-help">留空使用引擎包内自带 runtime。</span></label>
        <label class="fn__flex" style="flex-direction:column;gap:4px;margin-top:6px"><span>自定义启动命令（可选）</span><input class="b3-text-field fn__block" data-field="ocrStartCommand" value="${escapeHtml(settings.ocrStartCommand)}" placeholder="留空按目录内脚本自动启动" /><span class="pz-help">一般留空即可；只有引擎包启动脚本不标准时才填写。</span></label>
      </div>
      <div class="pz-ocr-actions" style="margin-top:8px"><button class="b3-button b3-button--outline" data-act="ocr-check">检测全部引擎</button><button class="b3-button b3-button--outline" data-act="ocr-auto-index">自动检测服务包</button></div>
      <div data-role="ocr-env" class="pz-muted" style="font-size:12px;line-height:1.6"></div>
    </details>
    <details class="pz-ocr-section">
      <summary class="pz-ocr-section-title">识别路由</summary>
      ${ocrRoutingHtml(settings)}
    </details>
    <details class="pz-ocr-section">
      <summary class="pz-ocr-section-title">行为与格式（全部引擎共用）</summary>
      <div class="fn__flex" style="gap:8px;margin-bottom:8px">
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>默认模式</span><select class="b3-select fn__block" data-field="ocrDefaultMode"><option value="auto" ${settings.ocrDefaultMode === "auto" ? "selected" : ""}>自动</option><option value="formula" ${settings.ocrDefaultMode === "formula" ? "selected" : ""}>公式</option><option value="text" ${settings.ocrDefaultMode === "text" ? "selected" : ""}>文本</option></select></label>
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>公式默认格式</span><select class="b3-select fn__block" data-field="ocrFormulaFormat"><option value="inline" ${settings.ocrFormulaFormat === "inline" ? "selected" : ""}>行内 $...$</option><option value="display" ${settings.ocrFormulaFormat === "display" ? "selected" : ""}>独立 $$...$$</option></select><span class="pz-help">插入笔记时使用：行内适合句内公式，独立适合单独成行。</span></label>
      </div>
      <div class="fn__flex" style="gap:8px;margin-bottom:8px">
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>默认后置动作</span><select class="b3-select fn__block" data-field="ocrDefaultAction"><option value="insert" ${settings.ocrDefaultAction === "insert" ? "selected" : ""}>插入光标</option><option value="replace" ${settings.ocrDefaultAction === "replace" ? "selected" : ""}>替换选区</option><option value="copy" ${settings.ocrDefaultAction === "copy" ? "selected" : ""}>复制</option><option value="append" ${settings.ocrDefaultAction === "append" ? "selected" : ""}>追加笔记</option></select></label>
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>识别语言</span><div style="display:flex;gap:10px;padding-top:4px"><label><input type="checkbox" data-ocr-lang="zh" ${settings.ocrLanguages?.includes("zh") ? "checked" : ""}/> 中文</label><label><input type="checkbox" data-ocr-lang="en" ${settings.ocrLanguages?.includes("en") ? "checked" : ""}/> 英文</label></div></label>
      </div>
      <div class="fn__flex" style="gap:8px;margin-bottom:8px">
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>历史条数</span><input class="b3-text-field fn__block" data-field="ocrHistoryLimit" value="${settings.ocrHistoryLimit}" /></label>
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>超时（毫秒）</span><input class="b3-text-field fn__block" type="number" data-field="ocrTimeoutMs" value="${settings.ocrTimeoutMs}" /></label>
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:12px"><input type="checkbox" data-field="ocrPreview" ${settings.ocrPreview ? "checked" : ""}/> 识别后先预览编辑</label>
      <div class="pz-ocr-section-title" style="margin-top:4px">OCR 弹窗默认值</div>
      <div class="fn__flex" style="gap:8px;margin-bottom:8px">
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>默认预览渲染器</span><select class="b3-select fn__block" data-role="preview-renderer"><option value="katex" ${settings.ocrPreviewRenderer !== "mathlive" ? "selected" : ""}>KaTeX（默认）</option><option value="mathlive" ${settings.ocrPreviewRenderer === "mathlive" ? "selected" : ""}>MathLive（可编辑）</option></select><span class="pz-help">弹窗里临时切换不会改默认值。</span></label>
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>默认复制格式</span><select class="b3-select fn__block" data-role="auto-copy-format" title="复制/自动复制使用的格式">${COPY_FORMATS.map(format => `<option value="${format.value}" ${settings.ocrAutoCopyFormat === format.value ? "selected" : ""}>${escapeHtml(format.label)}</option>`).join("")}</select></label>
      </div>
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" data-role="auto-copy" ${settings.ocrAutoCopy ? "checked" : ""}/> 识别完成后自动复制到剪贴板</label>
    </details>
  </section>

  <section class="pz-settings-page" data-settings-page="ai">
    <div class="pz-subtabs">
      <button data-settings-subtab="qa" class="is-active">PDF 问答</button>
      <button data-settings-subtab="automation">笔记本自动摘要</button>
    </div>
    <div class="pz-subpage is-active" data-settings-subpage="qa">
      <div class="pz-ocr-section">
        <div class="pz-ocr-section-title">问答行为</div>
        <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>插入笔记的 Q/A 块标题</span><input class="b3-text-field fn__block" data-field="qaTitle" value="${escapeHtml(settings.qaTitle || "PDF 问答")}" /></label>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>AI 模型 ID（留空 = 思源当前模型）</span><input class="b3-text-field fn__block" data-field="qaModelId" value="${escapeHtml(settings.qaModelId)}" /></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>默认上下文页数（前后）</span><input class="b3-text-field fn__block" data-field="qaContextPages" value="${settings.qaContextPages}" /></label>
        </div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>历史保留天数</span><input class="b3-text-field fn__block" data-field="qaHistoryDays" value="${settings.qaHistoryDays}" /></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>每个 PDF 最多会话数</span><input class="b3-text-field fn__block" data-field="qaMaxThreadsPerPdf" value="${settings.qaMaxThreadsPerPdf}" /></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>会话列表位置</span><select class="b3-select fn__block" data-field="qaSessionListPlacement"><option value="panel" ${settings.qaSessionListPlacement !== "drawer" ? "selected" : ""}>问答面板内</option><option value="drawer" ${settings.qaSessionListPlacement === "drawer" ? "selected" : ""}>左侧抽屉</option></select></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>知识范围</span><select class="b3-select fn__block" data-field="qaKnowledgeMode"><option value="auto" ${settings.qaKnowledgeMode !== "pdf" ? "selected" : ""}>PDF 优先 + 通用知识</option><option value="pdf" ${settings.qaKnowledgeMode === "pdf" ? "selected" : ""}>仅依据 PDF</option></select></label>
        </div>
        <div class="pz-help">默认范围：有选区时带选区，否则带当前页及前后文；“问全文”在问答面板中切换。</div>
      </div>
      <div class="pz-ocr-section">
        <div class="pz-ocr-section-title">插入笔记的 Q/A 块样式</div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>圆角（px）</span><input class="b3-text-field fn__block" type="number" min="0" max="24" data-field="qaBlockRadius" value="${settings.qaBlockRadius}" /></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>字体</span><select class="b3-select fn__block" data-field="qaFontFamily">${qaFonts.map(([value, label]) => `<option value="${escapeHtml(value)}" ${(settings.qaFontFamily || "") === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
        </div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>边框颜色</span><input type="color" data-field="qaBlockBorderColor" value="${settings.qaBlockBorderColor}" style="width:100%;height:28px" /></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>背景颜色</span><input type="color" data-field="qaBlockBackground" value="${settings.qaBlockBackground}" style="width:100%;height:28px" /></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>标题颜色</span><input type="color" data-field="qaTitleColor" value="${settings.qaTitleColor}" style="width:100%;height:28px" /></label>
        </div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>Q 颜色</span><input type="color" data-field="qaQuestionColor" value="${settings.qaQuestionColor}" style="width:100%;height:28px" /></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>A 颜色</span><input type="color" data-field="qaAnswerColor" value="${settings.qaAnswerColor}" style="width:100%;height:28px" /></label>
        </div>
        <div class="fn__flex" style="gap:8px;margin-bottom:8px">
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>Q 字号（px）</span><input class="b3-text-field fn__block" type="number" min="10" max="24" data-field="qaQuestionFontSize" value="${settings.qaQuestionFontSize}" /></label>
          <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>A 字号（px）</span><input class="b3-text-field fn__block" type="number" min="10" max="24" data-field="qaAnswerFontSize" value="${settings.qaAnswerFontSize}" /></label>
        </div>
        ${QA_STYLE_HTML(settings, qaFonts)}
      </div>
    </div>
    <div class="pz-subpage" data-settings-subpage="automation">
      <div class="pz-ocr-section">
        <div class="pz-ocr-section-title">笔记本 AI 自动摘要（后台，无界面按钮）</div>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px"><input type="checkbox" data-field="automationEnabled" ${settings.automationEnabled ? "checked" : ""}/> 启用自动摘要</label>
        <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px"><span>目标笔记本 ID</span><input class="b3-text-field fn__block" data-field="automationNotebookId" value="${escapeHtml(settings.automationNotebookId)}" /></label>
        <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px"><span>索引文档名</span><input class="b3-text-field fn__block" data-field="automationIndexTitle" value="${escapeHtml(settings.automationIndexTitle)}" /></label>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px"><input type="checkbox" data-field="automationBackfill" ${settings.automationBackfill ? "checked" : ""}/> 首次运行处理已有文章</label>
        <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:10px"><span>模型 ID（留空 = 思源当前 AI 模型）</span><input class="b3-text-field fn__block" data-field="automationModelId" value="${escapeHtml(settings.automationModelId)}" /></label>
        <label class="fn__flex" style="flex-direction:column;gap:4px"><span>摘要字数上限</span><input class="b3-text-field fn__block" data-field="automationMaxChars" value="${settings.automationMaxChars}" /></label>
      </div>
    </div>
  </section>

  <section class="pz-settings-page" data-settings-page="advanced">
    <details class="pz-ocr-section">
      <summary class="pz-ocr-section-title">旧版兼容设置</summary>
      <div class="pz-help" style="margin-bottom:8px">仅在旧版共用服务（OCR-Service-Portable）或老配置迁移时需要；独立引擎包无需修改。</div>
      <div class="fn__flex" style="gap:8px;margin-bottom:8px">
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>Pix2Text MFD 检测模型</span><input class="b3-text-field fn__block" data-field="ocrMfdModel" value="${escapeHtml(settings.ocrMfdModel)}" /></label>
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>Pix2Text MFR 识别模型</span><input class="b3-text-field fn__block" data-field="ocrMfrModel" value="${escapeHtml(settings.ocrMfrModel)}" /></label>
      </div>
      <div class="fn__flex" style="gap:8px;margin-bottom:8px">
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>MFD 静态尺寸（可选）</span><input class="b3-text-field fn__block" data-field="ocrMfdStaticShape" value="${escapeHtml(settings.ocrMfdStaticShape)}" placeholder="例如 768 或 768x1024" /></label>
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>MFR 上下文（可选）</span><input class="b3-text-field fn__block" data-field="ocrMfrContext" value="${escapeHtml(settings.ocrMfrContext)}" placeholder="公式识别上下文" /></label>
      </div>
      <div class="fn__flex" style="gap:8px;margin-bottom:8px">
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>Pix2Text 识别设备</span><select class="b3-select fn__block" data-field="ocrDevice"><option value="cpu" ${settings.ocrDevice === "cpu" ? "selected" : ""}>CPU</option><option value="cuda" ${settings.ocrDevice === "cuda" ? "selected" : ""}>CUDA</option><option value="auto" ${settings.ocrDevice === "auto" ? "selected" : ""}>自动</option></select></label>
        <label class="fn__flex" style="flex:1;flex-direction:column;gap:4px"><span>UniMERNet 推理设备</span><select class="b3-select fn__block" data-field="unimernetDevice"><option value="auto" ${settings.unimernetDevice === "auto" ? "selected" : ""}>自动</option><option value="cpu" ${settings.unimernetDevice === "cpu" ? "selected" : ""}>CPU</option><option value="cuda" ${settings.unimernetDevice === "cuda" ? "selected" : ""}>CUDA</option></select></label>
      </div>
      <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>UniMERNet 模型目录（旧版共用服务时必填）</span><input class="b3-text-field fn__block" data-field="unimernetPath" value="${escapeHtml(settings.unimernetPath)}" /></label>
      <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>UniMERNet 配置文件（可选）</span><input class="b3-text-field fn__block" data-field="unimernetConfigPath" value="${escapeHtml(settings.unimernetConfigPath)}" placeholder="默认目录下 configs/demo.yaml" /></label>
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><input type="checkbox" data-field="ocrEnableSpellChecker" ${settings.ocrEnableSpellChecker ? "checked" : ""}/> 启用英文拼写检查</label>
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" data-field="ocrEnableTable" ${settings.ocrEnableTable ? "checked" : ""}/> 启用表格识别</label>
    </details>
    <div class="pz-ocr-section">
      <div class="pz-ocr-section-title">调试与日志</div>
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" data-field="automationDebug" ${settings.automationDebug ? "checked" : ""}/> 调试日志输出到控制台</label>
      <div class="pz-help">排查问题时开启，日常建议关闭。</div>
    </div>
  </section>

    </div>
  </div>
</div>
<div class="b3-dialog__action">
  <span class="pz-muted" data-role="save-state" style="font-size:11px"></span>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--cancel" data-act="cancel">关闭</button>
</div>`,
    });
    settingsDialog = dialog;
    const root = dialog.element;
    const closed = () => !root.isConnected;
    const banner = root.querySelector<HTMLElement>('[data-role="apply-banner"]')!;
    const saveState = root.querySelector<HTMLElement>('[data-role="save-state"]')!;

    // ---- helpers ---------------------------------------------------------
    const field = <T extends Element = HTMLInputElement>(name: string): T | null => root.querySelector<T>(`[data-field="${name}"]`);
    const fieldValue = (name: string): string => field<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(name)?.value?.trim?.() ?? "";
    const checked = (name: string): boolean => Boolean(field<HTMLInputElement>(name)?.checked);
    const numberField = (name: string, fallback: number, min: number, max: number): number => {
        const parsed = Number.parseInt(fieldValue(name), 10);
        return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
    };
    const radioValue = (name: string): string => root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value || "";
    const engineCards = Array.from(root.querySelectorAll<HTMLElement>("[data-ocr-engine]"));
    const engineCardElement = (id: OcrEngineId): HTMLElement | undefined => engineCards.find(card => card.dataset.ocrEngine === id);
    const readEngineConfig = (id: OcrEngineId): OcrEngineConfig => {
        const card = engineCardElement(id);
        const fallback = engineConfig(host.store.state.settings, id);
        if (!card) return {...fallback};
        const dir = card.querySelector<HTMLInputElement>('[data-engine-field="dir"]')?.value.trim() || "";
        const rawPort = Number.parseInt(card.querySelector<HTMLInputElement>('[data-engine-field="port"]')?.value || "", 10);
        return {
            enabled: Boolean(card.querySelector<HTMLInputElement>('[data-engine-field="enabled"]')?.checked),
            dir,
            port: Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : OCR_ENGINE_DEFS[id].defaultPort,
            autoStart: Boolean(card.querySelector<HTMLInputElement>('[data-engine-field="autoStart"]')?.checked),
        };
    };
    const readEnginesRaw = (): OcrEngineMap => {
        const map = {} as OcrEngineMap;
        for (const id of OCR_ENGINE_IDS) map[id] = readEngineConfig(id);
        return map;
    };
    const normalizePorts = (map: OcrEngineMap): OcrEngineMap => {
        // Engines pointing at the same directory share one service process, so they must
        // share one port. Pick the primary engine's port (pix2text > unimernet > texo).
        const groups = new Map<string, {ids: OcrEngineId[]; port: number}>();
        for (const id of ["pix2text", "unimernet", "texo"] as OcrEngineId[]) {
            const key = normalizeDirKey(map[id].dir);
            if (!key) continue;
            const group = groups.get(key);
            if (group) {
                group.ids.push(id);
            } else {
                groups.set(key, {ids: [id], port: map[id].port});
            }
        }
        for (const group of groups.values()) {
            if (group.ids.length < 2) continue;
            for (const id of group.ids) {
                map[id] = {...map[id], port: group.port};
            }
        }
        return map;
    };
    const collectOcrEngines = (): OcrEngineMap => normalizePorts(readEnginesRaw());
    const validateOcrEngines = (engines: OcrEngineMap): string => {
        for (const id of OCR_ENGINE_IDS) {
            const config = engines[id];
            if (!config?.enabled || !config.dir) continue;
            const bundle = detectOcrBundle(config.dir);
            const name = OCR_ENGINE_DEFS[id].name;
            if (bundle.kind === "unknown") {
                return `${name}：目录里没有可识别的服务（需要 service.py 或 pz_ocr_server.py）`;
            }
            if (!isBundleCompatible(bundle, id)) {
                const hint = id === "texo" ? "Texo 请选择 OCR-Texo-Portable 解压目录" : `请选择 ${name} 对应的引擎包`;
                return `${name}：该目录是「${bundle.label}」，不能用于 ${name}。${hint}`;
            }
        }
        return "";
    };
    const syncEnginePortHints = (): void => {
        const engines = collectOcrEngines();
        for (const id of OCR_ENGINE_IDS) {
            const card = engineCardElement(id);
            if (!card) continue;
            const portInput = card.querySelector<HTMLInputElement>('[data-engine-field="port"]');
            if (portInput) portInput.value = String(engines[id].port);
            const hint = card.querySelector<HTMLElement>('[data-role="shared-port"]');
            if (!hint) continue;
            const key = normalizeDirKey(engines[id].dir);
            const shared = Boolean(key) && OCR_ENGINE_IDS.some(other => other !== id && normalizeDirKey(engines[other].dir) === key);
            hint.hidden = !shared;
            hint.textContent = shared ? `共用端口 ${engines[id].port}` : "";
        }
    };
    const inspectEngineDir = (id: OcrEngineId): void => {
        const card = engineCardElement(id);
        if (!card) return;
        const dir = card.querySelector<HTMLInputElement>('[data-engine-field="dir"]')?.value.trim() || "";
        if (!dir) {
            renderEngineEnv(id, []);
            setStatus(id, "未检测");
            return;
        }
        const bundle = detectOcrBundle(dir);
        const compatible = isBundleCompatible(bundle, id);
        renderEngineEnv(id, [{
            label: "目录类型",
            ok: compatible,
            detail: compatible
                ? `${bundle.label}${bundle.port ? ` · 建议端口 ${bundle.port}` : ""}`
                : `${bundle.label}，不能用于 ${OCR_ENGINE_DEFS[id].name}`,
        }]);
        if (!compatible) {
            setStatus(id, "目录不匹配", "error");
        }
    };
    const formulaOrderSelects = Array.from(root.querySelectorAll<HTMLSelectElement>('[data-role="formula-order"]'));
    const collectFormulaOrder = (): OcrEngineId[] => {
        const order: OcrEngineId[] = [];
        for (const select of formulaOrderSelects) {
            const value = select.value;
            if (isOcrEngineId(value) && !order.includes(value)) order.push(value);
        }
        return order;
    };
    const textEngineSelect = root.querySelector<HTMLSelectElement>('[data-role="text-engine"]')!;
    const previewRendererSelect = root.querySelector<HTMLSelectElement>('[data-role="preview-renderer"]')!;
    const autoCopyCheckbox = root.querySelector<HTMLInputElement>('[data-role="auto-copy"]')!;
    const autoCopyFormatSelect = root.querySelector<HTMLSelectElement>('[data-role="auto-copy-format"]')!;
    const serviceRows = Array.from(root.querySelectorAll<HTMLElement>("[data-service-index]"));
    const doc2xIgnoreInputs = Array.from(root.querySelectorAll<HTMLInputElement>("[data-doc2x-ignore]"));
    const ocrLangInputs = Array.from(root.querySelectorAll<HTMLInputElement>("[data-ocr-lang]"));

    const readCopyFormat = (): Settings["ocrAutoCopyFormat"] => {
        const value = autoCopyFormatSelect.value;
        return (COPY_FORMATS.some(item => item.value === value) ? value : "latex") as Settings["ocrAutoCopyFormat"];
    };

    // Staged (apply-required) values only take effect after 立即应用.
    const collectSettings = (includeApply: boolean): Partial<Settings> => {
        const current = host.store.state.settings;
        const apply = includeApply ? {} : {
            ocrEngines: current.ocrEngines,
            ocrSharedRuntimeDir: current.ocrSharedRuntimeDir,
            ocrStartCommand: current.ocrStartCommand,
            pdf2zhBaseUrl: current.pdf2zhBaseUrl,
            pdf2zhServerPath: current.pdf2zhServerPath,
            doc2xCommand: current.doc2xCommand,
            doc2xAuthMode: current.doc2xAuthMode,
        };
        const servicesNext: TranslationServiceConfig[] = services.map((service, index) => {
            const row = serviceRows.find(item => Number(item.dataset.serviceIndex) === index);
            const enabled = row?.querySelector<HTMLInputElement>('[data-service-field="enabled"]')?.checked;
            return enabled === undefined ? service : {...service, enabled};
        });
        return {
            zoteroBaseUrl: fieldValue("baseUrl") || "http://127.0.0.1:23119",
            zoteroDataDir: fieldValue("dataDir"),
            zoteroLibraryId: Number.parseInt(fieldValue("libraryId"), 10) || 0,
            previewTrigger: radioValue("pzPreviewTrigger") === "alt" ? "alt" : "hover",
            excerptTemplate: fieldValue("excerptTemplate") || "{text}",
            defaultCitationStyle: (fieldValue("citationStyle") || current.defaultCitationStyle) as Settings["defaultCitationStyle"],
            translationEnabled: checked("translationEnabled"),
            translationAuto: checked("translationAuto"),
            translationShowOriginal: checked("translationShowOriginal"),
            translationDefaultTargetLang: fieldValue("translationDefaultTargetLang") || "zh-CN",
            translationTargetLang: fieldValue("translationTargetLang") || "",
            translationMinChars: numberField("translationMinChars", 2, 1, 10000),
            translationActiveServiceId: fieldValue("translationActiveService") || current.translationActiveServiceId,
            translationServices: servicesNext,
            wholeTranslationProvider: fieldValue("wholeTranslationProvider") === "doc2x" ? "doc2x" : "pdf2zh",
            translationOutputDir: fieldValue("translationOutputDir"),
            pdf2zhBaseUrl: fieldValue("pdf2zhBaseUrl") || current.pdf2zhBaseUrl,
            pdf2zhServerPath: fieldValue("pdf2zhServerPath"),
            pdf2zhEngine: fieldValue("pdf2zhEngine") === "pdf2zh" ? "pdf2zh" : "pdf2zh_next",
            pdf2zhService: fieldValue("pdf2zhService") || current.pdf2zhService,
            pdf2zhSourceLang: fieldValue("pdf2zhSourceLang") || current.pdf2zhSourceLang || "en",
            pdf2zhTargetLang: fieldValue("pdf2zhTargetLang") || "",
            pdf2zhOutputMode: fieldValue("pdf2zhOutputMode") === "mono" ? "mono" : "dual",
            pdf2zhDualMode: fieldValue("pdf2zhDualMode") === "TB" ? "TB" : "LR",
            doc2xCommand: fieldValue("doc2xCommand") || current.doc2xCommand,
            doc2xConfigured: checked("doc2xConfigured"),
            doc2xAuthMode: fieldValue("doc2xAuthMode") === "client" ? "client" : "oauth",
            doc2xTargetLang: fieldValue("doc2xTargetLang") || "",
            doc2xOutputMode: fieldValue("doc2xOutputMode") === "translatedPdf" ? "translatedPdf" : "dualPdf",
            doc2xTranslateType: fieldValue("doc2xTranslateType") === "md" ? "md" : "pdf",
            doc2xParseImageModel: fieldValue("doc2xParseImageModel") === "mathpix" ? "mathpix" : "doc2x",
            doc2xVisionModel: fieldValue("doc2xVisionModel"),
            doc2xModel: fieldValue("doc2xModel"),
            doc2xTermId: fieldValue("doc2xTermId"),
            doc2xFontStrategy: fieldValue("doc2xFontStrategy") === "page-optimal" ? "page-optimal" : "global-consistent",
            doc2xContextual: checked("doc2xContextual"),
            doc2xFontColor: checked("doc2xFontColor"),
            doc2xIgnoreTypes: doc2xIgnoreInputs.filter(input => input.checked).map(input => input.dataset.doc2xIgnore || "").filter(Boolean),
            ...apply,
            ocrEngines: includeApply ? collectOcrEngines() : (apply.ocrEngines as OcrEngineMap),
            ocrSharedRuntimeDir: includeApply ? fieldValue("ocrSharedRuntimeDir") : apply.ocrSharedRuntimeDir,
            ocrStartCommand: includeApply ? fieldValue("ocrStartCommand") : apply.ocrStartCommand,
            ocrFormulaOrder: collectFormulaOrder(),
            ocrTextEngine: isOcrEngineId(textEngineSelect.value) ? textEngineSelect.value : current.ocrTextEngine,
            ocrPreviewRenderer: previewRendererSelect.value === "mathlive" ? "mathlive" : "katex",
            ocrAutoCopy: autoCopyCheckbox.checked,
            ocrAutoCopyFormat: readCopyFormat(),
            ocrLanguages: ocrLangInputs.filter(input => input.checked).map(input => input.dataset.ocrLang || "").filter(Boolean),
            ocrDefaultMode: fieldValue("ocrDefaultMode") === "formula" || fieldValue("ocrDefaultMode") === "text" ? fieldValue("ocrDefaultMode") as Settings["ocrDefaultMode"] : "auto",
            ocrFormulaFormat: fieldValue("ocrFormulaFormat") === "display" ? "display" : "inline",
            ocrDefaultAction: fieldValue("ocrDefaultAction") === "replace" || fieldValue("ocrDefaultAction") === "copy" || fieldValue("ocrDefaultAction") === "append" ? fieldValue("ocrDefaultAction") as Settings["ocrDefaultAction"] : "insert",
            ocrHistoryLimit: numberField("ocrHistoryLimit", 50, 1, 500),
            ocrPreview: checked("ocrPreview"),
            ocrTimeoutMs: numberField("ocrTimeoutMs", 120000, 1000, 600000),
            ocrDevice: fieldValue("ocrDevice") === "cuda" || fieldValue("ocrDevice") === "auto" ? fieldValue("ocrDevice") as Settings["ocrDevice"] : "cpu",
            ocrEnableTable: checked("ocrEnableTable"),
            ocrEnableSpellChecker: checked("ocrEnableSpellChecker"),
            ocrMfdModel: fieldValue("ocrMfdModel") || "mfd-1.5",
            ocrMfrModel: fieldValue("ocrMfrModel") || "mfr-1.5",
            ocrMfdStaticShape: fieldValue("ocrMfdStaticShape"),
            ocrMfrContext: fieldValue("ocrMfrContext"),
            unimernetPath: fieldValue("unimernetPath"),
            unimernetConfigPath: fieldValue("unimernetConfigPath"),
            unimernetDevice: fieldValue("unimernetDevice") === "cuda" || fieldValue("unimernetDevice") === "cpu" ? fieldValue("unimernetDevice") as Settings["unimernetDevice"] : "auto",
            qaTitle: fieldValue("qaTitle") || "PDF 问答",
            qaModelId: fieldValue("qaModelId"),
            qaContextPages: numberField("qaContextPages", 2, 1, 4),
            qaHistoryDays: numberField("qaHistoryDays", 15, 1, 3650),
            qaMaxThreadsPerPdf: numberField("qaMaxThreadsPerPdf", 50, 1, 200),
            qaSessionListPlacement: fieldValue("qaSessionListPlacement") === "drawer" ? "drawer" : "panel",
            qaKnowledgeMode: fieldValue("qaKnowledgeMode") === "pdf" ? "pdf" : "auto",
            qaBlockRadius: numberField("qaBlockRadius", 8, 0, 24),
            qaFontFamily: fieldValue("qaFontFamily"),
            qaBlockBorderColor: fieldValue("qaBlockBorderColor") || current.qaBlockBorderColor,
            qaBlockBackground: fieldValue("qaBlockBackground") || current.qaBlockBackground,
            qaTitleColor: fieldValue("qaTitleColor") || current.qaTitleColor,
            qaQuestionColor: fieldValue("qaQuestionColor") || current.qaQuestionColor,
            qaAnswerColor: fieldValue("qaAnswerColor") || current.qaAnswerColor,
            qaQuestionFontSize: numberField("qaQuestionFontSize", 13, 10, 24),
            qaAnswerFontSize: numberField("qaAnswerFontSize", 14, 10, 24),
            automationEnabled: checked("automationEnabled"),
            automationNotebookId: fieldValue("automationNotebookId"),
            automationIndexTitle: fieldValue("automationIndexTitle") || current.automationIndexTitle,
            automationBackfill: checked("automationBackfill"),
            automationModelId: fieldValue("automationModelId"),
            automationMaxChars: numberField("automationMaxChars", 450, 120, 100000),
            automationDebug: checked("automationDebug"),
            // Legacy mirrors kept in sync so old code paths and stored exports stay valid.
            ocrServerPath: readEngineConfig("pix2text").dir,
            ocrPort: readEngineConfig("pix2text").port,
            ocrAutoStart: readEngineConfig("pix2text").autoStart,
            ocrEngine: collectFormulaOrder()[0] === "unimernet" ? "unimernet" : "pix2text",
        };
    };

    const probeSettings = (): Settings => ({...host.store.state.settings, ...collectSettings(true)});

    let saveTimer = 0;
    let lastSavedAt = "";
    let lastValidationError = "";
    const reportValidationError = (error: string): void => {
        saveState.textContent = `未保存：${error}`;
        saveState.dataset.tone = "error";
        if (error !== lastValidationError) {
            lastValidationError = error;
            showMessage(`未保存：${error}`, 6000, "error");
        }
    };
    const persist = async (): Promise<void> => {
        window.clearTimeout(saveTimer);
        if (closed()) return;
        const staged = collectSettings(true);
        const error = validateOcrEngines((staged as Settings).ocrEngines);
        if (error) {
            reportValidationError(error);
            return;
        }
        lastValidationError = "";
        host.store.updateSettings(collectSettings(false));
        await host.store.save();
        syncEnginePortHints();
        lastSavedAt = new Date().toLocaleTimeString();
        saveState.dataset.tone = "";
        saveState.textContent = `已保存 ${lastSavedAt}`;
    };
    const schedulePersist = (): void => {
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => { void persist(); }, 400);
    };

    const setStatus = (id: OcrEngineId, text: string, tone: "ok" | "warn" | "error" | "idle" = "idle"): void => {
        const status = engineCardElement(id)?.querySelector<HTMLElement>('[data-role="engine-status"]');
        if (!status) return;
        status.textContent = text;
        status.dataset.tone = tone;
    };
    const renderEngineEnv = (id: OcrEngineId, checks: Array<{label: string; ok: boolean; detail: string}>): void => {
        const target = engineCardElement(id)?.querySelector<HTMLElement>('[data-role="engine-env"]');
        if (!target) return;
        target.innerHTML = checks.map(item => `<div>${item.ok ? "✓" : "✗"} ${escapeHtml(item.label)}：${escapeHtml(item.detail).replace(/\n/g, "<br>")}</div>`).join("");
    };
    const refreshEngineStatus = async (id: OcrEngineId): Promise<void> => {
        const config = readEngineConfig(id);
        if (config.dir) {
            const bundle = detectOcrBundle(config.dir);
            if (bundle.kind !== "unknown" && !isBundleCompatible(bundle, id)) {
                setStatus(id, "目录不匹配", "error");
                return;
            }
        }
        const health = await getOcrHealth(probeSettings(), id);
        setStatus(id, health.ok ? "运行中" : "未运行", health.ok ? "ok" : "idle");
    };

    // ---- engine card actions --------------------------------------------
    for (const card of engineCards) {
        const engineId = card.dataset.ocrEngine as OcrEngineId;
        if (!isOcrEngineId(engineId)) continue;
        card.querySelector('[data-act="engine-pick-dir"]')?.addEventListener("click", async () => {
            const selected = await pickDirectory();
            if (selected) {
                const input = card.querySelector<HTMLInputElement>('[data-engine-field="dir"]');
                if (input) input.value = selected;
                const bundlePort = detectOcrBundle(selected).port;
                const portInput = card.querySelector<HTMLInputElement>('[data-engine-field="port"]');
                if (bundlePort && portInput) portInput.value = String(bundlePort);
                inspectEngineDir(engineId);
                banner.hidden = false;
            }
        });
        card.querySelector<HTMLInputElement>('[data-engine-field="dir"]')?.addEventListener("change", () => {
            const dirInput = card.querySelector<HTMLInputElement>('[data-engine-field="dir"]');
            const bundlePort = detectOcrBundle(dirInput?.value.trim() || "").port;
            const portInput = card.querySelector<HTMLInputElement>('[data-engine-field="port"]');
            if (bundlePort && portInput) portInput.value = String(bundlePort);
            inspectEngineDir(engineId);
        });
        card.querySelector('[data-act="engine-check"]')?.addEventListener("click", async () => {
            setStatus(engineId, "检测中…", "warn");
            const checkConfig = readEngineConfig(engineId);
            const checkBundle = detectOcrBundle(checkConfig.dir);
            if (checkConfig.dir && !isBundleCompatible(checkBundle, engineId)) {
                renderEngineEnv(engineId, [{label: "目录类型", ok: false, detail: `${checkBundle.label}，不能用于 ${OCR_ENGINE_DEFS[engineId].name}`}]);
                setStatus(engineId, "目录不匹配", "error");
                return;
            }
            let result = await checkOcrEngineEnvironment(probeSettings(), engineId);
            const config = readEngineConfig(engineId);
            if (!result.health?.ok && result.script && result.python && config.enabled) {
                setStatus(engineId, "启动中…", "warn");
                const started = await ensureOcrEngine(probeSettings(), engineId);
                result = await checkOcrEngineEnvironment(probeSettings(), engineId);
                if (!result.health?.ok) {
                    const tail = readBundleLogTail(config.dir, 8);
                    if (tail) {
                        result.checks.push({label: "启动失败", ok: false, detail: started.error || "服务未就绪"});
                        result.checks.push({label: "服务日志", ok: false, detail: tail});
                    }
                }
            }
            renderEngineEnv(engineId, result.checks);
            setStatus(engineId, result.ok ? "环境正常" : (result.health?.ok ? "需检查" : "未运行"), result.ok ? "ok" : "warn");
        });
        card.querySelector('[data-act="engine-start"]')?.addEventListener("click", async () => {
            setStatus(engineId, "启动中…", "warn");
            const started = await ensureOcrEngine(probeSettings(), engineId);
            setStatus(engineId, started.ok ? "运行中" : "启动失败", started.ok ? "ok" : "error");
            if (!started.ok) {
                const checks = [{label: "启动失败", ok: false, detail: started.error || "未知错误"}];
                const tail = readBundleLogTail(readEngineConfig(engineId).dir, 8);
                if (tail) checks.push({label: "服务日志", ok: false, detail: tail});
                renderEngineEnv(engineId, checks);
            }
        });
        card.querySelector('[data-act="engine-stop"]')?.addEventListener("click", async () => {
            setStatus(engineId, "停止中…", "warn");
            const stopped = await stopOcrEngine(probeSettings(), engineId);
            setStatus(engineId, stopped.ok ? "已停止" : "停止失败", stopped.ok ? "idle" : "error");
            if (!stopped.ok) renderEngineEnv(engineId, [{label: "停止失败", ok: false, detail: stopped.error || "未知错误"}]);
        });
        card.querySelector('[data-act="engine-restart"]')?.addEventListener("click", async () => {
            setStatus(engineId, "重启中…", "warn");
            const restarted = await restartOcrEngine(probeSettings(), engineId);
            setStatus(engineId, restarted.ok ? "运行中" : "重启失败", restarted.ok ? "ok" : "error");
            if (!restarted.ok) {
                const checks = [{label: "重启失败", ok: false, detail: restarted.error || "未知错误"}];
                const tail = readBundleLogTail(readEngineConfig(engineId).dir, 8);
                if (tail) checks.push({label: "服务日志", ok: false, detail: tail});
                renderEngineEnv(engineId, checks);
            }
        });
        inspectEngineDir(engineId);
        void refreshEngineStatus(engineId);
    }
    root.querySelector('[data-act="ocr-shared-runtime-pick"]')?.addEventListener("click", async () => {
        const selected = await pickDirectory();
        const input = field<HTMLInputElement>("ocrSharedRuntimeDir");
        if (selected && input) {
            input.value = selected;
            banner.hidden = false;
        }
    });
    const ocrEnv = root.querySelector<HTMLElement>('[data-role="ocr-env"]')!;
    root.querySelector('[data-act="ocr-check"]')?.addEventListener("click", async () => {
        ocrEnv.textContent = "检测中…";
        let result = await checkOcrEnvironment(probeSettings());
        const notRunning = result.engines.filter(item => !item.health?.ok && item.script && item.python && readEngineConfig(item.engine).enabled);
        for (const engineResult of notRunning) {
            ocrEnv.textContent = `正在启动 ${OCR_ENGINE_DEFS[engineResult.engine].name}…`;
            setStatus(engineResult.engine, "启动中…", "warn");
            await ensureOcrEngine(probeSettings(), engineResult.engine);
        }
        if (notRunning.length) {
            result = await checkOcrEnvironment(probeSettings());
        }
        const lines = result.checks.map(item => `<div>${item.ok ? "✓" : "✗"} ${escapeHtml(item.label)}：${escapeHtml(item.detail)}</div>`);
        ocrEnv.innerHTML = lines.length ? lines.join("") : "<div>未启用任何引擎</div>";
        for (const engineResult of result.engines) {
            setStatus(engineResult.engine, engineResult.ok ? "环境正常" : (engineResult.health?.ok ? "需检查" : "未运行"), engineResult.ok ? "ok" : "warn");
            if (!engineResult.health?.ok) {
                const tail = readBundleLogTail(engineConfig(probeSettings(), engineResult.engine).dir, 6);
                if (tail) renderEngineEnv(engineResult.engine, [{label: "服务日志", ok: false, detail: tail}]);
            }
        }
    });

    // ---- local bundle discovery / auto fill --------------------------------
    const localRoots = (): string[] => {
        const path = requireNode("path");
        if (!path?.join) return [];
        const dataDir = String((window as any).siyuan?.config?.system?.dataDir || "").trim();
        if (!dataDir) return [];
        const roots: string[] = [];
        {
            const pluginDir = path.join(dataDir, "plugins", "siyuan-pdf-zotero");
            roots.push(pluginDir, path.join(pluginDir, "services"), path.join(dataDir, "plugins"));
        }
        try {
            const repoRoot = typeof __PZ_REPO_ROOT__ === "string" ? __PZ_REPO_ROOT__ : "";
            if (repoRoot) roots.push(path.join(repoRoot, "release"));
        } catch {
            // production build may not define the repo root
        }
        return roots;
    };
    const autoFillBundles = async (manual = false): Promise<void> => {
        const found = discoverBundles(localRoots());
        const engineForKind: Record<string, OcrEngineId> = {texo: "texo", unimernet: "unimernet", pix2text: "pix2text", legacy: "pix2text"};
        let filled = 0;
        for (const [kind, engineId] of Object.entries(engineForKind)) {
            const dir = found.ocr[kind as keyof typeof found.ocr];
            if (!dir) continue;
            const card = engineCardElement(engineId);
            if (!card) continue;
            const input = card.querySelector<HTMLInputElement>('[data-engine-field="dir"]');
            if (!input || input.value.trim()) continue;
            input.value = dir;
            const port = detectOcrBundle(dir).port;
            const portInput = card.querySelector<HTMLInputElement>('[data-engine-field="port"]');
            if (port && portInput && (!portInput.value.trim() || Number(portInput.value) === OCR_ENGINE_DEFS[engineId].defaultPort)) {
                portInput.value = String(port);
            }
            inspectEngineDir(engineId);
            filled += 1;
        }
        const pdf2zhInput = field<HTMLInputElement>("pdf2zhServerPath");
        if (pdf2zhInput && !pdf2zhInput.value.trim() && found.pdf2zh.length) {
            pdf2zhInput.value = found.pdf2zh[0];
            filled += 1;
        }
        if (filled > 0) {
            host.store.updateSettings(collectSettings(true));
            await host.store.save();
            syncEnginePortHints();
            banner.hidden = true;
            showMessage(`已自动填入 ${filled} 个本地服务目录`, 3200);
        } else if (manual) {
            showMessage("没有发现新的可填目录（已填写的不会被覆盖）", 3200);
        }
    };
    root.querySelector('[data-act="ocr-auto-index"]')?.addEventListener("click", () => { void autoFillBundles(true); });
    root.querySelector('[data-act="pdf2zh-auto-index"]')?.addEventListener("click", () => { void autoFillBundles(true); });

    // ---- translation ----------------------------------------------------
    root.querySelector('[data-act="pick-translation-dir"]')?.addEventListener("click", async () => {
        const selected = await pickDirectory();
        const input = field<HTMLInputElement>("translationOutputDir");
        if (selected && input) {
            input.value = selected;
            schedulePersist();
        }
    });
    root.querySelector('[data-act="pdf2zh-dir-pick"]')?.addEventListener("click", async () => {
        const selected = await pickDirectory();
        const input = field<HTMLInputElement>("pdf2zhServerPath");
        if (!selected || !input) return;
        const path = requireNode("path");
        const nested = path?.join ? path.join(selected, "pdf2zh-server") : "";
        const target = detectPdf2zhServer(selected) ? selected : (nested && detectPdf2zhServer(nested) ? nested : "");
        if (!target) {
            showMessage("该目录没有 pz_server.py，请选择 SiYuan-PDF2zh-Portable 或其中的 pdf2zh-server 目录", 6000, "error");
            return;
        }
        input.value = target;
        banner.hidden = false;
        showMessage("已选择 PDF2zh 目录，点「立即应用」生效", 3200);
    });
    const pdf2zhEnv = root.querySelector<HTMLElement>('[data-role="pdf2zh-env"]')!;
    root.querySelector('[data-act="pdf2zh-check"]')?.addEventListener("click", async () => {
        pdf2zhEnv.textContent = "检测中…";
        const probe = probeSettings();
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
            const engineSelect = field<HTMLSelectElement>("pdf2zhEngine");
            const serviceSelect = field<HTMLSelectElement>("pdf2zhService");
            if (engineSelect && engineSelect.value !== "pdf2zh") engineSelect.value = "pdf2zh";
            if (serviceSelect && (!serviceSelect.value.trim() || serviceSelect.value.trim() === "siliconflowfree")) serviceSelect.value = "bing";
        }
        pdf2zhEnv.innerHTML = result.checks.map(item => `<div>${item.ok ? "✓" : "✗"} ${escapeHtml(item.label)}：${escapeHtml(item.detail)}</div>`).join("")
            + (started ? "<div>✓ 已自动启动 PDF2zh 服务</div>" : "")
            + (legacy ? "<div>ℹ 检测到便携版 PDF2zh，已切换引擎为 pdf2zh、服务为 bing。</div>" : "");
    });
    const doc2xEnv = root.querySelector<HTMLElement>('[data-role="doc2x-env"]')!;
    const fillSelect = (select: HTMLSelectElement | null, items: any[], emptyLabel: string, toValue: (item: any) => string, toLabel: (item: any) => string) => {
        if (!select) return;
        const currentValue = select.value;
        const options = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
        const seen = new Set<string>();
        for (const item of items || []) {
            const value = toValue(item);
            if (!value || seen.has(value)) continue;
            seen.add(value);
            options.push(`<option value="${escapeHtml(value)}" ${value === currentValue ? "selected" : ""}>${escapeHtml(toLabel(item))}</option>`);
        }
        select.innerHTML = options.join("");
    };
    const applyDoc2xModels = (models: any[], terms: any[]): void => {
        fillSelect(field<HTMLSelectElement>("doc2xModel"), models, "官方默认（Free）",
            item => String(item?.modelId ?? item?.id ?? item?.name ?? ""),
            item => {
                const id = String(item?.modelId ?? item?.id ?? "");
                const name = String(item?.displayName || item?.name || id);
                return `${name} (${id})${item?.subscriptionRequired ? " · 需订阅" : ""}`;
            });
        fillSelect(field<HTMLSelectElement>("doc2xVisionModel"), models, "不使用视觉模型",
            item => String(item?.modelId ?? item?.id ?? item?.name ?? ""),
            item => {
                const id = String(item?.modelId ?? item?.id ?? "");
                const name = String(item?.displayName || item?.name || id);
                return `${name} (${id})${item?.subscriptionRequired ? " · 需订阅" : ""}`;
            });
        fillSelect(field<HTMLSelectElement>("doc2xTermId"), terms, "不使用术语表",
            item => String(item?.id ?? item?.termId ?? item?.name ?? ""),
            item => String(item?.name ?? item?.title ?? item?.id ?? ""));
    };
    const refreshDoc2xModels = async (announce = false): Promise<void> => {
        if (announce) doc2xEnv.textContent = "正在读取 Doc2X 官方模型列表…";
        const list = await fetchDoc2xModelList(probeSettings());
        applyDoc2xModels(list.models, list.terms);
        if (announce) doc2xEnv.textContent = `已读取 ${list.models.length} 个官方翻译模型、${list.terms.length} 个术语表。`;
    };
    root.querySelector('[data-act="doc2x-refresh-models"]')?.addEventListener("click", () => {
        void refreshDoc2xModels(true).catch((error: any) => {
            doc2xEnv.textContent = `读取模型失败：${String(error?.message || error).slice(0, 200)}`;
        });
    });
    root.querySelector('[data-act="doc2x-refresh-terms"]')?.addEventListener("click", () => {
        (root.querySelector('[data-act="doc2x-check"]') as HTMLButtonElement | null)?.click();
    });
    root.querySelector('[data-act="doc2x-check"]')?.addEventListener("click", async () => {
        doc2xEnv.textContent = "检测中…";
        const probe = probeSettings();
        const result = await checkDoc2xEnvironment(probe);
        try {
            const list = await fetchDoc2xModelList(probe);
            applyDoc2xModels(list.models, list.terms);
        } catch {
            // model list unavailable; keep saved selections
        }
        doc2xEnv.innerHTML = result.checks.map(item => `<div>${item.ok ? "✓" : "✗"} ${escapeHtml(item.label)}：${escapeHtml(item.detail)}</div>`).join("")
            + (result.ok ? "<div>✓ Doc2X 已就绪，翻译时后台直接调用 CLI</div>" : "<div>✗ 首次使用请先运行 doc2x login</div>");
    });

    // Doc2X output type + PDF2zh dual direction visibility
    const applyDoc2xVisibility = (): void => {
        const dual = fieldValue("doc2xOutputMode") !== "translatedPdf";
        const dualRow = root.querySelector<HTMLElement>('[data-role="doc2x-dual-row"]');
        if (dualRow) dualRow.hidden = !dual;
        const isMd = fieldValue("doc2xTranslateType") === "md";
        const fontRow = root.querySelector<HTMLElement>('[data-role="doc2x-font-row"]');
        if (fontRow) fontRow.hidden = !dual || isMd;
    };
    const applyPdf2zhVisibility = (): void => {
        const row = root.querySelector<HTMLElement>('[data-role="pdf2zh-dual-row"]');
        if (row) row.hidden = fieldValue("pdf2zhOutputMode") !== "dual";
    };
    field<HTMLSelectElement>("doc2xOutputMode")?.addEventListener("change", applyDoc2xVisibility);
    field<HTMLSelectElement>("doc2xTranslateType")?.addEventListener("change", applyDoc2xVisibility);
    field<HTMLSelectElement>("pdf2zhOutputMode")?.addEventListener("change", applyPdf2zhVisibility);
    applyDoc2xVisibility();
    applyPdf2zhVisibility();
    window.setTimeout(() => {
        if (!closed()) {
            void refreshDoc2xModels(false).catch((): undefined => undefined);
        }
    }, 600);

    // service list: active radio + edit/test
    root.querySelectorAll<HTMLInputElement>('input[name="pzActiveService"]').forEach(radio => {
        radio.addEventListener("change", () => schedulePersist());
    });
    root.querySelectorAll('[data-service-field="enabled"]').forEach(input => input.addEventListener("change", () => schedulePersist()));
    const testService = async (service: TranslationServiceConfig): Promise<void> => {
        showMessage(`正在测试 ${service.name}…`, 1500);
        try {
            const result = await translateText(service, "Hello, world", effectiveTargetLang(host.store.state.settings, "selection"));
            showMessage(`连接正常：${String(result.text || "").slice(0, 40)}`, 3000);
        } catch (error: any) {
            showMessage(`测试失败：${error?.message || String(error)}`, 5000, "error");
        }
    };
    root.querySelectorAll<HTMLButtonElement>('[data-act="service-test"]').forEach(button => {
        button.addEventListener("click", () => {
            const index = Number(button.dataset.serviceIndex);
            const service = services[index];
            if (service) void testService(service);
        });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-act="service-edit"]').forEach(button => {
        button.addEventListener("click", () => {
            const index = Number(button.dataset.serviceIndex);
            openTranslationServiceDetail(host, index);
        });
    });

    // ---- QA live preview -------------------------------------------------
    const qaPreview = root.querySelector<HTMLElement>('[data-role="qa-preview"]');
    const updateQaPreview = (): void => {
        if (!qaPreview) return;
        qaPreview.style.borderColor = fieldValue("qaBlockBorderColor");
        qaPreview.style.borderRadius = `${numberField("qaBlockRadius", 8, 0, 24)}px`;
        qaPreview.style.background = fieldValue("qaBlockBackground");
        qaPreview.style.fontFamily = fieldValue("qaFontFamily");
        const title = qaPreview.querySelector<HTMLElement>('[data-preview="title"]');
        if (title) {
            title.textContent = fieldValue("qaTitle") || "PDF 问答";
            title.style.color = fieldValue("qaTitleColor");
        }
        const q = qaPreview.querySelector<HTMLElement>(".pz-qa-preview-q");
        const a = qaPreview.querySelector<HTMLElement>(".pz-qa-preview-a");
        if (q) {
            q.style.color = fieldValue("qaQuestionColor");
            q.style.fontSize = `${numberField("qaQuestionFontSize", 13, 10, 24)}px`;
        }
        if (a) {
            a.style.color = fieldValue("qaAnswerColor");
            a.style.fontSize = `${numberField("qaAnswerFontSize", 14, 10, 24)}px`;
        }
    };
    for (const name of ["qaTitle", "qaBlockRadius", "qaFontFamily", "qaBlockBorderColor", "qaBlockBackground", "qaTitleColor", "qaQuestionColor", "qaAnswerColor", "qaQuestionFontSize", "qaAnswerFontSize"]) {
        field(name)?.addEventListener("input", updateQaPreview);
        field(name)?.addEventListener("change", updateQaPreview);
    }
    updateQaPreview();

    // ---- navigation / subtabs -------------------------------------------
    const navButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"));
    const pages = Array.from(root.querySelectorAll<HTMLElement>("[data-settings-page]"));
    const activatePage = (name: string): void => {
        for (const button of navButtons) button.classList.toggle("is-active", button.dataset.settingsTab === name);
        for (const page of pages) page.classList.toggle("is-active", page.dataset.settingsPage === name);
    };
    const activateSubtab = (page: HTMLElement, name: string): void => {
        for (const button of Array.from(page.querySelectorAll<HTMLButtonElement>("[data-settings-subtab]"))) {
            button.classList.toggle("is-active", button.dataset.settingsSubtab === name);
        }
        for (const subpage of Array.from(page.querySelectorAll<HTMLElement>("[data-settings-subpage]"))) {
            subpage.classList.toggle("is-active", subpage.dataset.settingsSubpage === name);
        }
    };
    for (const button of navButtons) {
        button.addEventListener("click", () => activatePage(button.dataset.settingsTab || "connection"));
    }
    for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-settings-subtab]"))) {
        button.addEventListener("click", () => {
            const page = button.closest<HTMLElement>("[data-settings-page]");
            if (page) activateSubtab(page, button.dataset.settingsSubtab || "");
        });
    }

    // ---- search ----------------------------------------------------------
    const searchInput = root.querySelector<HTMLInputElement>('[data-role="settings-search"]')!;
    const searchResults = root.querySelector<HTMLElement>('[data-role="search-results"]')!;
    interface SearchItem { page: string; pageLabel: string; subtab?: string; label: string; element: HTMLElement; }
    const pageLabels: Record<string, string> = {connection: "连接与阅读", translation: "翻译", ocr: "OCR", ai: "AI 与自动化", advanced: "高级"};
    const searchItems: SearchItem[] = [];
    const subtabLabelMap = new Map<string, string>();
    for (const page of pages) {
        const pageName = page.dataset.settingsPage || "";
        const subtabs = Array.from(page.querySelectorAll<HTMLButtonElement>("[data-settings-subtab]"));
        for (const button of subtabs) {
            subtabLabelMap.set(button.dataset.settingsSubtab || "", button.textContent?.trim() || "");
        }
        for (const el of Array.from(page.querySelectorAll<HTMLElement>("[data-field],[data-role],[data-engine-field]"))) {
            const wrapper = el.closest<HTMLElement>("label,[data-setting-row],.pz-engine-card") || el;
            const labelText = (wrapper.textContent || "").replace(/\s+/g, " ").trim();
            if (!labelText) continue;
            const subpage = el.closest<HTMLElement>("[data-settings-subpage]");
            const subtab = subpage?.dataset.settingsSubpage;
            searchItems.push({page: pageName, pageLabel: pageLabels[pageName] || pageName, subtab, label: labelText.slice(0, 120), element: el});
        }
    }
    const clearHighlight = (): void => {
        root.querySelectorAll<HTMLElement>(".is-search-hit").forEach(el => el.classList.remove("is-search-hit"));
    };
    const runSearch = (): void => {
        const query = searchInput.value.trim().toLowerCase();
        clearHighlight();
        if (!query) {
            searchResults.hidden = true;
            searchResults.innerHTML = "";
            return;
        }
        const matches = searchItems.filter(item => item.label.toLowerCase().includes(query)).slice(0, 14);
        if (!matches.length) {
            searchResults.hidden = false;
            searchResults.innerHTML = `<div class="pz-muted" style="padding:6px 8px">没有匹配的设置项</div>`;
            return;
        }
        searchResults.hidden = false;
        searchResults.innerHTML = matches.map((item, index) => {
            const subLabel = item.subtab ? subtabLabelMap.get(item.subtab) || "" : "";
            return `<button type="button" class="pz-settings-search-hit" data-search-index="${index}"><span class="pz-settings-search-page">${escapeHtml(item.pageLabel)}${subLabel ? " › " + escapeHtml(subLabel) : ""}</span><span>${escapeHtml(item.label)}</span></button>`;
        }).join("");
        searchResults.querySelectorAll<HTMLButtonElement>("[data-search-index]").forEach(button => {
            button.addEventListener("click", () => {
                const item = matches[Number(button.dataset.searchIndex)];
                if (!item) return;
                activatePage(item.page);
                const pageElement = pages.find(page => page.dataset.settingsPage === item.page);
                if (pageElement && item.subtab) activateSubtab(pageElement, item.subtab);
                searchResults.hidden = true;
                requestAnimationFrame(() => {
                    const wrapper = item.element.closest<HTMLElement>("label,[data-setting-row],.pz-engine-card") || item.element;
                    wrapper.classList.add("is-search-hit");
                    wrapper.scrollIntoView({block: "center", behavior: "smooth"});
                    window.setTimeout(() => wrapper.classList.remove("is-search-hit"), 2600);
                });
            });
        });
    };
    searchInput.addEventListener("input", runSearch);
    searchInput.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            searchInput.value = "";
            runSearch();
        }
    });

    // ---- instant apply / staged apply -----------------------------------
    const needsApply = (target: HTMLElement): boolean => Boolean(target.closest('[data-apply="true"]'));
    const onFieldChange = (event: Event): void => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (target.closest('[data-role="settings-search"]')) return;
        if (needsApply(target)) {
            banner.hidden = false;
            return;
        }
        updateQaPreview();
        schedulePersist();
    };
    root.addEventListener("change", onFieldChange);
    root.addEventListener("input", event => {
        const target = event.target as HTMLElement | null;
        if (!target || target.closest('[data-role="settings-search"]')) return;
        // Avoid `instanceof HTMLInputElement`: the bundled UI can run before the
        // DOM constructors are registered in some test/preview environments.
        if (target.tagName === "INPUT" && ["checkbox", "radio", "color"].includes((target as HTMLInputElement).type)) return;
        if (needsApply(target)) return;
        schedulePersist();
    });
    const applyButton = root.querySelector<HTMLButtonElement>('[data-act="apply"]');
    applyButton?.addEventListener("click", async () => {
        const staged = collectSettings(true);
        const error = validateOcrEngines((staged as Settings).ocrEngines);
        if (error) {
            reportValidationError(error);
            return;
        }
        lastValidationError = "";
        host.store.updateSettings(staged);
        await host.store.save();
        syncEnginePortHints();
        banner.hidden = true;
        saveState.dataset.tone = "";
        saveState.textContent = `已应用 ${new Date().toLocaleTimeString()}`;
        for (const id of OCR_ENGINE_IDS) void refreshEngineStatus(id);
        host.refreshDock();
        showMessage("设置已应用");
    });

    // ---- close -----------------------------------------------------------
    const close = async (): Promise<void> => {
        window.clearTimeout(saveTimer);
        if (!banner.hidden && !window.confirm("有需要「立即应用」的修改，关闭会丢弃这些修改。确定关闭？")) return;
        await persist();
        dialog.destroy();
        settingsDialog = null;
    };
    root.querySelector('[data-act="cancel"]')?.addEventListener("click", () => { void close(); });
    syncEnginePortHints();
    void autoFillBundles(false);
    root.querySelector<HTMLButtonElement>('[data-field="citationStyle"]')?.addEventListener("change", () => {});
    const citationStyle = field<HTMLSelectElement>("citationStyle");
    if (citationStyle) {
        let selected = host.store.state.settings.defaultCitationStyle;
        citationStyle.addEventListener("change", () => {
            if (citationStyle.value !== "__more__") {
                selected = citationStyle.value as Settings["defaultCitationStyle"];
                return;
            }
            citationStyle.value = selected;
            openCitationStylePicker(selected, id => {
                selected = id as Settings["defaultCitationStyle"];
                citationStyle.innerHTML = citationStyleOptions(id);
                citationStyle.value = id;
            });
        });
    }

    // Automation restart + theme + history sync on close, like before save did.
    const destroyOriginal = dialog.destroy.bind(dialog);
    dialog.destroy = () => {
        window.clearTimeout(saveTimer);
        host.restartAutomation();
        applyQaBlockTheme(host.store.state.settings);
        void syncTranslationHistory(host);
        destroyOriginal();
    };
}

function openTranslationServiceDetail(host: PluginHost, index: number): void {
    const settings = host.store.state.settings;
    const services = settings.translationServices?.length ? settings.translationServices : defaultTranslationServices();
    const service = services[index];
    if (!service) return;
    const dialog = new Dialog({
        title: `翻译服务 · ${service.name}`,
        width: "620px",
        content: `<div class="b3-dialog__content">
  <div class="pz-muted" style="margin-bottom:10px">${escapeHtml(serviceHint(service.type))}</div>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>名称</span><input class="b3-text-field fn__block" data-s-field="name" value="${escapeHtml(service.name)}"/></label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>Base URL（留空使用默认）</span><input class="b3-text-field fn__block" data-s-field="baseURL" value="${escapeHtml(service.baseURL)}"/></label>
  <label class="fn__flex" style="flex-direction:column;gap:4px;margin-bottom:8px"><span>API Key / 凭证</span><input class="b3-text-field fn__block" data-s-field="apiKey" type="password" value="${escapeHtml(service.apiKey)}"/></label>
  <label class="fn__flex" style="flex-direction:column;gap:4px"><span>模型（OpenAI / 思源 AI）</span><input class="b3-text-field fn__block" data-s-field="model" value="${escapeHtml(service.model)}"/></label>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="save">保存</button></div>`,
    });
    dialog.element.querySelector('[data-act="cancel"]')?.addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector('[data-act="save"]')?.addEventListener("click", async () => {
        const value = (name: string): string => dialog.element.querySelector<HTMLInputElement>(`[data-s-field="${name}"]`)?.value.trim() || "";
        const next = services.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            name: value("name") || item.name,
            baseURL: value("baseURL"),
            apiKey: value("apiKey"),
            model: value("model"),
        } : item);
        host.store.updateSettings({translationServices: next});
        await host.store.save();
        dialog.destroy();
        showMessage("翻译服务已保存");
        // Reopen settings so the list reflects the edited service.
        settingsDialog?.destroy();
        settingsDialog = null;
        openSettings(host);
    });
}
