import {getAllEditor} from "siyuan";
import type PdfZoteroPlugin from "./index";
import {citationHref} from "./citations";
import {newId} from "./storage";
import {e2eSleep as sleep} from "./e2e-utils";

export interface CitationProbeReport {
    ok: boolean;
    at: string;
    error?: string;
    steps: Array<{name: string; at: string; data?: any}>;
}

/** Minimal probe: does a citation span survive Protyle.insert and reach storage? */
export interface MarkdownProbe {
    blockId: string;
    docId: string;
    sqlHits: number;
    kramdown: string;
}

/** appendBlock a citation span through the kernel and read back what was stored. */
export async function appendCitationMarkdownProbe(): Promise<MarkdownProbe> {
    const {apiPost} = await import("./api");
    const editor = getAllEditor().find(item => item.protyle.wysiwyg?.element?.offsetParent) || getAllEditor()[0];
    const res = await apiPost<any>("/block/appendBlock", {
        parentID: String(editor.protyle.block.id || ""),
        dataType: "markdown",
        data: "[[?]](siyuan://plugins/siyuan-pdf-zotero/citation?id=probe-markdown)",
    });
    const transactions = Array.isArray(res) ? res : [];
    let blockId = "";
    for (const transaction of transactions) {
        for (const op of transaction?.doOperations || []) {
            if (op?.action === "insert" && op?.id) {
                blockId = String(op.id);
                break;
            }
        }
        if (blockId) break;
    }
    const docId = String(editor.protyle.block.rootID || "");
    const sql = await apiPost<any>("/query/sql", {
        stmt: `select id, markdown from blocks where root_id = '${docId}' and markdown like '%citation?id=%'`,
    }).catch((): any => ({data: []}));
    const rows = Array.isArray(sql) ? sql : (sql?.data || []);
    const kramdown = blockId
        ? await apiPost<any>("/block/getBlockKramdown", {id: blockId}).then((d: any) => String(d?.kramdown || "")).catch(() => "")
        : "";
    return {blockId, docId, sqlHits: rows.length, kramdown};
}

export async function runCitationProbe(plugin: PdfZoteroPlugin, markdownBefore?: MarkdownProbe): Promise<CitationProbeReport> {
    const report: CitationProbeReport = {ok: false, at: new Date().toISOString(), steps: []};
    const step = (name: string, data?: any) => {
        report.steps.push({name, at: new Date().toISOString(), data});
    };
    try {
        const editor = getAllEditor()[0];
        if (!editor) {
            throw new Error("no editor");
        }
        const citationId = newId("cit-probe");
        const href = citationHref(citationId);
        step("before-insert", {
            rootID: editor.protyle.block.rootID,
            hasWysiwyg: Boolean(editor.protyle.wysiwyg?.element),
            hasInsert: typeof editor.insert,
        });
        editor.insert(`<span data-type="a" data-href="${href}">[?]</span>`, false, false);
        await sleep(400);
        const found = Array.from(editor.protyle.wysiwyg?.element?.querySelectorAll?.("[data-href]") || [])
            .some((el: Element) => el.getAttribute("data-href") === href);
        step("after-insert", {found});

        const {formatCitationClusters, formatBibliography, CITATION_STYLES} = await import("./citation/csl");
        const items = plugin.store.state.zotero.items.filter(item => item.csl).slice(0, 2);
        step("style-meta", {
            styleCount: Object.keys(CITATION_STYLES).length,
            gbt: CITATION_STYLES.gbt7714 || null,
            apa: CITATION_STYLES.apa || null,
            cacheItems: plugin.store.state.zotero.items.length,
            cacheWithCsl: plugin.store.state.zotero.items.filter(item => item.csl).length,
        });
        const cslItems = items.map(item => item.csl as Record<string, any>);
        const cite = await formatCitationClusters(
            [{id: "probe", cslIds: cslItems.map(item => String(item.id)), options: {}}],
            cslItems,
            "gbt7714" as any,
        );
        step("format-citation", {cite});
        const bib = await formatBibliography(cslItems, "gbt7714" as any);
        step("format-bibliography", {entries: bib.slice(0, 2)});
        const {apiPost} = await import("./api");
        const editors = getAllEditor().map(item => ({
            rootID: item.protyle.block.rootID,
            blockID: item.protyle.block.id,
            offsetParent: Boolean(item.protyle.wysiwyg?.element?.offsetParent),
            visible: (() => {
                const rect = item.protyle.wysiwyg?.element?.getBoundingClientRect?.();
                return rect ? {w: Math.round(rect.width), h: Math.round(rect.height)} : null;
            })(),
            active: item === (window as any).siyuan?.mobile? false : document.activeElement === item.protyle.wysiwyg?.element,
            bodyActive: document.activeElement?.tagName || "",
        }));
        step("editors", {count: editors.length, editors});
        const {refreshDocumentCitations, insertCitation} = await import("./citations");
        const visible = getAllEditor().find(item => item.protyle.wysiwyg?.element?.offsetParent);
        step("visible-editor", {
            rootID: visible?.protyle.block.rootID || "",
            firstRootID: getAllEditor()[0]?.protyle.block.rootID || "",
            expectedRootID: markdownBefore?.docId || "",
        });
        const cacheFirst = plugin.store.state.zotero.items.find(item => item.csl);
        if (markdownBefore && cacheFirst?.csl) {
            const cite = await insertCitation(plugin.store, [cacheFirst.key], "gbt7714" as any, {});
            step("probe-insert-citation", {citationId: cite?.id || "", blockId: cite?.siyuanBlockId || "", docId: cite?.siyuanDocId || ""});
            const refreshed = await refreshDocumentCitations(plugin.store, markdownBefore.docId);
            step("probe-refresh", {citationCount: refreshed.citationCount, debug: refreshed.debug});
        }

        // Selection toolbar: the reader relies on document.visibilityState being
        // "visible" to build its float; E2E may run against an unfocused window.
        const {selectTextOnPage} = await import("./e2e");
        const reader = document.querySelector<HTMLElement>(".pz-reader");
        step("visibility", {
            state: document.visibilityState,
            hasReader: Boolean(reader),
            pageSpanCount: reader?.querySelectorAll('.pz-page[data-page="1"] .pz-text-layer span').length || 0,
        });
        if (reader) {
            document.querySelectorAll(".pz-float").forEach(el => el.remove());
            const selected = selectTextOnPage(reader, 1);
            await sleep(500);
            const float = document.querySelector<HTMLElement>(".pz-float");
            step("selection-float", {
                selected: selected.slice(0, 60),
                float: Boolean(float),
                debug: reader.dataset.pzSelectionDebug || "",
            });
            if (!float) {
                // Retry as the active document: a non-focused SiYuan window reports
                // visibilityState=hidden and captureSelection skips building the float.
                const target = document.querySelector<HTMLElement>(`.pz-page[data-page="1"]`);
                target?.scrollIntoView({block: "center"});
                await sleep(150);
                const again = selectTextOnPage(reader, 1);
                await sleep(400);
                step("selection-retry", {
                    selected: again.slice(0, 60),
                    float: Boolean(document.querySelector(".pz-float")),
                    debug: reader.dataset.pzSelectionDebug || "",
                    pageRect: target ? (() => {
                        const r = target.getBoundingClientRect();
                        return {top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height)};
                    })() : null,
                });
            }
        }
        report.ok = true;
        return report;
    } catch (error: any) {
        report.error = `${error?.message || error}\n${String(error?.stack || "").split("\n").slice(0, 6).join("\n")}`;
        return report;
    }
}
