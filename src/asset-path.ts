/** Normalize the path returned by /api/asset/upload to a note-relative assets/ path. */
export function normalizeAssetPath(raw: string): string {
    return String(raw || "")
        .replace(/^\/+/, "")
        .replace(/^data\/assets\//, "assets/")
        .replace(/^assets\//, "assets/");
}

function escapeHtml(value: string): string {
    return String(value || "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch] as string));
}

export function imageHtml(assetPath: string, alt: string): string {
    return `<img src="${normalizeAssetPath(assetPath)}" alt="${escapeHtml(alt)}" title="${escapeHtml(alt)}" />`;
}

function escapeMarkdownLabel(value: string): string {
    return String(value || "").replace(/[\\\[\]]/g, "\\$&");
}

export function linkedImageMarkdown(assetPath: string, alt: string, href = "", caption = ""): string {
    const title = String(caption || "").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    // Keep the navigation target in the URL fragment. The fragment is preserved
    // by Lute, never sent while loading the asset, and can be read from the image
    // itself without rendering a second text link in the note.
    const marker = href ? `#pz=${encodeURIComponent(href)}` : "";
    const path = `${normalizeAssetPath(assetPath)}${marker}`;
    return title
        ? `![${escapeMarkdownLabel(alt)}](${path} "${title}")`
        : `![${escapeMarkdownLabel(alt)}](${path})`;
}
