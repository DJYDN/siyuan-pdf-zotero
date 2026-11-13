import type PdfZoteroPlugin from "./index";
import {e2eSleep as sleep} from "./e2e-utils";

async function api(path: string, payload: Record<string, any> = {}): Promise<any> {
    const token = String((window as any).siyuan?.config?.api?.token || "");
    const response = await fetch(path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token ? {Authorization: `Token ${token}`} : {}),
        },
        body: JSON.stringify(payload),
    });
    const json = await response.json();
    if (json.code !== 0) {
        throw new Error(`${path} failed: ${json.code} ${json.msg}`);
    }
    return json.data;
}

export interface P3E2EReport {
    ok: boolean;
    at: string;
    steps: Array<{name: string; at: string; data?: any}>;
    error?: string;
}

export async function runP3E2E(plugin: PdfZoteroPlugin, onProgress?: (report: P3E2EReport) => Promise<void>): Promise<P3E2EReport> {
    const report: P3E2EReport = {ok: false, at: new Date().toISOString(), steps: []};
    const step = (name: string, data?: any) => {
        report.steps.push({name, at: new Date().toISOString(), data});
        void onProgress?.(JSON.parse(JSON.stringify(report)));
    };
    try {
        const samplePath = "test-fixtures/sample-paper.pdf";
        const attachment = await plugin.importLocalPath(samplePath);
        if (!attachment) {
            throw new Error("could not import sample PDF");
        }
        const originalFingerprint = attachment.fingerprint;
        const annotationId = `ann-p3-${Date.now()}`;
        const noteLinkId = `nl-p3-${Date.now()}`;
        plugin.store.state.annotations[annotationId] = {
            id: annotationId,
            attachmentId: attachment.id,
            page: 1,
            rects: [{x: 0.1, y: 0.1, w: 0.2, h: 0.02}],
            text: "P3 relink anchor",
            color: "#ffd400",
            pageWidth: 612,
            pageHeight: 792,
            rotation: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        plugin.store.state.noteLinks[noteLinkId] = {
            id: noteLinkId,
            annotationId,
            siyuanBlockId: "20260101000000-p3test",
            siyuanDocId: "20260101000000-p3doc",
            createdAt: Date.now(),
        };
        attachment.path = "test-fixtures/__missing-p3__.pdf";
        await plugin.store.save();
        step("attachment-broken", {
            attachmentId: attachment.id,
            annotations: Object.values(plugin.store.state.annotations).filter(item => item.attachmentId === attachment.id).length,
            noteLinks: Object.values(plugin.store.state.noteLinks).filter(item => item.annotationId === annotationId).length,
        });

        const relinkedId = await (window as any).__pdfZotero.relinkAttachmentPath(attachment.id, samplePath);
        const relinked = plugin.store.getAttachment(attachment.id);
        step("attachment-relinked", {
            relinkedId,
            path: relinked?.path,
            fingerprintMatches: relinked?.fingerprint === originalFingerprint,
            annotationsRetained: Object.values(plugin.store.state.annotations).filter(item => item.attachmentId === attachment.id).length,
            noteLinksRetained: Object.values(plugin.store.state.noteLinks).filter(item => item.annotationId === annotationId).length,
        });
        if (!relinked || relinked.path !== samplePath) {
            throw new Error("relink did not update path");
        }
        if (relinked.fingerprint !== originalFingerprint) {
            throw new Error("relink fingerprint mismatch");
        }
        if (!plugin.store.state.annotations[annotationId] || !plugin.store.state.noteLinks[noteLinkId]) {
            throw new Error("annotation or note link lost during relink");
        }

        await plugin.store.backupNow();
        await sleep(300);
        const token = String((window as any).siyuan?.config?.api?.token || "");
        const backupResponse = await fetch("/api/file/getFile", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(token ? {Authorization: `Token ${token}`} : {}),
            },
            body: JSON.stringify({path: "data/storage/petal/siyuan-pdf-zotero/state-backup-1"}),
        });
        const backupData = JSON.parse(await backupResponse.text());
        step("backup", {
            backupAt: plugin.store.lastBackupAt,
            backupHasVersion: Boolean(backupData?.version),
            backupBooks: Object.keys(backupData?.books || {}).length,
        });
        if (!backupData?.version) {
            throw new Error("state-backup-1 missing or invalid");
        }

        report.ok = true;
        step("done");
        return report;
    } catch (error: any) {
        report.error = error?.stack || error?.message || String(error);
        step("error", {message: error?.message || String(error)});
        return report;
    }
}
