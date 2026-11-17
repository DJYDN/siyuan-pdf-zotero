#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, ".test-build");
fs.rmSync(outDir, {recursive: true, force: true});
fs.mkdirSync(outDir, {recursive: true});

const esbuild = [
    path.join(root, "node_modules", "@esbuild", "win32-x64", "esbuild.exe"),
    path.join(root, "node_modules", ".bin", "esbuild"),
].find(candidate => fs.existsSync(candidate));
if (!esbuild) {
    console.error("esbuild binary not found");
    process.exit(1);
}

const entries = ["anchor", "runtime", "asset-path", "storage", "link-format", "pdf/source", "pdf/links", "citation/mapper", "ocr/client", "ocr/engines", "ocr/convert", "ui/ocr-dialog", "ui/dock", "ui/rect-select", "ui/pdf2zh-hud", "ui/styles", "ocr/latex-format", "ui/formula-format", "ocr/bundles", "translation/doc2x", "matrix/model", "matrix/filter", "matrix/relationships", "matrix/canvas"];
const siyuanStub = path.join(root, "tests", "stubs", "siyuan.mjs");
for (const entry of entries) {
    const out = path.join(outDir, entry.replace("/", "-") + ".mjs");
    const args = [
        path.join(root, "src", entry + ".ts"),
        "--bundle",
        "--format=esm",
        "--platform=node",
        "--target=node22",
        "--outfile=" + out,
        "--log-level=warning",
        `--alias:siyuan=${siyuanStub}`,
        `--define:__PZ_REPO_ROOT__=${JSON.stringify(root.replaceAll("\\", "\\\\"))}`,
    ];
    const result = spawnSync(esbuild, args, {stdio: "inherit", cwd: root});
    if (result.error || result.status !== 0) {
        console.error("failed to build test module", entry, result.error?.message || result.status);
        process.exit(1);
    }
}
console.log("[test-build] ok");
