import {Dialog, showMessage} from "siyuan";
import katex from "katex";
import {appendMarkdown} from "../api";
import {insertMarkdownAtCursor, replaceSelectionWithMarkdown} from "../siyuan";
import type {NoteInsertionTarget, PluginHost} from "../host";
import type {OcrEngineId, OcrHistoryEntry, Settings} from "../types";
import {ocrItemsToMarkdown, type OcrResult} from "../ocr/client";
import {addOcrHistory} from "../ocr/history";
import {latexToTypst} from "../ocr/convert";
import {formatLatex, shouldFormatLatex} from "../ocr/latex-format";
import {recognizeWithFallback, type OcrAttempt} from "../ocr/service";
import {engineConfig, OCR_ENGINE_DEFS} from "../ocr/engines";
import {pluginAssetUrl, requireNode} from "../runtime";

export interface OcrDialogOptions {
    imageBlob?: Blob;
    source: "pdf-region" | "clipboard";
    attachmentId?: string;
    page?: number;
    /** Engine that produced the current result, used for the header badge. */
    engine?: OcrEngineId;
    /** Engines tried before the result was produced (fallback breadcrumbs). */
    attempts?: OcrAttempt[];
    insertionTarget?: NoteInsertionTarget;
}

type LatexWrapFormat = "inline" | "display" | "paren" | "bracket" | "align" | "equation";
type CopyFormat = "latex" | "markdown" | "typst" | "mathml" | LatexWrapFormat;

const LATEX_WRAPPERS: Record<LatexWrapFormat, {before: string; after: string}> = {
    inline: {before: "$", after: "$"},
    display: {before: "$$\n", after: "\n$$"},
    paren: {before: "\\(", after: "\\)"},
    bracket: {before: "\\[", after: "\\]"},
    align: {before: "\\begin{align}\n", after: "\n\\end{align}"},
    equation: {before: "\\begin{equation}\n", after: "\n\\end{equation}"},
};

const COPY_FORMAT_LABELS: Record<CopyFormat, string> = {
    latex: "LaTeX",
    markdown: "Markdown",
    typst: "Typst",
    mathml: "MathML",
    inline: "$...$",
    display: "$$...$$",
    paren: "\\(...\\)",
    bracket: "\\[...\\]",
    align: "align 环境",
    equation: "equation 环境",
};

function isLatexWrapFormat(value: string): value is LatexWrapFormat {
    return value in LATEX_WRAPPERS;
}

function wrapLatex(latex: string, format: LatexWrapFormat): string {
    const wrapper = LATEX_WRAPPERS[format];
    return `${wrapper.before}${latex}${wrapper.after}`;
}
type Renderer = "katex" | "mathlive";

const MATHLIVE_SCRIPT_ID = "pz-mathlive-script";
const MATHLIVE_CSS_ID = "pz-mathlive-css";
const MATHLIVE_STATIC_CSS_ID = "pz-mathlive-static-css";
const KATEX_CSS_ID = "pz-katex-css";

let mathLivePromise: Promise<any> | null = null;

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch] as string));
}

function ensureStyle(id: string, href: string): void {
    if (document.getElementById(id)) {
        return;
    }
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
}

function ensureKatexCss(): void {
    ensureStyle(KATEX_CSS_ID, pluginAssetUrl("katex.min.css"));
}

/** Hide MathLive's virtual keyboard; it lives outside the dialog, so ESC/close must clean it up. */
function hideMathLiveKeyboard(): void {
    try {
        (window as any).MathVirtualKeyboard?.hide?.();
    } catch {
        // keyboard not loaded / already hidden
    }
}

/** Lazy-load the MathLive bundle from the plugin assets (MathML conversion + editor). */
function loadMathLive(): Promise<any> {
    if (mathLivePromise) {
        return mathLivePromise;
    }
    mathLivePromise = new Promise((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => fail(new Error("MathLive 加载超时（assets 可能未加载）")), 12_000);
        const succeed = (api: any) => {
            if (settled) {
                return;
            }
            settled = true;
            window.clearTimeout(timer);
            resolve(api);
        };
        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            window.clearTimeout(timer);
            mathLivePromise = null;
            reject(error);
        };
        const global = window as any;
        if (global.MathLive?.convertLatexToMathMl) {
            succeed(global.MathLive);
            return;
        }
        ensureStyle(MATHLIVE_CSS_ID, pluginAssetUrl("mathlive/mathlive-fonts.css"));
        ensureStyle(MATHLIVE_STATIC_CSS_ID, pluginAssetUrl("mathlive/mathlive-static.css"));
        const done = () => {
            const api = (window as any).MathLive;
            if (!api) {
                fail(new Error("MathLive 加载失败"));
                return;
            }
            try {
                if ((window as any).MathfieldElement) {
                    (window as any).MathfieldElement.fontsDirectory = pluginAssetUrl("mathlive/fonts/");
                }
            } catch {
                // fonts can fall back to the CSS relative path
            }
            succeed(api);
        };
        const existing = document.getElementById(MATHLIVE_SCRIPT_ID) as HTMLScriptElement | null;
        if (existing) {
            existing.addEventListener("load", () => done(), {once: true});
            existing.addEventListener("error", () => fail(new Error("MathLive 脚本加载失败")), {once: true});
            return;
        }
        const script = document.createElement("script");
        script.id = MATHLIVE_SCRIPT_ID;
        script.src = pluginAssetUrl("mathlive/mathlive.min.js");
        script.onload = () => done();
        script.onerror = () => fail(new Error("MathLive 脚本加载失败"));
        document.head.append(script);
    });
    return mathLivePromise;
}

function splitFormulaMarkdown(markdown: string): {latex: string; text: string} {
    const latexParts: string[] = [];
    const textParts: string[] = [];
    const pattern = /\$\$([\s\S]+?)\$\$|\$([\s\S]+?)\$/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(markdown)) !== null) {
        const before = markdown.slice(lastIndex, match.index).trim();
        if (before) {
            textParts.push(before);
        }
        latexParts.push((match[1] ?? match[2] ?? "").trim());
        lastIndex = match.index + match[0].length;
    }
    const tail = markdown.slice(lastIndex).trim();
    if (tail) {
        textParts.push(tail);
    }
    return {latex: latexParts.join("\n"), text: textParts.join("\n")};
}

function normalizeLatex(value: string): string {
    return value.replace(/^\s*\$\$?/, "").replace(/\$\$?\s*$/, "").trim();
}

interface SampleImage {
    name: string;
    blob: Blob;
}

function loadSampleImages(host: PluginHost, engine: OcrEngineId | undefined): SampleImage[] {
    const fs = requireNode("fs");
    const path = requireNode("path");
    if (!fs?.existsSync || !path?.join || !engine) {
        return [];
    }
    const dir = engineConfig(host.store.state.settings, engine).dir;
    if (!dir) {
        return [];
    }
    const sampleDir = path.join(dir, "samples");
    try {
        if (!fs.existsSync(sampleDir) || !fs.statSync(sampleDir).isDirectory()) {
            return [];
        }
        const names = fs.readdirSync(sampleDir)
            .filter((name: string) => /\.(png|jpe?g|webp)$/i.test(name))
            .slice(0, 3);
        return names.map((name: string) => {
            const data = new Uint8Array(fs.readFileSync(path.join(sampleDir, name)));
            const buffer = new ArrayBuffer(data.byteLength);
            new Uint8Array(buffer).set(data);
            const type = /\.png$/i.test(name) ? "image/png" : "image/jpeg";
            return {name, blob: new Blob([buffer], {type})};
        });
    } catch {
        return [];
    }
}

export function openOcrResultDialog(host: PluginHost, result: OcrResult, options: OcrDialogOptions): Dialog {
    const settings = host.store.state.settings;
    let currentResult = result;
    let currentBlob = options.imageBlob;
    let currentEngine = options.engine;
    let currentAttempts = options.attempts || [];
    const initialSplit = splitFormulaMarkdown(result.markdown || ocrItemsToMarkdown(result, settings.ocrFormulaFormat));
    const initialLatex = normalizeLatex(initialSplit.latex || result.items.find(item => item.type === "formula")?.latex || "");
    // Text / mixed results have no formula: edit the raw text instead of an empty LaTeX box.
    const initialText = (result.markdown || result.items.filter(item => item.type === "text").map(item => item.text).join("\n")).trim();
    let currentLatex = initialLatex || (result.kind === "formula" ? "" : initialText);
    let renderer: Renderer = settings.ocrPreviewRenderer === "mathlive" ? "mathlive" : "katex";
    let autoCopy = settings.ocrAutoCopy === true;
    let autoFormat = true;
    let autoCopyFormat: CopyFormat = (settings.ocrAutoCopyFormat === "typst" || settings.ocrAutoCopyFormat === "mathml" || isLatexWrapFormat(String(settings.ocrAutoCopyFormat || "")))
        ? settings.ocrAutoCopyFormat as CopyFormat
        : "latex";
    let mathField: HTMLElement | null = null;
    let renderToken = 0;
    let renderTimer = 0;
    let imageUrl = "";
    let busy = false;

    ensureKatexCss();

    const dialog = new Dialog({
        title: "OCR 识别结果",
        width: "900px",
        content: `<div class="b3-dialog__content pz-texo-dialog">
  <div class="pz-texo-head">
    <div class="pz-texo-head-left">
      <span class="pz-texo-engine" data-role="engine-badge"></span>
      <span class="pz-texo-meta" data-role="meta"></span>
    </div>
    <div class="pz-texo-head-right">
      <span class="pz-texo-pane-title">LaTeX 源码</span>
      <span class="fn__space"></span>
      <label class="pz-texo-auto-format" data-role="auto-format-row" title="超长公式自动换行缩进，渲染结果不变"><input type="checkbox" data-role="auto-format" checked /> 自动排版</label>
      <div class="pz-texo-tabs">
        <button class="pz-texo-tab${settings.ocrPreviewRenderer === "mathlive" ? "" : " is-active"}" data-tab="katex">KaTeX</button>
        <button class="pz-texo-tab${settings.ocrPreviewRenderer === "mathlive" ? " is-active" : ""}" data-tab="mathlive">MathLive</button>
      </div>
    </div>
  </div>
  <div class="pz-texo-body">
    <div class="pz-texo-left">
      <div class="pz-texo-image" data-role="dropzone">
        <img data-role="ocr-image" alt="OCR source" />
        <div class="pz-texo-busy" data-role="busy" hidden>识别中…</div>
      </div>
      <div class="pz-texo-image-actions">
        <button class="b3-button b3-button--outline pz-texo-small" data-act="ocr-pick-image">粘贴 / 选择图片</button>
        <span class="pz-texo-samples" data-role="samples"></span>
      </div>
      <div class="pz-texo-image-hint">可直接粘贴（Ctrl+V）、拖拽图片到此处，或点上方按钮换图重新识别</div>
      <input type="file" accept="image/*" data-role="file" hidden />
    </div>
    <div class="pz-texo-right">
      <div class="pz-texo-pane pz-texo-source" data-pane="source"><textarea class="b3-text-field fn__block pz-texo-editor" data-role="ocr-text" rows="5" spellcheck="false" placeholder="LaTeX 公式"></textarea></div>
      <div class="pz-texo-pane-title-row"><span class="pz-texo-pane-title">渲染 <span data-role="renderer-label">KaTeX</span></span></div>
      <div class="pz-texo-pane pz-texo-render" data-pane="render"><div data-role="latex-render"></div></div>
      <div class="pz-texo-status" data-role="status"></div>
    </div>
  </div>
  <div class="pz-texo-actions">
    <button class="b3-button b3-button--outline pz-texo-small" data-act="copy">复制</button>
    <select class="b3-select pz-texo-select pz-texo-copy-format" data-role="copy-format" title="复制 / 自动复制使用的格式（也可在设置里改默认值）">
      <option value="latex">LaTeX</option>
      <option value="inline">$...$</option>
      <option value="display">$$...$$</option>
      <option value="paren">\\(...\\)</option>
      <option value="bracket">\\[...\\]</option>
      <option value="align">align</option>
      <option value="equation">equation</option>
      <option value="markdown">Markdown</option>
      <option value="typst">Typst</option>
      <option value="mathml">MathML</option>
    </select>
    <button class="b3-button b3-button--outline pz-texo-small" data-act="clear">清除</button>
    <label class="pz-texo-auto"><input type="checkbox" data-role="auto-copy" /> 自动复制</label>
    <span class="pz-texo-sep" aria-hidden="true"></span>
    <label class="pz-texo-insert-format"><span>插入</span><select class="b3-select pz-texo-select" data-role="insert-format">
      <option value="inline">$...$</option>
      <option value="display">$$...$$</option>
      <option value="paren">\\(...\\)</option>
      <option value="bracket">\\[...\\]</option>
      <option value="align">align</option>
      <option value="equation">equation</option>
    </select></label>
    <span class="fn__space"></span>
    <button class="b3-button b3-button--outline pz-texo-small" data-act="ocr-favorite">收藏</button>
    <button class="b3-button b3-button--outline pz-texo-small" data-act="ocr-append">追加笔记</button>
    <button class="b3-button b3-button--outline pz-texo-small" data-act="ocr-replace">替换选区</button>
    <button class="b3-button b3-button--text pz-texo-small" data-act="ocr-insert">插入光标</button>
    <button class="b3-button b3-button--cancel pz-texo-small" data-act="ocr-cancel">关闭</button>
  </div>
</div>`,
    });
    const root = dialog.element;
    const image = root.querySelector<HTMLImageElement>('[data-role="ocr-image"]')!;
    const dropzone = root.querySelector<HTMLElement>('[data-role="dropzone"]')!;
    const busyEl = root.querySelector<HTMLElement>('[data-role="busy"]')!;
    const fileInput = root.querySelector<HTMLInputElement>('[data-role="file"]')!;
    const samplesEl = root.querySelector<HTMLElement>('[data-role="samples"]')!;
    const renderPane = root.querySelector<HTMLElement>('[data-pane="render"]')!;
    const renderTarget = root.querySelector<HTMLElement>('[data-role="latex-render"]')!;
    const textarea = root.querySelector<HTMLTextAreaElement>('[data-role="ocr-text"]')!;
    const statusEl = root.querySelector<HTMLElement>('[data-role="status"]')!;
    const engineBadge = root.querySelector<HTMLElement>('[data-role="engine-badge"]')!;
    const metaEl = root.querySelector<HTMLElement>('[data-role="meta"]')!;
    type DialogView = "katex" | "mathlive";
    let activeView: DialogView = settings.ocrPreviewRenderer === "mathlive" ? "mathlive" : "katex";
    const rendererLabel = root.querySelector<HTMLElement>('[data-role="renderer-label"]')!;
    const autoCopyInput = root.querySelector<HTMLInputElement>('[data-role="auto-copy"]')!;
    const copyFormatSelect = root.querySelector<HTMLSelectElement>('[data-role="copy-format"]')!;
    const insertFormatSelect = root.querySelector<HTMLSelectElement>('[data-role="insert-format"]')!;
    const tabs = Array.from(root.querySelectorAll<HTMLElement>(".pz-texo-tab"));

    const syncViewButtons = () => {
        for (const item of tabs) {
            item.classList.toggle("is-active", item.dataset.tab === activeView);
        }
        rendererLabel.textContent = activeView === "mathlive" ? "MathLive" : "KaTeX";
    };
    syncViewButtons();
    insertFormatSelect.value = settings.ocrFormulaFormat === "display" ? "display" : "inline";
    autoCopyInput.checked = autoCopy;
    copyFormatSelect.value = autoCopyFormat;

    const setStatus = (text: string, tone: "info" | "warn" | "error" = "info") => {
        statusEl.textContent = text;
        statusEl.dataset.tone = tone;
    };

    const setBusy = (next: boolean) => {
        busy = next;
        busyEl.hidden = !next;
        dropzone.classList.toggle("is-busy", next);
    };

    const updateEngineBadge = () => {
        const def = currentEngine ? OCR_ENGINE_DEFS[currentEngine] : undefined;
        engineBadge.textContent = def ? def.name : "未知引擎";
        const parts: string[] = [];
        if (typeof currentResult.elapsedMs === "number" && currentResult.elapsedMs > 0) {
            parts.push(`${currentResult.elapsedMs} ms`);
        }
        if (typeof currentResult.tokens === "number" && currentResult.tokens > 0) {
            parts.push(`${currentResult.tokens} tokens`);
        }
        if (currentResult.truncated) {
            parts.push(currentResult.finish === "repeat" ? "疑似非公式输入，已截断" : "达到长度上限，结果可能不完整");
        }
        if (currentAttempts.length > 1) {
            const failed = currentAttempts.filter(attempt => !attempt.ok && !attempt.skipped);
            if (failed.length) {
                parts.push(`已从 ${failed.map(attempt => OCR_ENGINE_DEFS[attempt.engine].name).join(" / ")} 降级`);
            }
        }
        metaEl.textContent = parts.join(" · ");
        metaEl.dataset.tone = currentResult.truncated ? "warn" : "info";
    };

    const isFormulaResult = currentResult.kind === "formula";

    const renderPreview = async () => {
        const tex = normalizeLatex(textarea.value);
        if (!isFormulaResult) {
            renderTarget.innerHTML = `<span class="pz-texo-placeholder">这是文本识别结果，没有公式预览；可在「LaTeX 源码」里编辑后插入笔记</span>`;
            return;
        }
        const token = ++renderToken;
        renderTarget.innerHTML = "";
        mathField = null;
        if (!tex) {
            renderTarget.innerHTML = `<span class="pz-texo-placeholder">输入 LaTeX 公式以预览</span>`;
            return;
        }
        if (renderer === "katex") {
            try {
                (katex as any).render(tex, renderTarget, {displayMode: true, throwOnError: false, errorColor: "#d14343", strict: false});
            } catch (error: any) {
                renderTarget.innerHTML = `<pre class="pz-texo-error">${escapeHtml(String(error?.message || error))}</pre>`;
            }
            return;
        }
        try {
            const mathLive = await loadMathLive();
            if (token !== renderToken) {
                return;
            }
            const MathfieldElement = (window as any).MathfieldElement;
            if (!MathfieldElement) {
                throw new Error("MathLive 未提供 math-field 元素");
            }
            const field = document.createElement("math-field") as HTMLElement;
            field.setAttribute("class", "pz-texo-mathfield");
            (field as any).mathVirtualKeyboardPolicy = "manual";
            (field as any).value = tex;
            field.addEventListener("input", () => {
                if (busy) {
                    return;
                }
                const value = String((field as any).value || "");
                if (value !== textarea.value) {
                    textarea.value = value;
                }
            });
            renderTarget.append(field);
            mathField = field;
            void mathLive;
        } catch (error: any) {
            renderTarget.innerHTML = `<pre class="pz-texo-error">MathLive 加载失败：${escapeHtml(String(error?.message || error))}</pre>`;
        }
    };

    const scheduleRender = () => {
        window.clearTimeout(renderTimer);
        renderTimer = window.setTimeout(() => { void renderPreview(); }, 180);
    };

    let rawLatex = "";

    const formatForDisplay = (latex: string): string =>
        autoFormat && currentResult.kind === "formula" && shouldFormatLatex(latex) ? formatLatex(latex) : latex;

    /** Prefer the raw OCR source for inline wrappers / conversions, unless the user edited it. */
    const unformattedOrEdited = (): string => {
        const current = normalizeLatex(textarea.value);
        if (!rawLatex) {
            return current;
        }
        const raw = normalizeLatex(rawLatex);
        const formatted = normalizeLatex(formatForDisplay(rawLatex));
        return current === formatted || current === raw ? raw : current;
    };

    const applyRecognitionLatex = (latex: string): void => {
        rawLatex = latex;
        syncFromTextarea(formatForDisplay(latex));
    };

    const syncFromTextarea = (value: string) => {
        textarea.value = value;
        if (mathField && renderer === "mathlive" && String((mathField as any).value || "") !== value) {
            (mathField as any).value = value;
        }
        scheduleRender();
    };

    const setImage = (blob: Blob | undefined) => {
        currentBlob = blob;
        if (imageUrl) {
            URL.revokeObjectURL(imageUrl);
            imageUrl = "";
        }
        if (!blob) {
            image.hidden = true;
            return;
        }
        image.hidden = false;
        imageUrl = URL.createObjectURL(blob);
        image.src = imageUrl;
    };

    const formatForCopy = async (format: CopyFormat): Promise<string> => {
        const tex = normalizeLatex(textarea.value);
        const rawTex = unformattedOrEdited();
        if (format === "markdown") {
            return markdownForInsertion() || tex;
        }
        if (isLatexWrapFormat(format)) {
            const isInlineWrapper = format === "inline" || format === "paren";
            return wrapLatex(isInlineWrapper ? rawTex : tex, format);
        }
        if (format === "typst") {
            const converted = latexToTypst(rawTex);
            if (converted.unsupported.length) {
                setStatus(`Typst 已复制（${converted.unsupported.length} 处语法降级：${converted.unsupported.slice(0, 3).join(" ")}）`, "warn");
            }
            return converted.typst;
        }
        if (format === "mathml") {
            const mathLive = await loadMathLive();
            return String(mathLive.convertLatexToMathMl(rawTex) || "");
        }
        return tex;
    };

    const copyText = async (text: string) => {
        await navigator.clipboard.writeText(text);
    };

    const copyAs = async (format: CopyFormat) => {
        try {
            const value = await formatForCopy(format);
            await copyText(value);
            if (format !== "typst") {
                setStatus(`已复制 ${COPY_FORMAT_LABELS[format]}`);
            }
        } catch (error: any) {
            setStatus(`复制失败：${error?.message || String(error)}`, "error");
        }
    };

    const autoCopyIfNeeded = async () => {
        if (!autoCopy || !isFormulaResult) {
            return;
        }
        try {
            const value = await formatForCopy(autoCopyFormat);
            await copyText(value);
            setStatus(`已自动复制为 ${autoCopyFormat}`);
        } catch (error: any) {
            setStatus(`自动复制失败：${error?.message || String(error)}`, "error");
        }
    };

    const markdownForInsertion = (): string => {
        const tex = normalizeLatex(textarea.value);
        if (!tex) {
            return "";
        }
        if (currentResult.kind === "formula") {
            const style = isLatexWrapFormat(insertFormatSelect.value) ? insertFormatSelect.value : "inline";
            const isInlineWrapper = style === "inline" || style === "paren";
            return wrapLatex(isInlineWrapper ? unformattedOrEdited() : tex, style);
        }
        return textarea.value.trim();
    };

    const applyResult = (next: OcrResult, engine?: OcrEngineId, attempts?: OcrAttempt[]) => {
        currentResult = next;
        if (engine) {
            currentEngine = engine;
        }
        if (attempts) {
            currentAttempts = attempts;
        }
        const split = splitFormulaMarkdown(next.markdown || ocrItemsToMarkdown(next, settings.ocrFormulaFormat));
        const latex = normalizeLatex(split.latex || next.items.find(item => item.type === "formula")?.latex || "");
        applyRecognitionLatex(latex);
        updateEngineBadge();
        if (next.notice) {
            setStatus(next.notice, "warn");
        }
    };

    const reRecognize = async (blob: Blob) => {
        if (busy) {
            return;
        }
        setImage(blob);
        setBusy(true);
        setStatus("正在识别新图片…");
        try {
            // Re-dropping an image inside this dialog is a formula workflow: "auto"
            // mode would route to the text engine (Pix2Text) and ignore Texo/UniMERNet.
            const mode: "formula" | "text" | "auto" = currentResult.kind === "formula"
                ? "formula"
                : (settings.ocrDefaultMode === "formula" ? "formula" : settings.ocrDefaultMode);
            const outcome = await recognizeWithFallback(host.store.state.settings, blob, {
                mode,
                source: options.source,
            });
            applyResult(outcome.result, outcome.engine, outcome.attempts);
            setStatus("识别完成");
            await autoCopyIfNeeded();
        } catch (error: any) {
            setStatus(`识别失败：${error?.message || String(error)}`, "error");
        } finally {
            setBusy(false);
        }
    };

    const readClipboardImage = async (): Promise<Blob | null> => {
        try {
            if (!navigator.clipboard?.read) {
                return null;
            }
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const type = item.types.find(candidate => candidate.startsWith("image/"));
                if (type) {
                    return await item.getType(type);
                }
            }
        } catch {
            return null;
        }
        return null;
    };
    const pickImageFile = async () => {
        const pasted = await readClipboardImage();
        if (pasted) {
            void reRecognize(pasted);
            return;
        }
        fileInput.value = "";
        fileInput.click();
    };

    fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (file) {
            void reRecognize(file);
        }
    });
    root.querySelector('[data-act="ocr-pick-image"]')?.addEventListener("click", pickImageFile);
    dropzone.addEventListener("click", pickImageFile);
    dropzone.addEventListener("dragover", event => {
        event.preventDefault();
        dropzone.classList.add("is-dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover"));
    dropzone.addEventListener("drop", event => {
        event.preventDefault();
        dropzone.classList.remove("is-dragover");
        const file = event.dataTransfer?.files?.[0];
        if (file && file.type.startsWith("image/")) {
            void reRecognize(file);
        }
    });
    const onPaste = (event: ClipboardEvent) => {
        const item = Array.from(event.clipboardData?.items || []).find(entry => entry.type.startsWith("image/"));
        const file = item?.getAsFile();
        if (file) {
            event.preventDefault();
            void reRecognize(file);
        }
    };
    document.addEventListener("paste", onPaste);

    samplesEl.replaceChildren();
    const samples = loadSampleImages(host, currentEngine || "texo");
    if (!samples.length) {
        samplesEl.hidden = true;
    } else {
        samplesEl.hidden = false;
        const label = document.createElement("span");
        label.className = "pz-texo-samples-label";
        label.textContent = "示例图片：";
        samplesEl.append(label);
        for (const sample of samples) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "b3-button b3-button--outline pz-texo-small";
            button.textContent = sample.name.replace(/\.[^.]+$/, "");
            button.addEventListener("click", () => void reRecognize(sample.blob));
            samplesEl.append(button);
        }
    }

    const switchRendererView = (target: DialogView, persist = true) => {
        activeView = target;
        renderer = target;
        if (persist) {
            host.store.updateSettings({ocrPreviewRenderer: target});
            void host.store.save();
        }
        syncViewButtons();
        void renderPreview();
    };
    const autoFormatInput = root.querySelector<HTMLInputElement>('[data-role="auto-format"]')!;
    const autoFormatRow = root.querySelector<HTMLElement>('[data-role="auto-format-row"]')!;
    autoFormatRow.hidden = !isFormulaResult;
    autoFormatInput.addEventListener("change", () => {
        autoFormat = autoFormatInput.checked;
        if (rawLatex) {
            syncFromTextarea(formatForDisplay(rawLatex));
        } else {
            syncFromTextarea(textarea.value);
        }
    });
    for (const tab of tabs) {
        tab.addEventListener("click", () => {
            switchRendererView(tab.dataset.tab === "mathlive" ? "mathlive" : "katex");
        });
    }
    autoCopyInput.addEventListener("change", () => {
        autoCopy = autoCopyInput.checked;
        host.store.updateSettings({ocrAutoCopy: autoCopy});
        void host.store.save();
    });
    copyFormatSelect.addEventListener("change", () => {
        const value = copyFormatSelect.value;
        autoCopyFormat = (value === "typst" || value === "mathml" || value === "markdown" || isLatexWrapFormat(value))
            ? value as CopyFormat
            : "latex";
        host.store.updateSettings({ocrAutoCopyFormat: autoCopyFormat as Settings["ocrAutoCopyFormat"]});
        void host.store.save();
    });
    textarea.addEventListener("input", () => {
        if (mathField && renderer === "mathlive" && String((mathField as any).value || "") !== textarea.value) {
            (mathField as any).value = textarea.value;
        }
        scheduleRender();
    });
    root.querySelector('[data-act="copy"]')?.addEventListener("click", () => {
        const value = copyFormatSelect.value;
        const format: CopyFormat = (value === "typst" || value === "mathml" || value === "markdown" || isLatexWrapFormat(value))
            ? value as CopyFormat
            : "latex";
        void copyAs(format);
    });
    root.querySelector('[data-act="clear"]')?.addEventListener("click", () => {
        rawLatex = "";
        syncFromTextarea("");
        renderTarget.innerHTML = "";
        setStatus("已清除");
    });

    let history: OcrHistoryEntry | null = null;
    let closed = false;
    const onEscape = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
            hideMathLiveKeyboard();
        }
    };
    document.addEventListener("keydown", onEscape, true);

    const close = () => {
        if (closed) {
            return;
        }
        closed = true;
        document.removeEventListener("paste", onPaste);
        document.removeEventListener("keydown", onEscape, true);
        hideMathLiveKeyboard();
        if (imageUrl) {
            URL.revokeObjectURL(imageUrl);
            imageUrl = "";
        }
        dialog.destroy();
    };
    const record = async (favorite = false): Promise<OcrHistoryEntry> => {
        const markdown = markdownForInsertion() || textarea.value;
        if (history) {
            history.markdown = markdown;
            if (favorite) {
                history.favorite = true;
            }
            await host.store.save();
            return history;
        }
        history = await addOcrHistory(host.store, {
            kind: currentResult.kind,
            latex: currentResult.items.filter(item => item.type === "formula").map(item => item.latex || item.text).join("\n") || normalizeLatex(textarea.value),
            text: currentResult.items.filter(item => item.type === "text").map(item => item.text).join("\n"),
            markdown,
            source: options.source,
            attachmentId: options.attachmentId,
            page: options.page,
        });
        if (favorite) {
            history.favorite = true;
            await host.store.save();
        }
        return history;
    };
    const target = options.insertionTarget || host.captureNoteInsertionTarget();

    root.querySelector('[data-act="ocr-cancel"]')?.addEventListener("click", close);
    root.querySelector('[data-act="ocr-favorite"]')?.addEventListener("click", async () => {
        try {
            await record(true);
            showMessage("已收藏 OCR 结果", 2000);
        } catch (error: any) {
            showMessage(`收藏失败：${error?.message || String(error)}`, 4000, "error");
        }
    });
    root.querySelector('[data-act="ocr-append"]')?.addEventListener("click", async () => {
        try {
            await record();
            const docId = target.docId || host.getLastNoteDocId();
            if (!docId) {
                showMessage("请先打开一个思源笔记", 3000, "error");
                return;
            }
            await appendMarkdown(docId, markdownForInsertion());
            showMessage("OCR 结果已追加到笔记末尾", 2500);
            close();
        } catch (error: any) {
            showMessage(`追加失败：${error?.message || String(error)}`, 4000, "error");
        }
    });
    root.querySelector('[data-act="ocr-replace"]')?.addEventListener("click", async () => {
        try {
            await record();
            const replaced = await replaceSelectionWithMarkdown(markdownForInsertion(), target);
            if (!replaced) {
                showMessage("替换失败，请重新选择笔记中的文本后重试", 4000, "error");
                return;
            }
            showMessage("OCR 结果已替换当前选区", 2000);
            close();
        } catch (error: any) {
            showMessage(`替换失败：${error?.message || String(error)}`, 4000, "error");
        }
    });
    root.querySelector('[data-act="ocr-insert"]')?.addEventListener("click", async () => {
        try {
            await record();
            const blockId = await insertMarkdownAtCursor(markdownForInsertion(), target);
            if (!blockId) {
                showMessage("OCR 结果已保存，但插入笔记失败", 4000, "error");
                return;
            }
            showMessage("OCR 结果已插入笔记", 2000);
            close();
        } catch (error: any) {
            showMessage(`插入失败：${error?.message || String(error)}`, 4000, "error");
        }
    });

    setImage(currentBlob);
    applyRecognitionLatex(currentLatex);
    updateEngineBadge();
    switchRendererView(activeView, false);
    if (!currentLatex) {
        setStatus("没有识别到公式，可在下方手动输入 LaTeX", "warn");
    }
    void renderPreview();
    void autoCopyIfNeeded();
    const destroyDialog = dialog.destroy.bind(dialog);
    dialog.destroy = (...args: any[]) => {
        document.removeEventListener("keydown", onEscape, true);
        hideMathLiveKeyboard();
        return destroyDialog(...args);
    };
    return dialog;
}
