#!/usr/bin/env node
/**
 * Build and install the plugin into the running SiYuan workspace using public HTTP APIs.
 *
 * Usage:
 *   node scripts/install-plugin.mjs [--workspace C:\path\to\workspace] [--token TOKEN] [--load]
 *
 * The install path is <workspace>/data/plugins/siyuan-pdf-zotero. It writes through
 * /api/file/putFile, never by hand-editing .sy files or Zotero data.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const args = process.argv.slice(2);

function arg(name, fallback = "") {
    const index = args.indexOf("--" + name);
    return index >= 0 ? args[index + 1] : fallback;
}

const defaultWorkspace = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "SiYuan", "Dataset") : "C:\\SiYuan\\Dataset";
const workspace = path.resolve(arg("workspace", defaultWorkspace));
const confPath = path.join(workspace, "conf", "conf.json");
const baseUrl = arg("base-url", "http://127.0.0.1:6806");
let token = arg("token", "");
if (!token) {
    try {
        token = JSON.parse(fs.readFileSync(confPath, "utf8")).api?.token || "";
    } catch {
        // handled below
    }
}
if (!token) {
    console.error("No API token. Pass --token or make sure conf.json is readable.");
    process.exit(1);
}
if (!fs.existsSync(path.join(dist, "index.js"))) {
    console.error("dist/index.js missing. Run node scripts/build.mjs first.");
    process.exit(1);
}

const pluginDir = "data/plugins/siyuan-pdf-zotero";

async function upload(relativePath) {
    const absolute = path.join(dist, relativePath);
    const stat = fs.statSync(absolute);
    const data = fs.readFileSync(absolute);
    const form = new FormData();
    form.append("path", `/${pluginDir}/${relativePath.split(path.sep).join("/")}`);
    form.append("isDir", "false");
    form.append("modTime", String(Math.floor(stat.mtimeMs)));
    form.append("file", new Blob([data]), path.basename(relativePath));
    const response = await fetch(`${baseUrl}/api/file/putFile`, {
        method: "POST",
        headers: {Authorization: `Token ${token}`},
        body: form,
    });
    const text = await response.text();
    if (!response.ok || !text.includes('"code":0')) {
        throw new Error(`upload ${relativePath}: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
}

async function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const rel = path.join(prefix, entry.name);
        if (entry.isDirectory()) {
            await walk(path.join(dir, entry.name), rel);
        } else {
            await upload(rel);
        }
    }
}

async function main() {
    console.log(`[install] workspace=${workspace}`);
    console.log(`[install] target=${pluginDir}`);
    if (args.includes("--load")) {
        const unload = await fetch(`${baseUrl}/api/petal/setPetalEnabled`, {
            method: "POST",
            headers: {Authorization: `Token ${token}`, "Content-Type": "application/json"},
            body: JSON.stringify({packageName: "siyuan-pdf-zotero", enabled: false}),
        });
        console.log(`[install] disable plugin HTTP ${unload.status}`);
        // Let the frontend finish custom-tab teardown before replacing its bundle.
        await new Promise(resolve => setTimeout(resolve, 350));
    }
    await walk(dist);
    // Re-enable through the supported Petal API; this broadcasts a real frontend reload.
    const load = await fetch(`${baseUrl}/api/petal/setPetalEnabled`, {
        method: "POST",
        headers: {Authorization: `Token ${token}`, "Content-Type": "application/json"},
        body: JSON.stringify({packageName: "siyuan-pdf-zotero", enabled: true}),
    });
    console.log(`[install] enable plugin HTTP ${load.status}`);
    console.log("[install] Files uploaded. If the plugin is not visible, reload SiYuan web UI (F5) or restart SiYuan once.");
}

main().catch(error => {
    console.error("[install] failed:", error);
    process.exit(1);
});
