#!/usr/bin/env node

import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.SIYUAN_BASE || "http://127.0.0.1:6806").replace(/\/+$/, "");
const TOKEN = process.env.SIYUAN_TOKEN || "";
const PLUGIN = "siyuan-pdf-zotero";
const STORE_DIR = `data/storage/petal/${PLUGIN}`;
const PHASES = ["p0", "p1", "p2", "p3"];

function headers(extra = {}) {
    return TOKEN ? {Authorization: `Token ${TOKEN}`, ...extra} : extra;
}

function parseArgs(argv) {
    const options = {phases: [...PHASES], timeoutMs: 120_000, saveEvidence: true};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--phase") {
            options.phases = String(argv[++i] || "").split(",").filter(Boolean);
        } else if (arg.startsWith("--phase=")) {
            options.phases = arg.slice("--phase=".length).split(",").filter(Boolean);
        } else if (arg === "--timeout-ms") {
            options.timeoutMs = Number(argv[++i]);
        } else if (arg.startsWith("--timeout-ms=")) {
            options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
        } else if (arg === "--no-save-evidence") {
            options.saveEvidence = false;
        } else if (arg === "--help") {
            console.log("Usage: npm run test:e2e -- [p0,p1,p2,p3] [timeout-ms]");
            console.log("       node tests/e2e/run-e2e.mjs [--phase=p1,p2] [--timeout-ms=120000]");
            process.exit(0);
        } else if (!arg.startsWith("--")) {
            positional.push(arg);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (positional.length) {
        const timeout = positional.find(value => /^\d+$/.test(value));
        const phases = positional
            .filter(value => value !== timeout)
            .flatMap(value => value.split(/[\s,]+/))
            .filter(Boolean);
        if (phases.length) {
            options.phases = phases;
        }
        if (timeout) {
            options.timeoutMs = Number(timeout);
        }
    }
    const invalid = options.phases.filter(phase => !PHASES.includes(phase));
    if (invalid.length || options.phases.length === 0) {
        throw new Error(`Invalid phase list: ${options.phases.join(",")}`);
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10_000) {
        throw new Error("--timeout-ms must be at least 10000");
    }
    return options;
}

async function api(apiPath, body = {}) {
    const response = await fetch(`${BASE}${apiPath}`, {
        method: "POST",
        headers: headers({"Content-Type": "application/json"}),
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`${apiPath} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!response.ok || json.code !== 0) {
        throw new Error(`${apiPath} failed: HTTP ${response.status}, code=${json.code}, msg=${json.msg}`);
    }
    return json;
}

async function putData(name, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    const form = new FormData();
    form.append("path", `/${STORE_DIR}/${name}`);
    form.append("isDir", "false");
    form.append("modTime", String(Date.now()));
    form.append("file", new Blob([bytes]), name);
    const response = await fetch(`${BASE}/api/file/putFile`, {
        method: "POST",
        headers: headers(),
        body: form,
    });
    const text = await response.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`putFile ${name} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!response.ok || json.code !== 0) {
        throw new Error(`putFile ${name} failed: ${text.slice(0, 300)}`);
    }
}

async function readData(name) {
    const response = await fetch(`${BASE}/api/file/getFile`, {
        method: "POST",
        headers: headers({"Content-Type": "application/json"}),
        body: JSON.stringify({path: `${STORE_DIR}/${name}`}),
    });
    if (!response.ok) {
        return null;
    }
    const text = await response.text();
    try {
        const value = JSON.parse(text);
        return value?.code === 404 ? null : value;
    } catch {
        return null;
    }
}

async function reloadPlugin() {
    try {
        await api("/api/petal/setPetalEnabled", {packageName: PLUGIN, enabled: false, app: "desktop"});
        await new Promise(resolve => setTimeout(resolve, 500));
    } finally {
        await api("/api/petal/setPetalEnabled", {packageName: PLUGIN, enabled: true, app: "desktop"});
    }
}

async function waitForReport(phase, startedAt, timeoutMs) {
    const reportName = `${phase}-e2e-report`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const report = await readData(reportName);
        const reportTime = Date.parse(report?.at || "");
        if (Number.isFinite(reportTime) && reportTime >= startedAt - 1_000) {
            return report;
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw new Error(`${phase} timed out after ${timeoutMs}ms waiting for ${reportName}`);
}

async function runPhase(phase, options) {
    const flagName = phase === "p0" ? "e2e-flag" : `${phase}-e2e-flag`;
    const startedAt = Date.now();
    console.log(`[e2e] ${phase}: trigger ${flagName}`);
    await putData(flagName, {run: true, requestedAt: new Date(startedAt).toISOString()});
    await reloadPlugin();
    const report = await waitForReport(phase, startedAt, options.timeoutMs);
    console.log(`[e2e] ${phase}: ${report.ok ? "PASS" : "FAIL"}`);
    if (options.saveEvidence) {
        const evidenceDir = path.join(ROOT, "reports", "evidence");
        await mkdir(evidenceDir, {recursive: true});
        await writeFile(path.join(evidenceDir, `${phase}-e2e-report.json`), `${JSON.stringify(report, null, 2)}\n`);
    }
    if (!report.ok) {
        throw new Error(`${phase} failed: ${report.error || "see report steps"}`);
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const version = await api("/api/system/version");
    console.log(`[e2e] SiYuan ${version.data}; phases=${options.phases.join(",")}`);
    const failures = [];
    for (const phase of options.phases) {
        try {
            await runPhase(phase, options);
        } catch (error) {
            failures.push({phase, error});
            console.error(`[e2e] ${phase}: ${error.message || error}`);
        }
    }
    if (failures.length) {
        throw new Error(`${failures.length}/${options.phases.length} phase(s) failed: ${failures.map(item => item.phase).join(",")}`);
    }
    console.log(`[e2e] PASS ${options.phases.length}/${options.phases.length}`);
}

main().catch(error => {
    console.error(`[e2e] FAIL: ${error.stack || error.message || error}`);
    process.exitCode = 1;
});
