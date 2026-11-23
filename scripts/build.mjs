#!/usr/bin/env node
import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
// pdfjs-dist 6.x keeps its assets in legacy/build at the package root; npm hoisting can also
// place the package under node_modules/.pnpm or the root node_modules when run from scripts/.
const pdfjsRoot = [
    path.join(root, "node_modules", "pdfjs-dist"),  // 6.x: assets directly under the package root
    path.join(root, "node_modules", "pdfjs-dist", "legacy"),
].find(candidate => fs.existsSync(path.join(candidate, "build", "pdf.worker.min.mjs")))
    || path.join(root, "node_modules", "pdfjs-dist");

function findEsbuild() {
    const candidates = [
        path.join(root, "node_modules", "@esbuild", "win32-x64", "esbuild.exe"),
        path.join(root, "node_modules", "@esbuild", "linux-x64", "bin", "esbuild"),
        path.join(root, "node_modules", "@esbuild", "darwin-arm64", "bin", "esbuild"),
        path.join(root, "node_modules", ".bin", "esbuild"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return "esbuild";
}

function run() {
    fs.rmSync(dist, {recursive: true, force: true});
    fs.mkdirSync(dist, {recursive: true});

    const esbuild = findEsbuild();
    const args = [
        path.join(root, "src", "index.ts"),
        "--bundle",
        "--minify",
        "--sourcemap",
        "--format=cjs",
        "--platform=browser",
        "--target=chrome120",
        "--external:siyuan",
        "--outfile=" + path.join(dist, "index.js"),
        "--log-level=info",
        // The renderer runs from the SiYuan install directory, so E2E code needs the
        // repository root to locate test-fixtures without hardcoding it in source.
        `--define:__PZ_REPO_ROOT__=${JSON.stringify(root.replaceAll("\\", "\\\\"))}`,
    ];
    console.log(`[build] ${esbuild} ${args.join(" ")}`);
    const result = spawnSync(esbuild, args, {stdio: "inherit", cwd: root});
    if (result.error) {
        console.error("[build] esbuild spawn failed:", result.error.message);
        console.error("[build] Run this exact command manually:");
        console.error(`"${esbuild}" ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }

    const files = [
        ["plugin.json", "plugin.json"],
        ["icon.png", "icon.png"],
        ["preview.png", "preview.png"],
        ["README.md", "README.md"],
    ];
    for (const [from, to] of files) {
        const src = path.join(root, from);
        if (!fs.existsSync(src)) {
            console.warn(`[build] missing optional file: ${from}`);
            continue;
        }
        fs.copyFileSync(src, path.join(dist, to));
    }
    fs.cpSync(path.join(root, "i18n"), path.join(dist, "i18n"), {recursive: true});
    fs.cpSync(path.join(root, "styles"), path.join(dist, "styles"), {recursive: true});
    // README.md references docs/screenshots/* by relative path; bazaar + in-plugin previews need them.
    // Only screenshots ship: docs/marketing and the design notes are repo-only and would inflate package.zip.
    const shotsDir = path.join(root, "docs", "screenshots");
    if (fs.existsSync(shotsDir)) {
        fs.cpSync(shotsDir, path.join(dist, "docs", "screenshots"), {recursive: true});
    } else {
        console.warn("[build] missing optional dir: docs/screenshots");
    }

    const pdfjsFiles = [
        ["build/pdf.min.mjs", "pdf.min.mjs"],
        ["build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
    ];
    for (const [from, to] of pdfjsFiles) {
        fs.copyFileSync(path.join(pdfjsRoot, from), path.join(dist, to));
    }
    for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs", "images"]) {
        if (!fs.existsSync(path.join(pdfjsRoot, dir))) continue;
        fs.cpSync(path.join(pdfjsRoot, dir), path.join(dist, dir), {recursive: true});
    }
    const katexRoot = path.join(root, "node_modules", "katex", "dist");
    fs.copyFileSync(path.join(katexRoot, "katex.min.css"), path.join(dist, "katex.min.css"));
    fs.cpSync(path.join(katexRoot, "fonts"), path.join(dist, "fonts"), {recursive: true});
    // MathLive is loaded on demand by the OCR result dialog (renderer switch + MathML copy).
    const mathliveRoot = path.join(root, "node_modules", "mathlive");
    const mathliveDist = path.join(dist, "mathlive");
    fs.mkdirSync(mathliveDist, {recursive: true});
    for (const file of ["mathlive.min.js", "mathlive-fonts.css", "mathlive-static.css"]) {
        const from = path.join(mathliveRoot, file);
        if (fs.existsSync(from)) {
            fs.copyFileSync(from, path.join(mathliveDist, file));
        } else {
            console.warn(`[build] missing mathlive asset: ${file}`);
        }
    }
    const mathliveFonts = path.join(mathliveRoot, "fonts");
    if (fs.existsSync(mathliveFonts)) {
        fs.cpSync(mathliveFonts, path.join(mathliveDist, "fonts"), {recursive: true});
    }
    console.log("[build] dist ready:", dist);
    const size = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(2) + " MiB";
    console.log(`[build] dist/index.js ${size(path.join(dist, "index.js"))}`);
    console.log(`[build] dist/pdf.worker.min.mjs ${size(path.join(dist, "pdf.worker.min.mjs"))}`);
}

run();
