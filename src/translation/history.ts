import {requireNode} from "../runtime";
import type {PluginHost} from "../host";
import {translationOutputDir} from "./pdf2zh";

let syncing = false;

/**
 * Backfill the Dock's translation list from the default/custom output folder.
 * Only plugin-produced names are considered so choosing a general Downloads
 * folder does not turn every unrelated PDF into a translation entry.
 */
export async function syncTranslationHistory(host: PluginHost): Promise<void> {
    if (syncing) return;
    syncing = true;
    try {
        const fs = requireNode("fs");
        const path = requireNode("path");
        const root = translationOutputDir(host.store.state.settings);
        host.logDebug("translation.history.sync.start", {root}, "info");
        if (!fs?.existsSync?.(root)) return;
        const known = new Set(host.store.translationOutputs().map(item => item.path.replaceAll("\\", "/").toLowerCase()));
        let added = 0;
        const stack = [root];
        while (stack.length) {
            const dir = stack.pop()!;
            let names: string[] = [];
            try {
                names = fs.readdirSync(dir);
            } catch {
                continue;
            }
            for (const name of names) {
                const full = path.join(dir, name);
                let stat: any;
                try {
                    stat = fs.statSync(full);
                } catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    stack.push(full);
                    continue;
                }
                if (!/\.pdf$/i.test(name)) continue;
                const normalized = full.replaceAll("\\", "/").toLowerCase();
                if (known.has(normalized)) continue;
                const rel = full.slice(root.length).replaceAll("\\", "/");
                let provider: "doc2x" | "pdf2zh" | "unknown" = "unknown";
                if (/\/doc2x-/i.test(rel) || /^doc2x-/i.test(name)) provider = "doc2x";
                else if (/pdf2zh-/i.test(name) || /\/pdf2zh-/i.test(rel)) provider = "pdf2zh";
                if (provider === "unknown") continue;
                host.store.addTranslationOutput({
                    path: full,
                    fileName: name,
                    provider,
                    mode: provider === "doc2x" ? "doc2x" : "pdf2zh",
                    targetLang: "",
                    createdAt: Number(stat.mtimeMs) || Date.now(),
                });
                known.add(normalized);
                added++;
            }
        }
        host.logDebug("translation.history.sync.done", {added}, "info");
        if (added) {
            await host.store.save();
            host.refreshDock();
        }
    } catch (error: any) {
        host.logDebug("translation.history.sync.failed", {message: error?.message || String(error)}, "warn");
    } finally {
        syncing = false;
    }
}
