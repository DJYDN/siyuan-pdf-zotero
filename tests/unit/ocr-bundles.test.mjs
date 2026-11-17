import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

globalThis.__pzNodeRequire = createRequire(import.meta.url);

const {detectOcrBundle, detectPdf2zhServer, discoverBundles, isBundleCompatible, readBundlePort, readBundleLogTail} =
    await import("../../.test-build/ocr-bundles.mjs");

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `pz-${prefix}-`));
}

function write(file, content = "") {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content, "utf8");
}

test("detectOcrBundle distinguishes legacy, texo, unimernet and pix2text bundles", () => {
    const legacy = tempDir("legacy");
    write(path.join(legacy, "pz_ocr_server.py"), "print('legacy')");
    write(path.join(legacy, "config.json"), JSON.stringify({port: 8891}));
    const legacyInfo = detectOcrBundle(legacy);
    assert.equal(legacyInfo.kind, "legacy");
    assert.equal(legacyInfo.port, 8891);
    assert.equal(legacyInfo.script, "pz_ocr_server.py");
    assert.deepEqual(legacyInfo.compatible, ["pix2text", "unimernet"]);
    assert.equal(isBundleCompatible(legacyInfo, "texo"), false, "legacy bundle cannot serve texo");
    assert.equal(isBundleCompatible(legacyInfo, "pix2text"), true);

    const texo = tempDir("texo");
    write(path.join(texo, "service.py"), "print('texo')");
    write(path.join(texo, "texo_engine.py"), "");
    write(path.join(texo, "config.json"), JSON.stringify({port: 8893}));
    const texoInfo = detectOcrBundle(texo);
    assert.equal(texoInfo.kind, "texo");
    assert.deepEqual(texoInfo.compatible, ["texo"]);

    const unimernet = tempDir("unimernet");
    write(path.join(unimernet, "service.py"), "");
    write(path.join(unimernet, "models", "unimernet_base", "config.json"), "{}");
    write(path.join(unimernet, "config.json"), JSON.stringify({port: 8892, modelDir: "./models/unimernet_base"}));
    assert.equal(detectOcrBundle(unimernet).kind, "unimernet");

    const pix2text = tempDir("pix2text");
    write(path.join(pix2text, "service.py"), "");
    write(path.join(pix2text, "userprofile", "AppData", "Roaming", ".keep"), "");
    write(path.join(pix2text, "config.json"), JSON.stringify({port: 8891, modelDir: "./userprofile/AppData/Roaming"}));
    const pix2textInfo = detectOcrBundle(pix2text);
    assert.equal(pix2textInfo.kind, "pix2text");
    assert.equal(readBundlePort(pix2text), 8891);
});

test("unknown or missing directories are reported instead of guessed", () => {
    assert.equal(detectOcrBundle("").kind, "unknown");
    const empty = tempDir("empty");
    assert.equal(detectOcrBundle(empty).kind, "unknown");
    assert.deepEqual(detectOcrBundle(empty).compatible, []);
});

test("detectPdf2zhServer requires pz_server.py", () => {
    const server = tempDir("pdf2zh");
    write(path.join(server, "pz_server.py"), "");
    assert.equal(detectPdf2zhServer(server), true);
    const other = tempDir("pdf2zh-other");
    write(path.join(other, "README.md"), "");
    assert.equal(detectPdf2zhServer(other), false);
});

test("discoverBundles scans a services root and finds OCR + PDF2zh bundles", () => {
    const root = tempDir("root");
    write(path.join(root, "OCR-Texo-Portable", "service.py"), "");
    write(path.join(root, "OCR-Texo-Portable", "texo_engine.py"), "");
    write(path.join(root, "OCR-Texo-Portable", "config.json"), JSON.stringify({port: 8893}));
    write(path.join(root, "OCR-UniMERNet-Portable", "service.py"), "");
    write(path.join(root, "OCR-UniMERNet-Portable", "models", "unimernet_base", "config.json"), "{}");
    write(path.join(root, "SiYuan-PDF2zh-Portable", "pdf2zh-server", "pz_server.py"), "");
    const found = discoverBundles([root]);
    assert.equal(found.ocr.texo, path.join(root, "OCR-Texo-Portable"));
    assert.equal(found.ocr.unimernet, path.join(root, "OCR-UniMERNet-Portable"));
    assert.ok(found.pdf2zh.some(dir => dir.endsWith("pdf2zh-server")));
});

test("readBundleLogTail returns the last log lines", () => {
    const dir = tempDir("log");
    write(path.join(dir, "portable-err.log"), ["line1", "line2", "line3", "line4"].join("\n") + "\n");
    const tail = readBundleLogTail(dir, 2);
    assert.equal(tail, "line3\nline4");
    assert.equal(readBundleLogTail(tempDir("nolog")), "");
});
