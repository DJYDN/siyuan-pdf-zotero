
const STORE_DIR = "data/storage/petal/siyuan-pdf-zotero";
const MANIFEST = `${STORE_DIR}/asset-journal.json`;

function kernelToken(): string {
    return String((window as any).siyuan?.config?.api?.token || "");
}

async function kernelCall(apiPath: string, payload: Record<string, any>): Promise<any> {
    const response = await fetch(`/api${apiPath}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(kernelToken() ? {Authorization: `Token ${kernelToken()}`} : {}),
        },
        body: JSON.stringify(payload),
    });
    return response.json();
}

/**
 * Read the asset journal (paths of screenshots/rectangle captures this plugin
 * uploaded) through the kernel, because petal data outside JSON state lives in
 * the workspace rather than in Plugin.loadData().
 */
export async function readAssetJournal(): Promise<string[]> {
    const response = await fetch("/api/file/getFile", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(kernelToken() ? {Authorization: `Token ${kernelToken()}`} : {}),
        },
        body: JSON.stringify({path: MANIFEST}),
    });
    if (response.status !== 200) {
        return [];
    }
    const text = await response.text();
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed?.paths) ? parsed.paths.filter((item: any) => typeof item === "string") : [];
    } catch {
        return [];
    }
}

/**
 * Remove journaled assets that no document references any more.
 *
 * The kernel's removeUnusedAssets only reports candidates, and removeAsset needs a
 * live workspace file path, so this runs on the kernel side (Electron main process)
 * where the workspace directory is accessible.
 */
export async function sweepUnreferencedAssets(): Promise<{removed: string[]; skipped: string[]}> {
    const paths = await readAssetJournal();
    if (!paths.length) {
        return {removed: [], skipped: []};
    }
    const referenced = new Set<string>();
    const sql = await kernelCall("/query/sql", {
        stmt: "select markdown from blocks where markdown like '%assets/pz-%' limit 2000",
    });
    for (const row of sql?.data || []) {
        for (const match of String(row.markdown || "").matchAll(/assets\/(pz-[A-Za-z0-9._-]+\.png)/g)) {
            referenced.add(`assets/${match[1]}`);
        }
    }
    const removed: string[] = [];
    const skipped: string[] = [];
    for (const assetPath of paths) {
        if (referenced.has(assetPath) || !/^\s*assets\//.test(assetPath)) {
            skipped.push(assetPath);
            continue;
        }
        const result = await kernelCall("/asset/removeAsset", {path: assetPath});
        if (result?.code === 0) {
            removed.push(assetPath);
        } else {
            skipped.push(assetPath);
        }
    }
    return {removed, skipped};
}

/** Overwrite the journal with the assets still worth tracking. */
export async function writeAssetJournal(paths: string[]): Promise<void> {
    const body = Buffer.from(JSON.stringify({paths}));
    const form = new FormData();
    form.append("path", `/${MANIFEST}`);
    form.append("isDir", "false");
    form.append("modTime", String(Date.now()));
    form.append("file", new Blob([body]), "asset-journal.json");
    await fetch("/api/file/putFile", {
        method: "POST",
        headers: kernelToken() ? {Authorization: `Token ${kernelToken()}`} : {},
        body: form,
    });
}

/**
 * Record a plugin-created asset so cleanup can find it even after the note that
 * referenced it is deleted.
 */
export async function recordAsset(assetPath: string): Promise<void> {
    if (!assetPath) {
        return;
    }
    const existing = await readAssetJournal();
    if (existing.includes(assetPath)) {
        return;
    }
    existing.push(assetPath);
    if (existing.length > 500) {
        existing.splice(0, existing.length - 500);
    }
    await writeAssetJournal(existing);
}

/** Best-effort journal record that never breaks the caller. */
export function recordAssetSafe(assetPath: string): void {
    void recordAsset(assetPath).catch((error: any) => {
        console.warn("[pdf-zotero] asset journal write failed", error?.message || error);
    });
}
