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

const {RectSelectTool} = await import("../../.test-build/ui-rect-select.mjs");
const {Pdf2zhHud} = await import("../../.test-build/ui-pdf2zh-hud.mjs");

const escape = () => win.document.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));

test("rect selection tool exits when Escape is pressed", () => {
    const pages = document.createElement("div");
    document.body.append(pages);
    let selected = 0;
    const tool = new RectSelectTool(pages, () => { selected += 1; });
    tool.bind();
    tool.setActive(true);
    assert.equal(tool.isActive(), true);
    assert.ok(pages.classList.contains("pz-rect-mode"));

    escape();
    assert.equal(tool.isActive(), false, "ESC deactivated the selection tool");
    assert.equal(pages.classList.contains("pz-rect-mode"), false);
    assert.equal(selected, 0, "no selection emitted on cancel");
    tool.destroy();
    pages.remove();
});

test("Escape outside active mode is ignored", () => {
    const pages = document.createElement("div");
    document.body.append(pages);
    const tool = new RectSelectTool(pages, () => {});
    tool.bind();
    escape();
    assert.equal(tool.isActive(), false);
    tool.destroy();
    pages.remove();
});

test("whole-translation progress HUD cancels on Escape", () => {
    let cancelled = 0;
    const hud = new Pdf2zhHud("PDF2zh", {onCancel: () => { cancelled += 1; }});
    hud.setIndeterminate("翻译中…");
    assert.ok(document.querySelector(".pz-pdf2zh-hud"), "HUD mounted");
    assert.equal(hud.isCancelled(), false);

    escape();
    assert.equal(cancelled, 1, "onCancel callback fired");
    assert.equal(hud.isCancelled(), true);
    assert.equal(document.querySelector(".pz-pdf2zh-hud"), null, "HUD removed");

    escape();
    assert.equal(cancelled, 1, "no duplicate cancel after destroy");
});

test("OCR progress HUD also closes on Escape without a cancel callback", () => {
    const hud = new Pdf2zhHud("OCR");
    hud.setProgress(30, "识别中");
    assert.equal(hud.isCancelled(), false);
    escape();
    assert.equal(hud.isCancelled(), true);
    assert.equal(document.querySelector(".pz-pdf2zh-hud"), null);
});

test("finishing a HUD cleanly removes it without marking it cancelled", () => {
    const hud = new Pdf2zhHud("PDF2zh");
    hud.complete("完成");
    assert.equal(hud.isCancelled(), false, "completion is not a cancellation");
    hud.destroy();
    assert.equal(document.querySelector(".pz-pdf2zh-hud"), null);
});
