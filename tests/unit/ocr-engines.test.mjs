import test from "node:test";
import assert from "node:assert/strict";
import {
    defaultFormulaOrder,
    enabledEngineIds,
    engineConfig,
    enginesForMode,
    formulaEngineOrder,
    isOcrEngineId,
    legacyEngineMap,
    normalizeDirKey,
    normalizeEngineMap,
    OCR_ENGINE_DEFS,
    OCR_ENGINE_IDS,
    serviceGroupForEngine,
    serviceGroups,
} from "../../.test-build/ocr-engines.mjs";

function settings(overrides = {}) {
    return {
        ocrEngines: {
            pix2text: {enabled: true, dir: "D:/OCR/Pix2Text", port: 8891, autoStart: true},
            unimernet: {enabled: false, dir: "", port: 8892, autoStart: true},
            texo: {enabled: false, dir: "", port: 8893, autoStart: true},
        },
        ocrFormulaOrder: ["texo", "unimernet", "pix2text"],
        ocrTextEngine: "pix2text",
        ocrServerPath: "",
        ocrPort: 8891,
        ocrAutoStart: true,
        ocrEngine: "pix2text",
        unimernetPath: "",
        ...overrides,
    };
}

test("engine registry covers the three local sidecars with expected capabilities", () => {
    assert.deepEqual(OCR_ENGINE_IDS, ["pix2text", "unimernet", "texo"]);
    assert.equal(OCR_ENGINE_DEFS.pix2text.capabilities.text, true);
    assert.equal(OCR_ENGINE_DEFS.unimernet.capabilities.text, false);
    assert.equal(OCR_ENGINE_DEFS.texo.capabilities.formula, true);
    assert.equal(OCR_ENGINE_DEFS.texo.defaultPort, 8893);
    assert.equal(OCR_ENGINE_DEFS.unimernet.defaultPort, 8892);
    assert.equal(isOcrEngineId("texo"), true);
    assert.equal(isOcrEngineId("tesseract"), false);
    assert.deepEqual(defaultFormulaOrder(), ["texo", "unimernet", "pix2text"]);
});

test("legacy single-service settings migrate to engine configs sharing one directory", () => {
    const migrated = legacyEngineMap({
        ocrServerPath: "D:/SiYuan/OCR-Service-Portable",
        ocrPort: 8891,
        ocrAutoStart: false,
        ocrEngine: "unimernet",
        unimernetPath: "D:/SiYuan/UniMERNet",
    });
    assert.equal(migrated.pix2text.enabled, true);
    assert.equal(migrated.pix2text.dir, "D:/SiYuan/OCR-Service-Portable");
    assert.equal(migrated.pix2text.autoStart, false);
    assert.equal(migrated.unimernet.enabled, true);
    assert.equal(migrated.unimernet.dir, migrated.pix2text.dir);
    assert.equal(migrated.texo.enabled, false);
    assert.equal(migrated.texo.port, 8893);
});

test("normalizeEngineMap clamps ports and keeps legacy directories when unset", () => {
    const normalized = normalizeEngineMap({
        pix2text: {enabled: true, dir: "  D:/OCR/Pix2Text  ", port: 99999},
        texo: {enabled: true, dir: "D:/OCR/Texo", port: "abc"},
    }, {ocrServerPath: "D:/legacy", ocrPort: 8891, ocrAutoStart: true});
    assert.equal(normalized.pix2text.dir, "D:/OCR/Pix2Text");
    assert.equal(normalized.pix2text.port, 8891);
    assert.equal(normalized.texo.port, 8893);
    assert.equal(normalized.texo.enabled, true);
    // UniMERNet shares the legacy service directory/port when its own section is absent.
    assert.deepEqual(normalized.unimernet, {enabled: false, dir: "D:/legacy", port: 8891, autoStart: true});
});

test("normalizeEngineMap falls back to the legacy layout for missing sections", () => {
    const normalized = normalizeEngineMap(null, {ocrServerPath: "D:/legacy", ocrPort: 8891, ocrAutoStart: true});
    assert.equal(normalized.pix2text.dir, "D:/legacy");
    assert.equal(normalized.unimernet.port, 8891);
});

test("engineConfig reads the normalized map and survives missing settings", () => {
    const config = engineConfig(settings(), "pix2text");
    assert.equal(config.dir, "D:/OCR/Pix2Text");
    assert.equal(engineConfig({}, "texo").port, 8893);
});

test("enabledEngineIds only returns enabled engines in registry order", () => {
    const enabled = enabledEngineIds(settings({
        ocrEngines: {
            pix2text: {enabled: false, dir: "", port: 8891, autoStart: true},
            unimernet: {enabled: true, dir: "D:/U", port: 8892, autoStart: true},
            texo: {enabled: true, dir: "D:/T", port: 8893, autoStart: true},
        },
    }));
    assert.deepEqual(enabled, ["unimernet", "texo"]);
});

test("formulaEngineOrder follows configured priority and skips disabled engines", () => {
    const order = formulaEngineOrder(settings({
        ocrFormulaOrder: ["texo", "pix2text", "unimernet"],
        ocrEngines: {
            pix2text: {enabled: true, dir: "D:/P", port: 8891, autoStart: true},
            unimernet: {enabled: false, dir: "", port: 8892, autoStart: true},
            texo: {enabled: true, dir: "D:/T", port: 8893, autoStart: true},
        },
    }));
    assert.deepEqual(order, ["texo", "pix2text"]);
});

test("formulaEngineOrder deduplicates and appends unlisted engines", () => {
    const order = formulaEngineOrder(settings({
        ocrFormulaOrder: ["pix2text", "pix2text", "texo"],
        ocrEngines: {
            pix2text: {enabled: true, dir: "D:/P", port: 8891, autoStart: true},
            unimernet: {enabled: true, dir: "D:/U", port: 8892, autoStart: true},
            texo: {enabled: true, dir: "D:/T", port: 8893, autoStart: true},
        },
    }));
    assert.deepEqual(order, ["pix2text", "texo", "unimernet"]);
});

test("enginesForMode uses formula priority for formula and the text engine for text", () => {
    const base = settings({
        ocrFormulaOrder: ["texo", "unimernet", "pix2text"],
        ocrEngines: {
            pix2text: {enabled: true, dir: "D:/P", port: 8891, autoStart: true},
            unimernet: {enabled: true, dir: "D:/U", port: 8892, autoStart: true},
            texo: {enabled: true, dir: "D:/T", port: 8893, autoStart: true},
        },
    });
    assert.deepEqual(enginesForMode(base, "formula"), ["texo", "unimernet", "pix2text"]);
    assert.deepEqual(enginesForMode(base, "text"), ["pix2text"]);
    assert.deepEqual(enginesForMode(base, "auto"), ["pix2text"]);
});

test("enginesForMode falls back to formula engines when no text engine is enabled", () => {
    const base = settings({
        ocrEngines: {
            pix2text: {enabled: false, dir: "", port: 8891, autoStart: true},
            unimernet: {enabled: false, dir: "", port: 8892, autoStart: true},
            texo: {enabled: true, dir: "D:/T", port: 8893, autoStart: true},
        },
    });
    assert.deepEqual(enginesForMode(base, "auto"), ["texo"]);
});

test("serviceGroups merges engines that point at the same directory", () => {
    const shared = settings({
        ocrEngines: {
            pix2text: {enabled: true, dir: "D:/SiYuan/OCR-Service-Portable", port: 8891, autoStart: true},
            unimernet: {enabled: true, dir: "D:\\SiYuan\\OCR-Service-Portable\\", port: 8891, autoStart: false},
            texo: {enabled: true, dir: "D:/OCR/Texo", port: 8893, autoStart: true},
        },
    });
    const groups = serviceGroups(shared);
    assert.equal(groups.length, 2);
    const legacy = groups.find(group => group.engines.includes("pix2text"));
    assert.deepEqual(legacy.engines, ["pix2text", "unimernet"]);
    assert.equal(legacy.port, 8891);
    assert.equal(legacy.autoStart, true);
    const texo = groups.find(group => group.engines.includes("texo"));
    assert.equal(texo.port, 8893);
});

test("serviceGroups ignores disabled engines and engines without a directory", () => {
    const groups = serviceGroups(settings({
        ocrEngines: {
            pix2text: {enabled: true, dir: "", port: 8891, autoStart: true},
            unimernet: {enabled: true, dir: "D:/U", port: 8892, autoStart: true},
            texo: {enabled: false, dir: "D:/T", port: 8893, autoStart: true},
        },
    }));
    assert.deepEqual(groups.map(group => group.engines), [["unimernet"]]);
});

test("serviceGroupForEngine resolves the shared group and normalizes paths", () => {
    const shared = settings({
        ocrEngines: {
            pix2text: {enabled: true, dir: "D:/SiYuan/OCR-Service-Portable", port: 8891, autoStart: true},
            unimernet: {enabled: true, dir: "D:\\SiYuan\\OCR-Service-Portable", port: 8891, autoStart: true},
            texo: {enabled: false, dir: "", port: 8893, autoStart: true},
        },
    });
    const group = serviceGroupForEngine(shared, "unimernet");
    assert.deepEqual(group.engines, ["pix2text", "unimernet"]);
    assert.equal(group.key, normalizeDirKey("D:/SiYuan/OCR-Service-Portable"));
    assert.equal(normalizeDirKey("D:\\A\\B\\"), "d:\\a\\b");
});
