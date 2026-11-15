import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";

const win = globalThis.window && globalThis.document
    ? globalThis.window
    : (() => {
          
          const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "http://127.0.0.1:6806/", pretendToBeVisual: true});
          const created = dom.window;
          Object.defineProperty(globalThis, "window", {value: created, configurable: true});
          Object.defineProperty(globalThis, "document", {value: created.document, configurable: true});
          Object.defineProperty(globalThis, "navigator", {value: created.navigator, configurable: true});
          for (const key of ["HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "Blob", "File", "FileReader", "getComputedStyle"]) {
              if (created[key] !== undefined) {
                  Object.defineProperty(globalThis, key, {value: created[key], configurable: true});
              }
          }
          Object.defineProperty(globalThis, "localStorage", {value: created.localStorage, configurable: true});
          Object.defineProperty(globalThis, "sessionStorage", {value: created.sessionStorage, configurable: true});
          return created;
      })();
if (typeof win.requestAnimationFrame !== "function") {
    win.requestAnimationFrame = callback => win.setTimeout(() => callback(Date.now()), 16);
}
if (typeof win.cancelAnimationFrame !== "function") {
    win.cancelAnimationFrame = handle => win.clearTimeout(handle);
}

const copied = [];
const clipboardImages = [];
Object.defineProperty(win.navigator, "clipboard", {
    value: {
        writeText: async text => { copied.push(String(text)); },
        read: async () => clipboardImages.map(blob => ({
            types: ["image/png"],
            getType: async () => blob,
        })),
    },
    configurable: true,
});

URL.createObjectURL = () => "blob:test";
URL.revokeObjectURL = () => {};

// Deterministic OCR engine responses for the "paste image then re-recognize" flow.
globalThis.fetch = async (url, init) => {
    const isOcr = String(url).endsWith("/ocr");
    if (isOcr) {
        const payload = JSON.parse(String(init?.body || "{}"));
        return {
            ok: true,
            status: 200,
            json: async () => ({
                ok: true,
                kind: "formula",
                markdown: "$x^2$",
                items: [{type: "formula", latex: "x^2", text: "x^2", confidence: 1}],
                elapsedMs: 12,
                engine: payload?.options?.engine || "texo",
            }),
        };
    }
    // health checks report a running service shaped like the real /health payload
    return {ok: true, status: 200, json: async () => ({ok: true, modelReady: true, engine: "texo", version: "test"})};
};

const {defaultState} = await import("../../.test-build/storage.mjs");
const {openOcrResultDialog} = await import("../../.test-build/ui-ocr-dialog.mjs");

function makeHost(settings) {
    const saved = [];
    return {
        store: {
            state: {settings, ocrHistory: []},
            async save() {
                saved.push({...settings});
            },
            updateSettings(patch) {
                Object.assign(settings, patch);
            },
        },
        saved,
        captureNoteInsertionTarget() {
            return {docId: ""};
        },
        getLastNoteDocId() {
            return "";
        },
    };
}

function baseSettings() {
    const settings = defaultState().settings;
    settings.ocrPreviewRenderer = "katex";
    settings.ocrFormulaFormat = "inline";
    settings.ocrAutoCopy = false;
    settings.ocrAutoCopyFormat = "latex";
    return settings;
}

function formulaResult(latex, extra = {}) {
    return {
        ok: true,
        kind: "formula",
        markdown: `$${latex}$`,
        items: [{type: "formula", latex, text: latex, confidence: 1}],
        elapsedMs: 123,
        tokens: 20,
        ...extra,
    };
}

const tick = (ms = 20) => new Promise(resolve => win.setTimeout(resolve, ms));

test("OCR result dialog renders Texo-style panes, tabs and actions", () => {
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult("E=mc^2"), {source: "clipboard", engine: "texo"});
    const root = dialog.element;

    assert.ok(root.querySelector('[data-pane="source"]'), "source pane exists");
    assert.ok(root.querySelector('[data-pane="render"]'), "render pane exists");
    assert.ok(root.querySelector('[data-role="ocr-text"]'), "editable latex textarea exists");
    // both panes are visible: LaTeX source on top, rendered preview below
    assert.equal(root.querySelector('[data-pane="source"]').hidden, false, "source pane is visible");
    assert.equal(root.querySelector('[data-pane="render"]').hidden, false, "render pane is visible");
    assert.ok(root.querySelector('[data-pane="source"] textarea[data-role="ocr-text"]'), "editor lives in the source pane");
    assert.equal(root.querySelectorAll(".pz-texo-pane-title").length, 2, "pane captions exist");
    assert.ok(root.querySelector(".pz-texo-head-right .pz-texo-pane-title"), "source title sits in the head row");
    assert.ok(root.querySelector("[data-pane='source'] .pz-texo-pane-title") === null, "source title is outside the box");
    assert.ok(root.querySelector('[data-role="copy-format"]'), "single copy format select");
    assert.equal(root.querySelector('[data-role="auto-copy-format"]'), null, "no duplicated auto-copy format select");
    assert.equal(root.querySelector('[data-act="copy-menu"]'), null, "no split copy menu");
    assert.ok(root.querySelector('[data-role="insert-format"]'), "insert format select kept");
    assert.deepEqual(Array.from(root.querySelectorAll(".pz-texo-tab")).map(tab => tab.dataset.tab), ["katex", "mathlive"], "two renderer tabs");
    assert.equal(root.querySelector('[data-role="renderer-toggle"]'), null, "no duplicated renderer toggle");
    for (const action of ["copy", "clear", "ocr-insert", "ocr-append", "ocr-replace", "ocr-favorite", "ocr-cancel"]) {
        assert.ok(root.querySelector(`[data-act="${action}"]`), `action ${action} exists`);
    }
    assert.equal(root.querySelector('[data-role="ocr-text"]').value, "E=mc^2");
    assert.equal(root.querySelector('[data-role="engine-badge"]').textContent, "Texo");
    assert.match(root.querySelector('[data-role="meta"]').textContent, /123 ms/);
    dialog.destroy();
});

test("OCR result dialog re-renders the preview when the editor changes", async () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult("a+b"), {source: "clipboard", engine: "texo"});
    const root = dialog.element;
    const textarea = root.querySelector('[data-role="ocr-text"]');
    const target = root.querySelector('[data-role="latex-render"]');
    textarea.value = "x^{2}+1";
    textarea.dispatchEvent(new win.Event("input", {bubbles: true}));
    await tick(260);
    assert.ok(target.querySelector(".katex"), "preview refreshed after editing");
    assert.ok(target.textContent.includes("x") || target.innerHTML.includes("x"), "edited formula rendered");
    assert.equal(root.querySelector('[data-pane="source"]').hidden, false, "source pane stays visible");
    dialog.destroy();
});

test("OCR result dialog renders KaTeX preview on the render tab", async () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult("\\frac{1}{2}"), {source: "clipboard", engine: "texo"});
    const root = dialog.element;
    const mathliveTab = Array.from(root.querySelectorAll(".pz-texo-tab")).find(tab => tab.dataset.tab === "mathlive");
    mathliveTab.click();
    await tick(40);
    const katexTab = Array.from(root.querySelectorAll(".pz-texo-tab")).find(tab => tab.dataset.tab === "katex");
    katexTab.click();
    await tick(90);
    const target = root.querySelector('[data-role="latex-render"]');
    assert.equal(root.querySelector('[data-pane="render"]').hidden, false);
    assert.ok(target.querySelector(".katex"), "KaTeX markup was rendered");
    dialog.destroy();
});

test("OCR result dialog copies LaTeX, Typst and shows truncation notice", async () => {
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult("\\frac{a}{b}", {truncated: true, finish: "limit"}), {
        source: "clipboard",
        engine: "texo",
    });
    const root = dialog.element;
    assert.match(root.querySelector('[data-role="meta"]').textContent, /长度上限/);

    copied.length = 0;
    root.querySelector('[data-act="copy"]').click();
    await tick();
    assert.deepEqual(copied, ["\\frac{a}{b}"], "plain LaTeX copied");

    copied.length = 0;
    const copyFormat = root.querySelector('[data-role="copy-format"]');
    copyFormat.value = "typst";
    root.querySelector('[data-act="copy"]').click();
    await tick();
    assert.equal(copied.length, 1);
    assert.ok(copied[0].includes("frac"), `typst conversion copied: ${copied[0]}`);
    dialog.destroy();
});

test("OCR result dialog reports fallback engine breadcrumbs and closes cleanly", () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult("x"), {
        source: "clipboard",
        engine: "pix2text",
        attempts: [
            {engine: "texo", ok: false, error: "服务不可用"},
            {engine: "pix2text", ok: true},
        ],
    });
    const root = dialog.element;
    assert.match(root.querySelector('[data-role="meta"]').textContent, /降级/);
    assert.equal(root.querySelector('[data-role="engine-badge"]').textContent, "Pix2Text");
    root.querySelector('[data-act="ocr-cancel"]').click();
    assert.equal(dialog.destroyed, true);
    assert.equal(document.querySelectorAll(".b3-dialog").length, 0);
});

test("text OCR results default to the editor tab and skip formula preview/auto copy", () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    const settings = baseSettings();
    settings.ocrAutoCopy = true;
    const host = makeHost(settings);
    const result = {
        ok: true,
        kind: "text",
        markdown: "where x is real",
        items: [{type: "text", latex: "", text: "where x is real", confidence: 0.9}],
        elapsedMs: 42,
    };
    copied.length = 0;
    const dialog = openOcrResultDialog(host, result, {source: "clipboard", engine: "pix2text"});
    const root = dialog.element;
    assert.equal(root.querySelector('[data-pane="source"]').hidden, false, "editor shown for text results");
    assert.equal(root.querySelector('[data-pane="render"]').hidden, false, "render pane stays in place");
    assert.match(root.querySelector('[data-role="latex-render"]').textContent, /文本/, "render pane explains there is no formula");
    assert.equal(root.querySelector('[data-role="ocr-text"]').value, "where x is real");
    assert.equal(copied.length, 0, "auto copy is skipped for text results");
    dialog.destroy();
});

test("MathLive renderer falls back with an error message when the bundle cannot load", async () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult("\\frac{1}{2}"), {source: "clipboard", engine: "texo"});
    const root = dialog.element;
    const mathliveTab = root.querySelector('[data-tab="mathlive"]');
    mathliveTab.click();
    await tick(40);
    const script = document.getElementById("pz-mathlive-script");
    assert.ok(script, "MathLive script was requested");
    script.dispatchEvent(new win.Event("error"));
    await tick(60);
    const target = root.querySelector('[data-role="latex-render"]');
    assert.match(target.textContent, /MathLive/, "fallback error is shown instead of a blank pane");
    // recovery: switching back to KaTeX re-renders normally
    root.querySelector('[data-tab="katex"]').click();
    await tick(80);
    assert.ok(target.querySelector(".katex"), "KaTeX renders again after MathLive failure");
    dialog.destroy();
});

test("paste button uses a clipboard image and re-runs recognition", async () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    clipboardImages.length = 0;
    clipboardImages.push(new win.Blob([new Uint8Array([137, 80, 78, 71])], {type: "image/png"}));
    const settings = baseSettings();
    settings.ocrEngines.texo = {enabled: true, dir: "D:/OCR/Texo", port: 8893, autoStart: true};
    settings.ocrFormulaOrder = ["texo", "unimernet", "pix2text"];
    const host = makeHost(settings);
    const dialog = openOcrResultDialog(host, formulaResult("a+b"), {source: "clipboard", engine: "texo"});
    const root = dialog.element;
    const textarea = root.querySelector('[data-role="ocr-text"]');
    assert.equal(textarea.value, "a+b");
    root.querySelector('[data-act="ocr-pick-image"]').click();
    await tick(120);
    assert.equal(textarea.value, "x^2", "clipboard image was recognized; status=" + root.querySelector('[data-role="status"]').textContent);
    assert.match(root.querySelector('[data-role="meta"]').textContent, /12 ms/);
    clipboardImages.length = 0;
    dialog.destroy();
});

test("insert format select offers SiYuan-style wrappers and copies them as Markdown", async () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult("\\frac{a}{b}"), {source: "clipboard", engine: "texo"});
    const root = dialog.element;
    const insertSelect = root.querySelector('[data-role="insert-format"]');
    assert.deepEqual(
        Array.from(insertSelect.options).map(option => option.value),
        ["inline", "display", "paren", "bracket", "align", "equation"],
        "insert styles match SiYuan math formats"
    );
    insertSelect.value = "bracket";
    copied.length = 0;
    root.querySelector('[data-role="copy-format"]').value = "markdown";
    root.querySelector('[data-act="copy"]').click();
    await tick();
    assert.equal(copied.length, 1);
    assert.ok(copied[0].startsWith("\\["), `bracket wrapper expected: ${copied[0]}`);
    assert.ok(copied[0].includes("frac"));
    dialog.destroy();
});

test("auto copy honours Latex wrapper formats", async () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    const settings = baseSettings();
    settings.ocrAutoCopy = true;
    settings.ocrAutoCopyFormat = "display";
    const host = makeHost(settings);
    copied.length = 0;
    const dialog = openOcrResultDialog(host, formulaResult("x^2"), {source: "clipboard", engine: "texo"});
    await tick(80);
    assert.equal(copied.length, 1, "auto copy ran once");
    assert.ok(copied[0].startsWith("$$"), `display wrapper expected: ${copied[0]}`);
    assert.ok(copied[0].trim().endsWith("$$"));
    dialog.destroy();
});

test("hidden overlays are actually hidden (CSS override regression guard)", async () => {
    const {CSS} = await import("../../.test-build/ui-styles.mjs");
    assert.ok(CSS.includes(".pz-texo-dialog [hidden]"), "dialog declares [hidden] display rule");
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult("x^2"), {source: "clipboard", engine: "texo"});
    const root = dialog.element;
    const busy = root.querySelector('[data-role="busy"]');
    assert.equal(busy.hidden, true, "busy overlay starts hidden");
    dialog.destroy();
});

test("long OCR formulas are pretty-printed, and the toggle restores the raw source", async () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    const longLatex = "\\left\\{\\begin{aligned} & & f(x)=\\frac{a}{b}+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z \\\\ & & g(x)=\\frac{c}{d} \\end{aligned}\\right.";
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult(longLatex), {source: "clipboard", engine: "texo"});
    const root = dialog.element;
    const textarea = root.querySelector('[data-role="ocr-text"]');
    assert.ok(textarea.value.includes("\n"), "long formula is displayed on multiple lines");
    assert.ok(textarea.value.includes("\\begin{aligned}\n"), "environment body starts on its own line");
    assert.ok(!textarea.value.includes("\\, \\,"), "repeated spacing commands are compressed");
    const toggle = root.querySelector('[data-role="auto-format"]');
    assert.equal(toggle.checked, true, "auto format is enabled by default");

    toggle.checked = false;
    toggle.dispatchEvent(new win.Event("change", {bubbles: true}));
    assert.equal(textarea.value, longLatex.replace(/\s+/g, " ").trim(), "raw source comes back when disabled");
    dialog.destroy();
});

test("short formulas stay on a single line and text results hide the format toggle", () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult("E=mc^2"), {source: "clipboard", engine: "texo"});
    const root = dialog.element;
    assert.equal(root.querySelector('[data-role="ocr-text"]').value, "E=mc^2");
    assert.equal(root.querySelector('[data-role="auto-format-row"]').hidden, false, "toggle visible for formulas");
    dialog.destroy();

    const textDialog = openOcrResultDialog(host, {
        ok: true,
        kind: "text",
        markdown: "plain text",
        items: [{type: "text", latex: "", text: "plain text", confidence: 0.9}],
        elapsedMs: 10,
    }, {source: "clipboard", engine: "pix2text"});
    assert.equal(textDialog.element.querySelector('[data-role="auto-format-row"]').hidden, true, "toggle hidden for text results");
    textDialog.destroy();
});

test("Escape and dialog close hide the MathLive virtual keyboard", () => {
    document.querySelectorAll(".b3-dialog").forEach(node => node.remove());
    let hidden = 0;
    win.MathVirtualKeyboard = {visible: true, hide() { hidden += 1; this.visible = false; }, show() { this.visible = true; }};
    const host = makeHost(baseSettings());
    const dialog = openOcrResultDialog(host, formulaResult("x^2"), {source: "clipboard", engine: "texo"});
    document.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    assert.equal(hidden, 1, "ESC hides the MathLive keyboard");
    dialog.destroy();
    assert.equal(hidden, 2, "closing the dialog hides the keyboard as well");
    delete win.MathVirtualKeyboard;
});
