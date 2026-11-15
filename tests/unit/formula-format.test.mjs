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
if (typeof globalThis.requestAnimationFrame !== "function") {
    Object.defineProperty(globalThis, "requestAnimationFrame", {value: cb => win.setTimeout(() => cb(Date.now()), 16), configurable: true});
}

const {bindFormulaFormatMenu} = await import("../../.test-build/ui-formula-format.mjs");
const {__messages} = await import("../../.test-build/ui-formula-format.mjs");

const tick = (ms = 30) => new Promise(resolve => win.setTimeout(resolve, ms));

const RAW = "\\left\\{\\begin{aligned} & & f(x)=\\frac{a}{b} \\\\ & & g(x)=\\frac{c}{d} \\end{aligned}\\right.";
const KRAMDOWN = `$$\n${RAW}\n$$\n{: id="20240101000000-blk1" updated="20240101000000"}`;

let updates = [];
const originalFetch = globalThis.fetch;

// Only replace fetch while these tests run: other DOM test files install their own stub.
function useFetch() {
    updates = [];
    globalThis.fetch = async (url, init) => {
        const path = String(url);
        if (path.includes("/api/block/getBlockKramdown")) {
            return {ok: true, status: 200, json: async () => ({code: 0, data: {kramdown: KRAMDOWN}})};
        }
        if (path.includes("/api/block/updateBlock")) {
            const payload = JSON.parse(String(init?.body || "{}"));
            updates.push(payload);
            return {ok: true, status: 200, json: async () => ({code: 0, data: []})};
        }
        return {ok: true, status: 200, json: async () => ({code: 0, data: {}})};
    };
}

function restoreFetch() {
    globalThis.fetch = originalFetch;
}

test("formula block context menu formats the LaTeX source in place", async () => {
    useFetch();
    document.body.innerHTML = `<div class="protyle-wysiwyg"><div data-type="NodeMathBlock" data-node-id="blk1"><span class="katex">x</span></div></div>`;
    const block = document.querySelector('[data-type="NodeMathBlock"]');
    const unbind = bindFormulaFormatMenu();
    updates = [];

    block.dispatchEvent(new win.MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: 120, clientY: 80}));
    const menu = document.querySelector(".pz-formula-format-menu");
    assert.ok(menu, "custom menu rendered");
    assert.ok(menu.querySelector('[data-act="format-formula"]'), "format item present");
    assert.ok(menu.querySelector('[data-act="copy-formula"]'), "copy item present");

    menu.querySelector('[data-act="format-formula"]').click();
    await tick(60);
    assert.equal(updates.length, 1, "block was updated once");
    assert.equal(updates[0].id, "blk1");
    assert.equal(updates[0].dataType, "markdown");
    assert.ok(updates[0].data.startsWith("$$\n"), "still a math block");
    assert.ok(updates[0].data.includes("\\begin{aligned}\n"), "formatted source is multiline");
    assert.equal(document.querySelector(".pz-formula-format-menu"), null, "menu closed after use");

    unbind();
    block.dispatchEvent(new win.MouseEvent("contextmenu", {bubbles: true, cancelable: true}));
    assert.equal(document.querySelector(".pz-formula-format-menu"), null, "unbind removes the listener");
    restoreFetch();
});

test("context menu is not hijacked outside formula blocks or from the gutter", () => {
    useFetch();
    document.body.innerHTML = `<div class="protyle-wysiwyg"><div data-type="NodeParagraph" data-node-id="p1">text</div><div data-type="NodeMathBlock" data-node-id="blk2"><span class="protyle-gutters">gutter</span></div></div>`;
    const unbind = bindFormulaFormatMenu();
    const paragraph = document.querySelector('[data-type="NodeParagraph"]');
    const paragraphEvent = new win.MouseEvent("contextmenu", {bubbles: true, cancelable: true});
    paragraph.dispatchEvent(paragraphEvent);
    assert.equal(paragraphEvent.defaultPrevented, false, "normal blocks keep the native menu");
    assert.equal(document.querySelector(".pz-formula-format-menu"), null);

    const gutter = document.querySelector('[data-type="NodeMathBlock"] .protyle-gutters');
    const gutterEvent = new win.MouseEvent("contextmenu", {bubbles: true, cancelable: true});
    gutter.dispatchEvent(gutterEvent);
    assert.equal(gutterEvent.defaultPrevented, false, "gutter menus keep working");
    unbind();
    restoreFetch();
});
