function token(): string {
    return String((window as any).siyuan?.config?.api?.token || "");
}

export async function apiPost<T = any>(path: string, payload: Record<string, any> = {}): Promise<T> {
    const response = await fetch(`/api${path.startsWith("/") ? "" : "/"}${path}`, {
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
    return json.data as T;
}

export async function querySql<T = any>(stmt: string): Promise<T[]> {
    const data = await apiPost<any>("/query/sql", {stmt});
    // /api/query/sql returns data as the rows array; tolerate an extra {data:...} wrapper.
    return Array.isArray(data) ? data : (data?.data || []);
}

export async function getBlockDom(id: string): Promise<string> {
    const data = await apiPost<any>("/block/getBlockDOM", {id});
    return data?.dom || data?.data?.dom || "";
}

export async function updateBlockDom(id: string, dom: string): Promise<void> {
    await apiPost("/block/updateBlock", {id, dataType: "dom", data: dom});
}

export async function updateBlockMarkdown(id: string, markdown: string): Promise<void> {
    await apiPost("/block/updateBlock", {id, dataType: "markdown", data: markdown});
}

export async function deleteBlock(id: string): Promise<void> {
    await apiPost("/block/deleteBlock", {id});
}

export interface InsertedBlockIds {
    ids: string[];
    transaction: any;
}

function insertedIds(operations: any): string[] {
    const ids: string[] = [];
    const transactions = Array.isArray(operations) ? operations : [operations];
    for (const transaction of transactions) {
        for (const op of transaction?.doOperations || []) {
            if (op?.action === "insert" && op?.id) {
                ids.push(String(op.id));
            }
        }
    }
    return ids;
}

export async function appendMarkdown(parentID: string, markdown: string): Promise<InsertedBlockIds> {
    const data = await apiPost("/block/appendBlock", {dataType: "markdown", data: markdown, parentID});
    return {ids: insertedIds(data), transaction: data};
}

export async function prependMarkdown(parentID: string, markdown: string): Promise<InsertedBlockIds> {
    const data = await apiPost("/block/prependBlock", {dataType: "markdown", data: markdown, parentID});
    return {ids: insertedIds(data), transaction: data};
}

export async function createDocWithMd(notebook: string, path: string, markdown: string): Promise<string> {
    const data = await apiPost<any>("/filetree/createDocWithMd", {notebook, path, markdown});
    return String(data?.id || data || "");
}

export async function setBlockAttrs(id: string, attrs: Record<string, string>): Promise<void> {
    await apiPost("/attr/setBlockAttrs", {id, attrs});
}

export async function getBlockAttrs(id: string): Promise<Record<string, string>> {
    const data = await apiPost<any>("/attr/getBlockAttrs", {id});
    return (data?.attrs || data) as Record<string, string>;
}

export async function checkBlockExist(id: string): Promise<boolean> {
    try {
        const data = await apiPost<any>("/block/checkBlockExist", {id});
        return Boolean(data?.exist ?? data);
    } catch {
        return false;
    }
}

export async function removeDocByID(id: string): Promise<void> {
    await apiPost("/filetree/removeDocByID", {id});
}

export async function getBlockKramdown(id: string): Promise<string> {
    const data = await apiPost<any>("/block/getBlockKramdown", {id});
    return data?.kramdown || data?.data?.kramdown || "";
}
