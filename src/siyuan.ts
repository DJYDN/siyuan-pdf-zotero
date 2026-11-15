import {getActiveEditor, getAllEditor} from "siyuan";
import {showMessage} from "siyuan";
import {imageHtml, linkedImageMarkdown, normalizeAssetPath} from "./asset-path";
import type {NoteInsertionTarget} from "./host";
import {recordAssetSafe} from "./asset-journal";
import {deleteBlock, insertBlockAfter} from "./api";

export interface InsertedImage {
    blockId: string;
    docId: string;
}

function token(): string {
    return String((window as any).siyuan?.config?.api?.token || "");
}

export async function uploadPngAsset(blob: Blob, baseName: string): Promise<string> {
    const form = new FormData();
    // "assets" (not "/data/assets") makes the kernel return the note-relative
    // path `assets/...`; "/data/assets" writes under data/data/assets and breaks <img>.
    form.append("assetsDirPath", "assets");
    form.append("file[]", blob, baseName);
    const response = await fetch("/api/asset/upload", {
        method: "POST",
        headers: token() ? {Authorization: `Token ${token()}`} : {},
        body: form,
    });
    const json = await response.json();
    if (json.code !== 0) {
        throw new Error(json.msg || "资源上传失败");
    }
    const map = json.data?.succMap || {};
    const rawPath = map[baseName] || json.data?.succFiles?.[0]?.path;
    if (!rawPath) {
        throw new Error("资源上传成功但内核没有返回路径");
    }
    // Accept both `/assets/x.png`, `assets/x.png` and legacy `data/assets/x.png`.
    const normalized = normalizeAssetPath(String(rawPath));
    // Journal plugin-created assets so maintenance can find them after notes change.
    recordAssetSafe(normalized);
    return normalized;
}

export function insertHtmlAtCursor(html: string, isBlock = false): boolean {
    const editor = getActiveEditor() || getAllEditor()[0];
    if (!editor) {
        showMessage("请先打开一个思源文档，再插入内容");
        return false;
    }
    editor.insert(html, isBlock, false);
    return true;
}

/**
 * Insert a Markdown block through the kernel API. This is used when the
 * content needs SiYuan's own Markdown extensions (for example ^[上标](链接)^),
 * which Protyle.insert() would otherwise treat as literal text.
 */
export async function insertMarkdownAtCursor(
    markdown: string,
    target: NoteInsertionTarget = {docId: ""},
): Promise<string> {
    const editor = (target.docId && getAllEditor().find(item => item.protyle.block.rootID === target.docId))
        || getActiveEditor()
        || getAllEditor()[0];
    if (!editor) {
        showMessage("请先打开一个思源文档，再插入内容");
        return "";
    }
    const rootId = String(editor.protyle?.block?.rootID || "");
    const blockId = String(target.blockId || editor.protyle?.block?.id || "");
    const payload: Record<string, any> = {dataType: "markdown", data: markdown};
    if (blockId && blockId !== rootId) {
        if (target.blockId && (target.textOffset || 0) === 0) {
            payload.nextID = blockId;
        } else {
            payload.previousID = blockId;
        }
    } else {
        payload.parentID = rootId;
    }
    try {
        const response = await fetch("/api/block/insertBlock", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(token() ? {Authorization: `Token ${token()}`} : {}),
            },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (response.ok && result.code === 0) {
            const operations = (Array.isArray(result.data) ? result.data : [])
                .flatMap((transaction: any) => transaction?.doOperations || [])
                .filter(Boolean);
            const inserted = operations.find((operation: any) => operation.action === "insert" || operation.action === "appendInsert" || operation.action === "prependInsert");
            return String(inserted?.id || inserted?.blockID || "");
        }
        console.warn("[pdf-zotero] insertMarkdownAtCursor failed", result);
    } catch (error) {
        console.warn("[pdf-zotero] insertMarkdownAtCursor failed", error);
    }
    // Last-resort fallback: let Protyle insert the raw text rather than silently
    // dropping the user's translation.
    editor.insert(markdown.replace(/\^/g, ""), false, false);
    return "";
}

/** Delete a plugin-generated asset through the kernel; ignores already-missing files. */
export async function removeAsset(assetPath: string): Promise<boolean> {
    const normalized = normalizeAssetPath(assetPath);
    const response = await fetch("/api/asset/removeAsset", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token() ? {Authorization: `Token ${token()}`} : {}),
        },
        body: JSON.stringify({path: normalized}),
    });
    const json = await response.json().catch((): any => ({code: -1}));
    return json.code === 0;
}

export async function replaceSelectionWithMarkdown(markdown: string, target: NoteInsertionTarget = {docId: ""}): Promise<boolean> {
    const editor = (target.docId && getAllEditor().find(item => item.protyle.block.rootID === target.docId))
        || getActiveEditor()
        || getAllEditor()[0];
    if (!editor) {
        showMessage("请先打开一个思源笔记");
        return false;
    }
    const wysiwyg = editor.protyle?.wysiwyg?.element as HTMLElement | undefined;
    if (!wysiwyg) return false;
    let range: Range | undefined = target.range;
    if (target.trackedHandle) {
        try {
            const resolved = editor.protyle.resolveTrackedRange(target.trackedHandle as any);
            if (resolved.status === "resolved") range = resolved.range;
        } catch {
            // fall back to the captured range
        }
    }
    const rangeNode = range?.commonAncestorContainer;
    const rangeElement = rangeNode ? (rangeNode.nodeType === Node.ELEMENT_NODE ? rangeNode as Element : rangeNode.parentElement) : null;
    const capturedBlock = target.blockId ? wysiwyg.querySelector<HTMLElement>(`[data-node-id="${target.blockId}"]`) : null;
    const mathBlock = rangeElement?.closest<HTMLElement>('[data-type="NodeMathBlock"]')
        || capturedBlock?.closest<HTMLElement>('[data-type="NodeMathBlock"]')
        || (capturedBlock?.matches('[data-type="NodeMathBlock"]') ? capturedBlock : null);
    if (mathBlock?.dataset.nodeId) {
        const inserted = await insertBlockAfter(mathBlock.dataset.nodeId, markdown);
        if (inserted.ids.length) {
            await deleteBlock(mathBlock.dataset.nodeId);
            return true;
        }
        return false;
    }
    const selection = window.getSelection();
    if (selection && range) {
        try {
            const node = range.commonAncestorContainer;
            const owner = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
            if (node.isConnected && owner && wysiwyg.contains(owner)) {
                selection.removeAllRanges();
                selection.addRange(range);
            }
        } catch {
            // use the current editor selection
        }
    }
    wysiwyg.focus({preventScroll: true});
    editor.insert(markdown, false, false);
    return true;
}

export async function insertImageAtCursor(assetPath: string, alt = "PDF 区域截图", target: NoteInsertionTarget = {docId: ""}, sourceHref = "", sourceText = ""): Promise<InsertedImage | null> {
    const editor = (target.docId && getAllEditor().find(item => item.protyle.block.rootID === target.docId))
        || getActiveEditor()
        || getAllEditor()[0];
    if (!editor) {
        showMessage("请先打开一个思源文档，再插入内容");
        return null;
    }
    const path = normalizeAssetPath(assetPath);
    // Convert a standard Markdown linked image through SiYuan's own Lute
    // instance. Raw <a><img></a> is otherwise persisted as literal HTML, while
    // a data-type=a span causes Protyle to discard the nested image.
    const markdown = linkedImageMarkdown(path, alt, sourceHref, sourceText);
    if (target.blockId) {
        try {
            const before = (target.textOffset || 0) === 0;
            const response = await fetch("/api/block/insertBlock", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(token() ? {Authorization: `Token ${token()}`} : {}),
                },
                body: JSON.stringify({
                    dataType: "markdown",
                    data: markdown,
                    ...(before ? {nextID: target.blockId} : {previousID: target.blockId}),
                }),
            });
            const result = await response.json();
            if (response.ok && result.code === 0) {
                const operations = (Array.isArray(result.data) ? result.data : [])
                    .flatMap((transaction: any) => transaction?.doOperations || [])
                    .filter(Boolean);
                const inserted = operations.find((operation: any) => operation.action === "insert" || operation.action === "appendInsert" || operation.action === "prependInsert");
                let blockId = String(inserted?.id || inserted?.blockID || "");
                if (!blockId) {
                    const query = await fetch("/api/query/sql", {
                        method: "POST",
                        headers: {"Content-Type": "application/json", ...(token() ? {Authorization: `Token ${token()}`} : {})},
                        body: JSON.stringify({stmt: `select id from blocks where root_id='${target.docId.replaceAll("'", "''")}' and markdown like '%${path.replaceAll("'", "''")}%' order by updated desc limit 1`}),
                    });
                    const queried = await query.json();
                    blockId = String(queried.data?.[0]?.id || "");
                }
                return {blockId, docId: target.docId};
            }
            console.warn("[pdf-zotero] insertBlock bookmark failed; falling back to Protyle.insert", result);
        } catch (error) {
            console.warn("[pdf-zotero] insertBlock bookmark failed; falling back to Protyle.insert", error);
        }
    }
    const lute = (window as any).Lute?.New?.();
    const blockDom = lute?.Md2BlockDOM?.(markdown);
    const wysiwyg = editor.protyle?.wysiwyg?.element as HTMLElement | undefined;
    let trackedRange: Range | undefined;
    if (target.trackedHandle) {
        try {
            const result = editor.protyle.resolveTrackedRange(target.trackedHandle as any);
            if (result.status === "resolved") {
                trackedRange = result.range;
            }
        } catch {
            trackedRange = undefined;
        }
    }
    wysiwyg?.focus({preventScroll: true});
    const selection = document.getSelection();
    let restored = false;
    const preferredRange = trackedRange || target.range;
    if (selection && preferredRange) {
        try {
            const node = preferredRange.commonAncestorContainer;
            const owner = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
            if (node.isConnected && owner && wysiwyg?.contains(owner)) {
                selection.removeAllRanges();
                selection.addRange(preferredRange);
                restored = true;
            }
        } catch {
            // The note changed after capture; use the explicit end-of-document fallback below.
        }
    }
    if (selection && !restored && target.blockId && wysiwyg) {
        const block = wysiwyg.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(target.blockId)}"]`);
        if (block) {
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            let remaining = Math.max(0, target.textOffset || 0);
            let textNode: Node | null = null;
            let node: Node | null;
            while ((node = walker.nextNode())) {
                textNode = node;
                const length = node.textContent?.length || 0;
                if (remaining <= length) {
                    const range = document.createRange();
                    range.setStart(node, remaining);
                    range.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    restored = true;
                    break;
                }
                remaining -= length;
            }
            if (!restored && textNode) {
                const range = document.createRange();
                range.setStart(textNode, textNode.textContent?.length || 0);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                restored = true;
            }
        }
    }
    if (selection && !restored) {
        const range = document.createRange();
        range.selectNodeContents(wysiwyg!);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }
    if (restored && editor.protyle?.toolbar) {
        editor.protyle.toolbar.range = selection!.getRangeAt(0).cloneRange();
    }
    editor.insert(blockDom || imageHtml(path, alt), true, restored);
    if (target.trackedHandle) {
        try {
            editor.protyle.releaseTrackedRange(target.trackedHandle as any);
        } catch {
            // Already released by the host.
        }
    }
    return {blockId: "", docId: target.docId || String(editor.protyle.block.rootID || "")};
}
