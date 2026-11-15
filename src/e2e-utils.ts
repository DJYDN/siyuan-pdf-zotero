import {requireNode} from "./runtime";

export function e2eSleep(ms: number): Promise<void> {
    const nodeSetTimeout = requireNode("timers")?.setTimeout;
    return new Promise(resolve => {
        if (typeof nodeSetTimeout === "function") {
            nodeSetTimeout(resolve, ms);
        } else {
            globalThis.setTimeout(resolve, ms);
        }
    });
}

declare const __PZ_REPO_ROOT__: string;

let cachedRepoRoot = "";

/**
 * Repository root for E2E fixtures.
 *
 * The renderer's cwd is the SiYuan install directory (e.g. E:\Tools\SiYuan), so
 * relative fixture paths resolve against this repo instead. Sources of truth, in
 * order: localStorage override, a source hint the build injects for automation
 * builds, and finally the workspace path used by this project's own automation.
 */
export function e2eRepoRoot(): string {
    if (cachedRepoRoot) {
        return cachedRepoRoot;
    }
    const override = globalThis.localStorage?.getItem?.("pdf-zotero-e2e-repo") || "";
    if (override) {
        cachedRepoRoot = override;
        return cachedRepoRoot;
    }
    if (typeof __PZ_REPO_ROOT__ === "string" && __PZ_REPO_ROOT__) {
        cachedRepoRoot = __PZ_REPO_ROOT__;
        return cachedRepoRoot;
    }
    cachedRepoRoot = "F:\\study\\VStudio\\SiYuanArticleManger";
    return cachedRepoRoot;
}

/** Absolute path of a file under the repository's test-fixtures directory. */
export function e2eFixturePath(name: string): string {
    const pathModule = requireNode("path");
    return pathModule?.join(e2eRepoRoot(), "test-fixtures", name) || `${e2eRepoRoot()}/test-fixtures/${name}`;
}
