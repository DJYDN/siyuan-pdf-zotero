import fs from "node:fs";
import path from "node:path";

export const testRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
export const fixtureDir = path.join(testRoot, "test-fixtures");
export const pdfjsRoot = path.join(testRoot, "node_modules", "pdfjs-dist");

/**
 * Node-side binary data factory for PDF.js.
 *
 * The legacy build ships a NodeBinaryDataFactory that goes through `fetch`, and
 * this sandboxed Node runtime cannot fetch `file://` URLs, so every standard font
 * load printed "Unable to load font data at ..." while the page still rendered.
 * Reading the same assets synchronously from disk keeps the behaviour identical
 * without the warning noise.
 */
export class LocalBinaryDataFactory {
    constructor() {
        this.cMapUrl = "file:///cmaps/";
        this.standardFontDataUrl = "file:///standard_fonts/";
        this.wasmUrl = "file:///wasm/";
    }

    async fetch({kind, filename}) {
        const dir = kind === "standardFontDataUrl"
            ? "standard_fonts"
            : kind === "cMapUrl"
                ? "cmaps"
                : "wasm";
        const bytes = fs.readFileSync(path.join(pdfjsRoot, dir, String(filename)));
        return new Uint8Array(bytes);
    }
}

/** Node.js PDF.js document options shared by the integration tests. */
export function nodeGetDocument(pdfjs, filePath, extra = {}) {
    return pdfjs.getDocument({
        data: new Uint8Array(fs.readFileSync(filePath)),
        useWorkerFetch: false,
        useSystemFonts: true,
        isEvalSupported: false,
        BinaryDataFactory: LocalBinaryDataFactory,
        ...extra,
    });
}
