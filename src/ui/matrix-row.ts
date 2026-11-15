import {Dialog, showMessage} from "siyuan";
import type {PluginHost} from "../host";
import type {MatrixColumn, MatrixProject, MatrixRow} from "../types";
import {createNoteFromTemplate} from "../template/notes";
import {formulaValue} from "../matrix/model";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch] as string));
}

function field(project: MatrixProject, column: MatrixColumn, row: MatrixRow): string {
    if (column.type === "formula") return `<input class="b3-text-field fn__block" value="${escapeHtml(formulaValue(project, row, column))}" readonly />`;
    const value = row.values[column.id];
    if (column.type === "longtext") {
        return `<textarea class="b3-text-field fn__block" rows="4" data-column="${column.id}">${escapeHtml(String(value ?? ""))}</textarea>`;
    }
    if (column.type === "select") {
        return `<select class="b3-select fn__block" data-column="${column.id}">${["", ...(column.options || [])].map(option => `<option value="${escapeHtml(option)}" ${String(value ?? "") === option ? "selected" : ""}>${escapeHtml(option || "—")}</option>`).join("")}</select>`;
    }
    if (column.type === "multiselect") {
        return `<input class="b3-text-field fn__block" value="${escapeHtml(Array.isArray(value) ? value.join(", ") : String(value ?? ""))}" data-column="${column.id}" placeholder="逗号分隔" />`;
    }
    if (column.type === "url") {
        return `<input class="b3-text-field fn__block" type="url" value="${escapeHtml(String(value ?? ""))}" data-column="${column.id}" />`;
    }
    if (column.type === "relation") {
        return `<input class="b3-text-field fn__block" value="${escapeHtml(String(value ?? ""))}" data-column="${column.id}" readonly />`;
    }
    if (column.type === "rating" || column.type === "number") {
        return `<input class="b3-text-field fn__block" type="number" value="${escapeHtml(String(value ?? ""))}" data-column="${column.id}" />`;
    }
    if (column.type === "checkbox") {
        return `<input type="checkbox" ${value ? "checked" : ""} data-column="${column.id}" />`;
    }
    if (column.type === "date") {
        return `<input class="b3-text-field fn__block" type="date" value="${escapeHtml(String(value ?? ""))}" data-column="${column.id}" />`;
    }
    return `<input class="b3-text-field fn__block" value="${escapeHtml(String(value ?? ""))}" data-column="${column.id}" />`;
}

export function openMatrixRow(host: PluginHost, project: MatrixProject, row: MatrixRow): Dialog {
    const item = (host.store.state.zotero.items || []).find(entry => entry.key === row.itemKey);
    const columns = project.columns.filter(column => !column.system && column.visible);
    const dialog = new Dialog({
        title: `文献详情：${String(row.values.title || row.itemKey)}`,
        width: "820px",
        content: `<div class="b3-dialog__content pz-matrix-row-detail">
  <div class="pz-muted" style="margin-bottom:8px">${escapeHtml(String(row.values.authors || ""))}${row.values.year ? ` · ${escapeHtml(String(row.values.year))}` : ""} · ${escapeHtml(String(row.values.venue || ""))}</div>
  <div class="fn__flex" style="gap:6px;margin-bottom:8px">
    <button class="b3-button b3-button--outline" data-act="row-zotero">打开 Zotero 条目</button>
    <button class="b3-button b3-button--outline" data-act="row-note">打开/创建笔记</button>
    <button class="b3-button b3-button--outline" data-act="row-open-note" ${row.noteDocId ? "" : "disabled"}>打开已有笔记</button>
  </div>
  <div class="pz-matrix-row-fields">${columns.map(column => `<label class="pz-matrix-row-field"><span>${escapeHtml(column.name)}</span>${field(project, column, row)}</label>`).join("")}</div>
  ${item?.abstract ? `<details style="margin-top:8px"><summary>Zotero 摘要</summary><p style="font-size:12px">${escapeHtml(item.abstract)}</p></details>` : ""}
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="row-cancel">关闭</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="row-save">保存</button></div>`,
    });
    const save = async () => {
        for (const element of Array.from(dialog.element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-column]"))) {
            const columnId = element.dataset.column || "";
            row.values[columnId] = element instanceof HTMLInputElement && element.type === "checkbox" ? element.checked : element.value;
        }
        project.updatedAt = Date.now();
        await host.store.save();
        showMessage("矩阵行已保存", 2000);
    };
    dialog.element.querySelector('[data-act="row-zotero"]')?.addEventListener("click", () => void host.openZoteroItem(row.itemKey));
    dialog.element.querySelector('[data-act="row-note"]')?.addEventListener("click", async () => {
        const docId = await createNoteFromTemplate(host, row.itemKey);
        if (docId) row.noteDocId = docId;
        await host.store.save();
        dialog.destroy();
    });
    dialog.element.querySelector('[data-act="row-open-note"]')?.addEventListener("click", () => {
        if (row.noteDocId) host.openDoc(row.noteDocId);
    });
    dialog.element.querySelector('[data-act="row-save"]')?.addEventListener("click", async () => {
        await save();
        dialog.destroy();
    });
    dialog.element.querySelector('[data-act="row-cancel"]')?.addEventListener("click", () => dialog.destroy());
    return dialog;
}
