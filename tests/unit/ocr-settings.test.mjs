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
if (typeof globalThis.requestAnimationFrame !== "function") {
    Object.defineProperty(globalThis, "requestAnimationFrame", {value: win.requestAnimationFrame, configurable: true});
}
if (typeof win.Element.prototype.scrollIntoView !== "function") {
    win.Element.prototype.scrollIntoView = () => {};
}

const {defaultState} = await import("../../.test-build/storage.mjs");
const {openSettings} = await import("../../.test-build/ui-dock.mjs");

const tick = (ms = 25) => new Promise(resolve => win.setTimeout(resolve, ms));
const settle = () => tick(560);

function makeHost() {
    const settings = defaultState().settings;
    const patches = [];
    let saves = 0;
    const host = {
        name: "siyuan-pdf-zotero",
        store: {
            state: {settings, ocrHistory: []},
            async save() {
                saves += 1;
                return true;
            },
            updateSettings(patch) {
                patches.push(patch);
                Object.assign(settings, patch);
            },
            translationOutputs() {
                return [];
            },
        },
        patches,
        saves: () => saves,
        settings,
        refreshDock() {},
        restartAutomation() {},
        logDebug() {},
        getLastNoteDocId: () => "",
        captureNoteInsertionTarget: () => ({docId: ""}),
        openAttachment() {},
        activateReader() {},
        importLocalPdfFromPicker: async () => {},
        importLocalPath: async () => null,
        refreshZotero: async () => {},
        openZoteroItem: async () => {},
        openDoc() {},
        openNoteBlock: async () => {},
        openCitationDialog() {},
        ocrClipboardImage() {},
        relinkAttachment: async () => {},
    };
    return host;
}

function openDialog(host) {
    openSettings(host);
    const dialog = document.querySelector('[data-test-dialog="1"]');
    assert.ok(dialog, "settings dialog opened");
    return dialog;
}

function closeDialog(dialog) {
    dialog.querySelector('[data-act="cancel"]')?.click();
    dialog.remove();
}

test("settings dialog renders five pages, subtabs and fold blocks", () => {
    const host = makeHost();
    const dialog = openDialog(host);
    const nav = Array.from(dialog.querySelectorAll("[data-settings-tab]"));
    assert.deepEqual(nav.map(button => button.dataset.settingsTab), ["connection", "translation", "ocr", "ai", "advanced"]);
    assert.equal(nav.filter(button => button.classList.contains("is-active")).length, 1);

    const translation = dialog.querySelector('[data-settings-page="translation"]');
    assert.equal(translation.querySelectorAll("[data-settings-subtab]").length, 3, "selection / whole / service subtabs");
    assert.equal(translation.querySelectorAll("[data-settings-subpage]").length, 3);
    const ai = dialog.querySelector('[data-settings-page="ai"]');
    assert.equal(ai.querySelectorAll("[data-settings-subtab]").length, 2, "qa / automation subtabs");

    const ocrPage = dialog.querySelector('[data-settings-page="ocr"]');
    assert.equal(ocrPage.querySelectorAll("details.pz-ocr-section").length, 3, "engine / routing / behaviour blocks");
    const cards = Array.from(dialog.querySelectorAll("[data-ocr-engine]"));
    assert.deepEqual(cards.map(card => card.dataset.ocrEngine), ["pix2text", "unimernet", "texo"]);
    for (const id of ["pix2text", "unimernet", "texo"]) {
        const card = dialog.querySelector(`[data-ocr-engine="${id}"]`);
        for (const act of ["engine-pick-dir", "engine-check", "engine-start", "engine-stop", "engine-restart"]) {
            assert.ok(card.querySelector(`[data-act="${act}"]`), `${id} keeps ${act}`);
        }
    }
    assert.equal(dialog.querySelector('[data-act="save"]'), null, "no save button any more");
    assert.ok(dialog.querySelector('[data-act="cancel"]'), "close button exists");
    assert.equal(dialog.querySelector('[data-act="ocr-history"]'), null, "OCR history moved out of settings");
    assert.ok(dialog.querySelector('[data-role="settings-search"]'), "search box exists");
    closeDialog(dialog);
});

test("advanced page exposes legacy OCR settings and the debug switch", () => {
    const host = makeHost();
    const dialog = openDialog(host);
    const advanced = dialog.querySelector('[data-settings-page="advanced"]');
    assert.ok(advanced.querySelector('[data-field="ocrMfdModel"]'), "legacy MFD model field moved here");
    assert.ok(advanced.querySelector('[data-field="unimernetPath"]'), "legacy UniMERNet path moved here");
    assert.ok(advanced.querySelector('[data-field="automationDebug"]'), "debug switch lives in advanced");
    closeDialog(dialog);
});

test("translation target languages expose a shared default with follow options", () => {
    const host = makeHost();
    const dialog = openDialog(host);
    const defaultSelect = dialog.querySelector('[data-field="translationDefaultTargetLang"]');
    assert.ok(defaultSelect, "shared default target field exists");
    assert.equal(defaultSelect.value, "zh-CN");
    for (const name of ["translationTargetLang", "pdf2zhTargetLang", "doc2xTargetLang"]) {
        const select = dialog.querySelector(`[data-field="${name}"]`);
        assert.ok(select, `${name} select exists`);
        assert.equal(select.options[0].value, "", `${name} has a follow-default option`);
        assert.match(select.options[0].textContent, /跟随默认/);
    }
    closeDialog(dialog);
});

test("search jumps to the owning page and highlights the match", async () => {
    const host = makeHost();
    const dialog = openDialog(host);
    const search = dialog.querySelector('[data-role="settings-search"]');
    search.value = "Texo";
    search.dispatchEvent(new win.Event("input", {bubbles: true}));
    const results = dialog.querySelector('[data-role="search-results"]');
    assert.equal(results.hidden, false, "results panel opened");
    const hits = Array.from(results.querySelectorAll("[data-search-index]"));
    assert.ok(hits.length >= 1, "at least one hit for Texo");
    hits[0].click();
    await tick(60);
    assert.equal(dialog.querySelector('[data-settings-page="ocr"]').classList.contains("is-active"), true, "jumped to the OCR page");
    assert.ok(dialog.querySelector(".is-search-hit"), "matched setting highlighted");
    closeDialog(dialog);
});

test("simple settings are saved immediately, without the apply banner", async () => {
    const host = makeHost();
    const dialog = openDialog(host);
    const minChars = dialog.querySelector('[data-field="translationMinChars"]');
    minChars.value = "5";
    minChars.dispatchEvent(new win.Event("input", {bubbles: true}));
    await settle();
    assert.ok(host.patches.length >= 1, "settings were written");
    assert.equal(host.patches[host.patches.length - 1].translationMinChars, 5);
    assert.equal(dialog.querySelector('[data-role="apply-banner"]').hidden, true, "no pending-apply banner");
    closeDialog(dialog);
});

test("engine directory changes are staged until the apply button is used", async () => {
    const host = makeHost();
    const dialog = openDialog(host);
    const texoDir = dialog.querySelector('[data-ocr-engine="texo"] [data-engine-field="dir"]');
    texoDir.value = "D:/OCR/Texo";
    texoDir.dispatchEvent(new win.Event("change", {bubbles: true}));
    await settle();
    const banner = dialog.querySelector('[data-role="apply-banner"]');
    assert.equal(banner.hidden, false, "banner shows a pending apply");
    const staged = host.patches.some(patch => patch.ocrEngines?.texo?.dir === "D:/OCR/Texo");
    assert.equal(staged, false, "engine change is not persisted before apply");

    dialog.querySelector('[data-act="apply"]').click();
    await tick(80);
    const applied = host.patches.some(patch => patch.ocrEngines?.texo?.dir === "D:/OCR/Texo");
    assert.equal(applied, true, "apply writes the staged engine config");
    assert.equal(banner.hidden, true, "banner hidden after apply");
    closeDialog(dialog);
});

test("Doc2X output controls reveal translation type only for dual output", () => {
    const host = makeHost();
    const dialog = openDialog(host);
    const output = dialog.querySelector('[data-field="doc2xOutputMode"]');
    const dualRow = dialog.querySelector('[data-role="doc2x-dual-row"]');
    const type = dialog.querySelector('[data-field="doc2xTranslateType"]');
    const fontRow = dialog.querySelector('[data-role="doc2x-font-row"]');
    assert.ok(output && dualRow && type, "Doc2X output controls exist");
    assert.ok(dialog.querySelector('[data-field="doc2xModel"]'), "translation model select exists");
    assert.ok(dialog.querySelector('[data-field="doc2xVisionModel"]'), "vision model select exists");
    assert.ok(dialog.querySelector('[data-field="doc2xParseImageModel"]'), "image OCR model select exists");
    assert.equal(dualRow.hidden, false, "translation type visible for dual output by default");

    output.value = "translatedPdf";
    output.dispatchEvent(new win.Event("change", {bubbles: true}));
    assert.equal(dualRow.hidden, true, "translation type hidden for pure translation");

    output.value = "dualPdf";
    output.dispatchEvent(new win.Event("change", {bubbles: true}));
    assert.equal(dualRow.hidden, false, "translation type visible again");

    type.value = "md";
    type.dispatchEvent(new win.Event("change", {bubbles: true}));
    assert.equal(fontRow.hidden, true, "PDF font strategy hidden for document-type output");

    const pdf2zhOutput = dialog.querySelector('[data-field="pdf2zhOutputMode"]');
    const direction = dialog.querySelector('[data-role="pdf2zh-dual-row"]');
    pdf2zhOutput.value = "mono";
    pdf2zhOutput.dispatchEvent(new win.Event("change", {bubbles: true}));
    assert.equal(direction.hidden, true, "PDF2zh direction hidden for pure translation");
    pdf2zhOutput.value = "dual";
    pdf2zhOutput.dispatchEvent(new win.Event("change", {bubbles: true}));
    assert.equal(direction.hidden, false, "PDF2zh direction visible for dual output");
    closeDialog(dialog);
});

test("translation service subtab lists services with edit and test actions", () => {
    const host = makeHost();
    const dialog = openDialog(host);
    const servicePage = dialog.querySelector('[data-settings-subpage="service"]');
    assert.ok(servicePage, "service subtab exists");
    const rows = Array.from(servicePage.querySelectorAll("[data-service-index]"));
    assert.ok(rows.length >= 1, "default services are listed");
    assert.ok(servicePage.querySelector('[data-act="service-edit"]'), "edit action exists");
    assert.ok(servicePage.querySelector('[data-act="service-test"]'), "test connection action exists");
    assert.ok(servicePage.querySelector('input[name="pzActiveService"]'), "active service radio exists");
    closeDialog(dialog);
});
