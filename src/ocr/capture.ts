export async function readClipboardImage(): Promise<Blob> {
    if (!navigator.clipboard?.read) {
        throw new Error("当前环境不支持读取剪贴板图片");
    }
    const items = await navigator.clipboard.read();
    for (const item of items) {
        const type = item.types.find(candidate => candidate.startsWith("image/"));
        if (type) return item.getType(type);
    }
    throw new Error("剪贴板中没有图片");
}
