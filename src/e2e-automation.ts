import type PdfZoteroPlugin from "./index";

const NOTEBOOK_ID = "20261106222046-58z8mvd";
const INDEX_TITLE = "📚 E2E AI 自动化索引";
const MOCK_BASE = "http://127.0.0.1:18765/v1";

function token(): string {
    return String((window as any).siyuan?.config?.api?.token || "");
}

async function api(path: string, payload: Record<string, any> = {}): Promise<any> {
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
        throw new Error(`${path}: ${json.msg}`);
    }
    return json.data;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs: number): Promise<T> {
    const start = Date.now();
    let last: any = null;
    while (Date.now() - start < timeoutMs) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (error) {
            last = error;
        }
        await sleep(1000);
    }
    throw new Error(`timeout${last ? `: ${last.message || last}` : ""}`);
}

export async function runAutomationE2E(
    plugin: PdfZoteroPlugin,
    progress: (data: any) => Promise<void>,
): Promise<any> {
    const anyPlugin = plugin as any;
    const report: any = {ok: false, at: new Date().toISOString(), steps: []};
    const step = async (name: string, data: any = {}) => {
        report.steps.push({name, at: new Date().toISOString(), ...data});
        await progress(report);
    };
    const oldSettings = {...plugin.store.state.settings};
    const oldAi = (window as any).siyuan?.config?.ai;
    const oldProviders = oldAi?.providers;
    const oldAgentModel = oldAi?.agent?.modelId;
    const createdSummaryIds: string[] = [];
    let indexDocId = "";
    try {
        await step("start", {notebook: NOTEBOOK_ID});
        if (!oldAi) throw new Error("window.siyuan.config.ai unavailable");
        oldAi.providers = [{
            id: "automation-mock",
            displayName: "Automation Mock",
            baseURL: MOCK_BASE,
            apiKey: "test-key",
            authType: "",
            protocol: "openai",
            enabled: true,
            models: ["mock-model"],
        }];
        oldAi.agent = {...(oldAi.agent || {}), modelId: "mock-model"};

        anyPlugin.automation?.stop();
        await plugin.removeData("automation-state").catch((): void => {});
        plugin.store.updateSettings({
            automationEnabled: true,
            automationNotebookId: NOTEBOOK_ID,
            automationIndexTitle: INDEX_TITLE,
            automationBackfill: true,
            automationModelId: "mock-model",
            automationMaxChars: 450,
            automationDebug: true,
        });
        await plugin.store.save();
        anyPlugin.restartAutomation();
        await step("automation-started", {});

        const docs = await waitFor(async () => {
            const rows = await api("/api/query/sql", {
                stmt: `select id,content from blocks where box='${NOTEBOOK_ID}' and type='d'`,
            });
            return rows.length >= 2 ? rows : null;
        }, 30_000);
        const indexDoc = await waitFor(async () => {
            const rows = await api("/api/query/sql", {
                stmt: `select id,content from blocks where box='${NOTEBOOK_ID}' and type='d' and content='${INDEX_TITLE}'`,
            });
            return rows[0] || null;
        }, 45_000);
        indexDocId = indexDoc.id;
        await step("index-created", {indexDocId, docs: docs.length});

        const summaries = await waitFor(async () => {
            const rows = await api("/api/query/sql", {
                stmt: "select block_id from attributes where name='custom-ai-summary' and value='true'",
            });
            return rows.length >= 2 ? rows : null;
        }, 75_000);
        for (const row of summaries) {
            if (!createdSummaryIds.includes(row.block_id)) createdSummaryIds.push(row.block_id);
        }
        await step("summaries-created", {count: createdSummaryIds.length, ids: createdSummaryIds});

        const docDom = await api("/api/block/getBlockDOM", {id: docs.find((doc: any) => doc.content !== INDEX_TITLE).id});
        const first = new DOMParser().parseFromString(docDom.dom, "text/html").querySelector<HTMLElement>("[data-node-id]");
        const firstAttrs = first ? await api("/api/attr/getBlockAttrs", {id: first.dataset.nodeId}) : {attrs: {}};
        await step("summary-at-top", {
            firstType: first?.dataset.type || "",
            summaryAttr: firstAttrs?.attrs?.["custom-ai-summary"] || firstAttrs?.["custom-ai-summary"] || "",
        });

        const indexDom = await api("/api/block/getBlockDOM", {id: indexDocId});
        const indexParsed = new DOMParser().parseFromString(indexDom.dom, "text/html");
        const links = Array.from(indexParsed.querySelectorAll<HTMLElement>('[data-type="a"]')).map(item => item.getAttribute("data-href"));
        await step("index-table", {
            hasTable: Boolean(indexParsed.querySelector('[data-type="NodeTable"]')),
            hasOpenColumn: indexDom.dom.includes("打开"),
            linkCount: links.length,
            links,
        });
        const ok = createdSummaryIds.length >= 2
            && Boolean(indexParsed.querySelector('[data-type="NodeTable"]'))
            && links.some(link => link?.startsWith("siyuan://blocks/"))
            && (firstAttrs?.attrs?.["custom-ai-summary"] === "true" || firstAttrs?.["custom-ai-summary"] === "true");
        report.ok = ok;
        await step("done", {ok});
        return report;
    } catch (error: any) {
        report.error = error?.stack || error?.message || String(error);
        await step("error", {error: report.error});
        return report;
    } finally {
        anyPlugin.automation?.stop();
        anyPlugin.automation = null;
        for (const id of createdSummaryIds) {
            await api("/api/block/deleteBlock", {id}).catch((): void => {});
        }
        if (indexDocId) {
            await api("/api/filetree/removeDocByID", {id: indexDocId}).catch((): void => {});
        }
        await plugin.removeData("automation-state").catch((): void => {});
        plugin.store.updateSettings({
            automationEnabled: oldSettings.automationEnabled,
            automationNotebookId: oldSettings.automationNotebookId,
            automationIndexTitle: oldSettings.automationIndexTitle,
            automationBackfill: oldSettings.automationBackfill,
            automationModelId: oldSettings.automationModelId,
            automationMaxChars: oldSettings.automationMaxChars,
            automationDebug: oldSettings.automationDebug,
        });
        await plugin.store.save();
        if (oldAi) {
            oldAi.providers = oldProviders;
            oldAi.agent = {...(oldAi.agent || {}), modelId: oldAgentModel};
        }
    }
}
