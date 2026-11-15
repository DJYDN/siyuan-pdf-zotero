import {getAllTabs} from "siyuan";
import {requireNode} from "./runtime";

function token(): string {
    return String((window as any).siyuan?.config?.api?.token || "");
}

async function api(path: string, payload: Record<string, any>): Promise<any> {
    const response = await fetch(path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token() ? {Authorization: `Token ${token()}`} : {}),
        },
        body: JSON.stringify(payload),
    });
    const json = await response.json();
    if (json.code !== 0) {
        throw new Error(`${path} failed: code=${json.code} msg=${json.msg}`);
    }
    return json.data;
}

export interface E2ECleanupOptions {
    docIds?: string[];
    attachmentIds?: string[];
    bookIds?: string[];
    /** Fixture path fragments; matching attachment records and files are removed. */
    testPaths?: string[];
    /** Close reader tabs whose title matches an E2E fixture copy. */
    closeReaderTabs?: boolean;
}

export interface E2ECleanupResult {
    docsDeleted: number;
    filesDeleted: number;
    attachmentsRemoved: number;
    tabsClosed: number;
    orphanBooksPruned: number;
    assetsDeleted: number;
    errors: string[];
}

/**
 * Test fixture paths created by a run (unique copies such as navigation-p1-*.pdf),
 * plus explicit copies of a source fixture (`sample-paper-e2e-*.pdf`). The source
 * fixtures themselves are never treated as disposable run artifacts.
 */
function isFixturePath(filePath: string, testPaths: string[]): boolean {
    const normalized = String(filePath || "").replaceAll("\\", "/");
    return testPaths.some(item => {
        const needle = String(item || "").replaceAll("\\", "/");
        return needle.length > 0 && normalized.includes(needle);
    });
}

/** True only for run-generated fixture copies, never for the checked-in fixtures. */
function isGeneratedFixtureCopy(filePath: string | undefined): boolean {
    const text = String(filePath || "").replaceAll("\\", "/");
    return /\/(navigation-p1-\d+|sample-paper-e2e-\d+)\.pdf$/i.test(text);
}

/** Assets created by a run's screenshot/rectangle features. */
export function isGeneratedAsset(assetPath: string): boolean {
    return /(^|\/)pz-(shot|rect|test)-[A-Za-z0-9._-]+\.png$/i.test(String(assetPath || "").replaceAll("\\", "/"));
}

/**
 * Remove artifacts a real E2E run created: its SiYuan documents, the unique PDF
 * copies it made, reader tabs, and plugin attachment records for those copies.
 * Never touches the user's own documents, PDFs or attachment records.
 */
export interface E2ECleanupHost {
    store: any;
    refreshDock: () => void;
    removeGeneratedAsset?: (assetPath: string) => Promise<void>;
}

export async function cleanupE2EArtifacts(
    plugin: E2ECleanupHost,
    options: E2ECleanupOptions,
): Promise<E2ECleanupResult> {
    const result: E2ECleanupResult = {docsDeleted: 0, filesDeleted: 0, attachmentsRemoved: 0, tabsClosed: 0, orphanBooksPruned: 0, assetsDeleted: 0, errors: []};
    const testPaths = (options.testPaths || []).filter(Boolean);
    const docIds = new Set((options.docIds || []).filter(Boolean));

    // Close reader tabs for this run's PDF copies before deleting the records.
    for (const tab of getAllTabs()) {
        const title = String(tab.title || "");
        const isTestReader = title.startsWith("navigation-p1-") || title.startsWith("sample-paper-e2e-");
        if (!isTestReader) {
            continue;
        }
        if (!options.closeReaderTabs) {
            continue;
        }
        try {
            tab.close();
            result.tabsClosed++;
        } catch (error: any) {
            result.errors.push(`close tab ${title}: ${error?.message || error}`);
        }
    }

    for (const docId of docIds) {
        try {
            await api("/api/filetree/removeDocByID", {id: docId});
            result.docsDeleted++;
        } catch (error: any) {
            result.errors.push(`remove doc ${docId}: ${error?.message || error}`);
        }
    }

    // Screenshot uploads made during the run: collected from the documents before
    // they are removed so the /assets files do not accumulate in this workspace.
    const docAssets = new Set<string>();
    for (const docId of docIds) {
        const markdown = await api("/api/block/getBlockKramdown", {id: docId})
            .then((data: any) => String(data?.kramdown || ""))
            .catch((): string => "");
        for (const match of markdown.matchAll(/assets\/(pz-[A-Za-z0-9._-]+\.png)/g)) {
            docAssets.add(`assets/${match[1]}`);
        }
    }
    for (const assetPath of docAssets) {
        if (!isGeneratedAsset(assetPath)) {
            continue;
        }
        try {
            await plugin.removeGeneratedAsset?.(assetPath);
            result.assetsDeleted++;
        } catch (error: any) {
            result.errors.push(`remove asset ${assetPath}: ${error?.message || error}`);
        }
    }

    const attachments = plugin.store.state.attachments || {};
    for (const [attachmentId, attachment] of Object.entries<any>(attachments)) {
        const listed = options.attachmentIds?.includes(attachmentId);
        if (!listed && !isFixturePath(attachment?.path, testPaths)) {
            continue;
        }
        const ownedByRun = !listed || (options.bookIds || []).includes(attachment?.bookId);
        if (ownedByRun && filesDeletedSafe(attachment?.path)) {
            try {
                requireNode("fs")?.rmSync?.(attachment.path, {force: true});
                result.filesDeleted++;
            } catch (error: any) {
                result.errors.push(`remove file ${attachment.path}: ${error?.message || error}`);
            }
        }
        const annotationIds = Object.values<any>(plugin.store.state.annotations || {})
            .filter(item => item?.attachmentId === attachmentId)
            .map(item => item.id);
        for (const annotationId of annotationIds) {
            delete plugin.store.state.annotations[annotationId];
        }
        for (const linkId of Object.keys(plugin.store.state.noteLinks || {})) {
            const link = plugin.store.state.noteLinks[linkId];
            if (annotationIds.includes(link?.annotationId)) {
                delete plugin.store.state.noteLinks[linkId];
            }
        }
        delete plugin.store.state.attachments[attachmentId];
        result.attachmentsRemoved++;
    }

    // Books this run created, plus any local book left without attachments by
    // earlier runs, are removed together with the attachments above.
    result.orphanBooksPruned = await plugin.store.pruneOrphanBooks();
    plugin.store.state.recentAttachmentIds = (plugin.store.state.recentAttachmentIds || [])
        .filter((id: string) => Boolean(plugin.store.state.attachments[id]));

    await plugin.store.save();
    plugin.refreshDock();
    return result;
}

function filesDeletedSafe(filePath: string | undefined): boolean {
    return isGeneratedFixtureCopy(filePath);
}
