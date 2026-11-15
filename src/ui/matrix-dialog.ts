import {Dialog, getAllEditor, getActiveEditor, showMessage} from "siyuan";
import {createDocWithMd} from "../api";
import type {PluginHost} from "../host";
import type {MatrixColumn, MatrixProject, MatrixRow} from "../types";
import {createMatrixProject, rowForZoteroItem} from "../matrix/model";
import {createNoteFromTemplate} from "../template/notes";
import {openMatrixRow} from "./matrix-row";
import {openMatrixAI} from "./matrix-ai";
import {newId} from "../storage";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch] as string));
}

function ensureProject(host: PluginHost): MatrixProject {
    const state = host.store.state;
    if (!state.matrixProjects?.length) {
        const project = createMatrixProject("我的研究项目");
        state.matrixProjects = [project];
        state.matrixActiveProjectId = project.id;
        void host.store.save();
    }
    let project = state.matrixProjects.find(item => item.id === state.matrixActiveProjectId) || state.matrixProjects[0];
    if (!state.matrixActiveProjectId) state.matrixActiveProjectId = project.id;
    return project;
}

function downloadText(fileName: string, text: string): void {
    const blob = new Blob(["\ufeff", text], {type: "text/csv;charset=utf-8"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function cellInput(project: MatrixProject, row: MatrixRow, column: MatrixColumn): string {
    const value = row.values[column.id];
    if (column.system) {
        return `<div class="pz-matrix-readonly">${escapeHtml(String(value ?? ""))}</div>`;
    }
    if (column.type === "select") {
        const options = column.options || [];
        return `<select class="b3-select pz-matrix-cell" data-row="${row.id}" data-column="${column.id}">${["", ...options].map(option => `<option value="${escapeHtml(option)}" ${String(value ?? "") === option ? "selected" : ""}>${escapeHtml(option || "—")}</option>`).join("")}</select>`;
    }
    if (column.type === "rating") {
        return `<input class="b3-text-field pz-matrix-cell" type="number" min="1" max="5" value="${escapeHtml(String(value ?? ""))}" data-row="${row.id}" data-column="${column.id}" style="width:60px" />`;
    }
    if (column.type === "number") {
        return `<input class="b3-text-field pz-matrix-cell" type="number" value="${escapeHtml(String(value ?? ""))}" data-row="${row.id}" data-column="${column.id}" />`;
    }
    if (column.type === "longtext") {
        return `<textarea class="b3-text-field pz-matrix-cell" rows="2" data-row="${row.id}" data-column="${column.id}">${escapeHtml(String(value ?? ""))}</textarea>`;
    }
    if (column.type === "checkbox") {
        return `<input class="pz-matrix-cell" type="checkbox" ${value ? "checked" : ""} data-row="${row.id}" data-column="${column.id}" />`;
    }
    if (column.type === "date") {
        return `<input class="b3-text-field pz-matrix-cell" type="date" value="${escapeHtml(String(value ?? ""))}" data-row="${row.id}" data-column="${column.id}" />`;
    }
    return `<input class="b3-text-field pz-matrix-cell" value="${escapeHtml(String(value ?? ""))}" data-row="${row.id}" data-column="${column.id}" />`;
}

export function openMatrix(host: PluginHost): Dialog {
    let project = ensureProject(host);
    const dialog = new Dialog({
        title: "文献矩阵",
        width: "1200px",
        content: `<div class="b3-dialog__content pz-matrix-dialog">
  <div class="pz-matrix-toolbar">
    <select class="b3-select" data-role="matrix-project"></select>
    <button class="b3-button b3-button--outline" data-act="matrix-new-project">新建项目</button>
    <select class="b3-select" data-role="matrix-collection"></select>
    <button class="b3-button b3-button--outline" data-act="matrix-import">从 Collection 导入</button>
    <button class="b3-button b3-button--outline" data-act="matrix-add-column">添加列</button>
    <select class="b3-select" data-role="matrix-batch-column"></select>
    <input class="b3-text-field" data-role="matrix-batch-value" placeholder="批量值" style="width:110px" />
    <button class="b3-button b3-button--outline" data-act="matrix-batch-apply">批量设置</button>
    <button class="b3-button b3-button--outline" data-act="matrix-ai">AI 填充选中</button>
    <select class="b3-select" data-role="matrix-sort-column"></select>
    <select class="b3-select" data-role="matrix-sort-direction"><option value="asc">升序</option><option value="desc">降序</option></select>
    <select class="b3-select" data-role="matrix-group-column"></select>
    <select class="b3-select" data-role="matrix-view"></select>
    <button class="b3-button b3-button--outline" data-act="matrix-save-view">保存视图</button>
    <button class="b3-button b3-button--outline" data-act="matrix-rename-view">重命名视图</button>
    <button class="b3-button b3-button--outline" data-act="matrix-delete-view">删除视图</button>
    <input class="b3-text-field" data-role="matrix-filter" placeholder="筛选矩阵…" />
    <button class="b3-button b3-button--outline" data-act="matrix-export-csv">导出 CSV</button>
    <button class="b3-button b3-button--outline" data-act="matrix-export-siyuan">导出 SiYuan 表格</button>
  </div>
  <div class="pz-muted" data-role="matrix-status" style="margin-bottom:6px"></div>
  <div class="pz-matrix-scroll"><table class="pz-matrix-table"><thead data-role="matrix-head"></thead><tbody data-role="matrix-body"></tbody></table></div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="matrix-close">关闭</button></div>`,
    });
    const projectSelect = dialog.element.querySelector<HTMLSelectElement>('[data-role="matrix-project"]')!;
    const collectionSelect = dialog.element.querySelector<HTMLSelectElement>('[data-role="matrix-collection"]')!;
    const filter = dialog.element.querySelector<HTMLInputElement>('[data-role="matrix-filter"]')!;
    const head = dialog.element.querySelector<HTMLElement>('[data-role="matrix-head"]')!;
    const body = dialog.element.querySelector<HTMLElement>('[data-role="matrix-body"]')!;
    const status = dialog.element.querySelector<HTMLElement>('[data-role="matrix-status"]')!;
    const sortColumn = dialog.element.querySelector<HTMLSelectElement>('[data-role="matrix-sort-column"]')!;
    const sortDirection = dialog.element.querySelector<HTMLSelectElement>('[data-role="matrix-sort-direction"]')!;
    const viewSelect = dialog.element.querySelector<HTMLSelectElement>('[data-role="matrix-view"]')!;
    const groupColumn = dialog.element.querySelector<HTMLSelectElement>('[data-role="matrix-group-column"]')!;
    const batchColumn = dialog.element.querySelector<HTMLSelectElement>('[data-role="matrix-batch-column"]')!;
    const batchValue = dialog.element.querySelector<HTMLInputElement>('[data-role="matrix-batch-value"]')!;
    const collections = host.store.state.zotero.collections || [];
    project.views = project.views || [];
    let currentSortColumn = "";
    let currentSortDirection: "asc" | "desc" = "asc";
    let currentGroupColumn = "";
    const selectedRows = new Set<string>();
    const renderSortOptions = () => {
        sortColumn.innerHTML = `<option value="">不排序</option>` + project.columns.filter(column => column.visible).map(column => `<option value="${escapeHtml(column.id)}" ${currentSortColumn === column.id ? "selected" : ""}>${escapeHtml(column.name)}</option>`).join("");
        sortDirection.value = currentSortDirection;
        groupColumn.innerHTML = `<option value="">不分组</option>` + project.columns.filter(column => column.visible).map(column => `<option value="${escapeHtml(column.id)}" ${currentGroupColumn === column.id ? "selected" : ""}>按 ${escapeHtml(column.name)} 分组</option>`).join("");
        batchColumn.innerHTML = project.columns.filter(column => !column.system).map(column => `<option value="${escapeHtml(column.id)}">${escapeHtml(column.name)}</option>`).join("");
        viewSelect.innerHTML = `<option value="">当前视图</option>` + project.views.map(view => `<option value="${escapeHtml(view.id)}">${escapeHtml(view.name)}</option>`).join("");
    };
    const renderProjects = () => {
        projectSelect.innerHTML = host.store.state.matrixProjects.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === project.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
        collectionSelect.innerHTML = `<option value="">选择 Collection…</option>` + collections.map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`).join("");
    };
    const filteredRows = (): MatrixRow[] => {
        const query = filter.value.trim().toLowerCase();
        let rows = query ? project.rows.filter(row => [Object.values(row.values).join(" "), row.itemKey].join(" ").toLowerCase().includes(query)) : [...project.rows];
        if (currentSortColumn) {
            const column = project.columns.find(item => item.id === currentSortColumn);
            rows.sort((a, b) => {
                const av = a.values[currentSortColumn];
                const bv = b.values[currentSortColumn];
                let result = 0;
                if (column?.type === "number" || column?.type === "rating") {
                    result = (Number(av) || 0) - (Number(bv) || 0);
                } else {
                    result = String(av ?? "").localeCompare(String(bv ?? ""), "zh-CN");
                }
                return currentSortDirection === "desc" ? -result : result;
            });
        }
        return rows;
    };
    const renderTable = () => {
        const columns = project.columns.filter(column => column.visible);
        head.innerHTML = `<tr><th class="pz-matrix-index"><input type="checkbox" data-role="matrix-select-all" /></th><th class="pz-matrix-index">#</th>${columns.map(column => `<th style="min-width:${column.width || 120}px">${escapeHtml(column.name)}</th>`).join("")}<th>操作</th></tr>`;
        const rows = filteredRows();
        const rowHtml = (row: MatrixRow, index: number) => `<tr data-row-id="${row.id}"><td class="pz-matrix-index"><input type="checkbox" data-act="matrix-select-row" data-row-id="${row.id}" ${selectedRows.has(row.id) ? "checked" : ""} /></td><td class="pz-matrix-index">${index + 1}</td>${columns.map(column => `<td>${cellInput(project, row, column)}</td>`).join("")}<td><button class="pz-matrix-detail" data-act="matrix-open-detail" data-row-id="${row.id}" title="查看/编辑文献详情">详情</button> <button class="pz-matrix-note" data-act="matrix-open-note" data-row-id="${row.id}" title="创建/打开文献笔记">笔记</button> <button class="pz-matrix-delete" data-act="matrix-delete-row" data-row-id="${row.id}" title="删除行">×</button></td></tr>`;
        if (rows.length && currentGroupColumn) {
            const groups = new Map<string, MatrixRow[]>();
            for (const row of rows) {
                const key = String(row.values[currentGroupColumn] ?? "") || "未分组";
                groups.set(key, [...(groups.get(key) || []), row]);
            }
            body.innerHTML = Array.from(groups.entries()).map(([key, groupRows]) => `<tr class="pz-matrix-group-row"><td colspan="${columns.length + 3}">${escapeHtml(key)} <span class="pz-muted">${groupRows.length} 篇</span></td></tr>` + groupRows.map((row, index) => rowHtml(row, index)).join("")).join("");
        } else {
            body.innerHTML = rows.length ? rows.map((row, index) => rowHtml(row, index)).join("") : `<tr><td colspan="${columns.length + 2}" class="pz-muted">还没有文献，先从一个 Collection 导入。</td></tr>`;
        }
        status.textContent = `${project.name} · ${project.rows.length} 篇 · ${columns.length} 列`;
        for (const input of Array.from(body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(".pz-matrix-cell"))) {
            input.addEventListener("change", () => {
                const row = project.rows.find(item => item.id === input.dataset.row);
                if (!row) return;
                row.values[input.dataset.column || ""] = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
                project.updatedAt = Date.now();
                void host.store.save();
            });
        }
        for (const button of Array.from(body.querySelectorAll<HTMLElement>('[data-act="matrix-open-detail"]'))) {
            button.addEventListener("click", () => {
                const row = project.rows.find(item => item.id === button.dataset.rowId);
                if (row) openMatrixRow(host, project, row);
            });
        }
        for (const button of Array.from(body.querySelectorAll<HTMLElement>('[data-act="matrix-open-note"]'))) {
            button.addEventListener("click", async () => {
                const row = project.rows.find(item => item.id === button.dataset.rowId);
                if (!row) return;
                if (row.noteDocId) {
                    host.openDoc(row.noteDocId);
                    return;
                }
                const docId = await createNoteFromTemplate(host, row.itemKey);
                if (docId) {
                    row.noteDocId = docId;
                    project.updatedAt = Date.now();
                    await host.store.save();
                    renderTable();
                }
            });
        }
        for (const button of Array.from(body.querySelectorAll<HTMLElement>('[data-act="matrix-delete-row"]'))) {
            button.addEventListener("click", () => {
                project.rows = project.rows.filter(row => row.id !== button.dataset.rowId);
                project.updatedAt = Date.now();
                void host.store.save();
                renderTable();
            });
        }
    };
    renderProjects();
    renderSortOptions();
    renderTable();
    projectSelect.addEventListener("change", () => {
        project = host.store.state.matrixProjects.find(item => item.id === projectSelect.value) || project;
        host.store.state.matrixActiveProjectId = project.id;
        void host.store.save();
        renderSortOptions();
        renderTable();
    });
    filter.addEventListener("input", renderTable);
    sortColumn.addEventListener("change", () => { currentSortColumn = sortColumn.value; renderTable(); });
    sortDirection.addEventListener("change", () => { currentSortDirection = sortDirection.value === "desc" ? "desc" : "asc"; renderTable(); });
    groupColumn.addEventListener("change", () => { currentGroupColumn = groupColumn.value; renderTable(); });
    viewSelect.addEventListener("change", () => {
        const view = project.views.find(item => item.id === viewSelect.value);
        if (!view) return;
        filter.value = view.filter;
        currentSortColumn = view.sortColumn;
        currentSortDirection = view.sortDirection;
        currentGroupColumn = view.groupColumn || "";
        renderSortOptions();
        renderTable();
    });
    dialog.element.querySelector('[data-act="matrix-rename-view"]')?.addEventListener("click", async () => {
        const view = project.views.find(item => item.id === viewSelect.value);
        if (!view) {
            showMessage("请先选择一个已保存视图", 2500);
            return;
        }
        const name = window.prompt("视图名称", view.name);
        if (!name?.trim()) return;
        view.name = name.trim();
        project.updatedAt = Date.now();
        await host.store.save();
        renderSortOptions();
        showMessage("已重命名视图", 2000);
    });
    dialog.element.querySelector('[data-act="matrix-delete-view"]')?.addEventListener("click", async () => {
        const view = project.views.find(item => item.id === viewSelect.value);
        if (!view) {
            showMessage("请先选择一个已保存视图", 2500);
            return;
        }
        project.views = project.views.filter(item => item.id !== view.id);
        project.updatedAt = Date.now();
        await host.store.save();
        renderSortOptions();
        showMessage("已删除视图", 2000);
    });
    dialog.element.querySelector('[data-act="matrix-save-view"]')?.addEventListener("click", () => {
        const name = window.prompt("视图名称", "我的视图");
        if (!name?.trim()) return;
        project.views.push({id: newId("mxview"), name: name.trim(), filter: filter.value, sortColumn: currentSortColumn, sortDirection: currentSortDirection, groupColumn: currentGroupColumn});
        project.updatedAt = Date.now();
        void host.store.save();
        renderSortOptions();
    });
    body.addEventListener("change", event => {
        const target = event.target as HTMLInputElement | null;
        if (!target) return;
        if (target.matches('[data-act="matrix-select-row"]')) {
            const rowId = target.dataset.rowId || "";
            if (target.checked) selectedRows.add(rowId);
            else selectedRows.delete(rowId);
        }
        if (target.matches('[data-role="matrix-select-all"]')) {
            for (const row of filteredRows()) {
                if (target.checked) selectedRows.add(row.id);
                else selectedRows.delete(row.id);
            }
            renderTable();
        }
    });
    dialog.element.querySelector('[data-act="matrix-batch-apply"]')?.addEventListener("click", async () => {
        const column = batchColumn.value;
        if (!column) {
            showMessage("请选择要批量设置的列", 2500);
            return;
        }
        if (!selectedRows.size) {
            showMessage("请先勾选要批量编辑的行", 2500);
            return;
        }
        for (const row of project.rows) {
            if (selectedRows.has(row.id)) row.values[column] = batchValue.value;
        }
        project.updatedAt = Date.now();
        await host.store.save();
        renderTable();
        showMessage(`已批量设置 ${selectedRows.size} 行`, 2500);
    });
    dialog.element.querySelector('[data-act="matrix-ai"]')?.addEventListener("click", () => {
        if (!selectedRows.size) {
            showMessage("请先勾选要填充的行", 2500);
            return;
        }
        openMatrixAI(host, project, selectedRows);
    });
    dialog.element.querySelector('[data-act="matrix-new-project"]')?.addEventListener("click", () => {
        const name = window.prompt("项目名称", "新的研究项目");
        if (!name?.trim()) return;
        const next = createMatrixProject(name);
        host.store.state.matrixProjects.push(next);
        host.store.state.matrixActiveProjectId = next.id;
        project = next;
        void host.store.save();
        renderProjects();
        renderTable();
    });
    dialog.element.querySelector('[data-act="matrix-import"]')?.addEventListener("click", () => {
        const collectionKey = collectionSelect.value;
        if (!collectionKey) {
            showMessage("请先选择 Collection", 2500);
            return;
        }
        const items = (host.store.state.zotero.items || []).filter(item => (item.collections || []).includes(collectionKey));
        const existing = new Set(project.rows.map(row => row.itemKey));
        let added = 0;
        for (const item of items) {
            if (existing.has(item.key)) continue;
            project.rows.push(rowForZoteroItem(item, host.store.state.zotero.libraryId || 0));
            existing.add(item.key);
            added++;
        }
        if (!project.collectionKeys.includes(collectionKey)) project.collectionKeys.push(collectionKey);
        project.updatedAt = Date.now();
        void host.store.save();
        renderSortOptions();
        renderTable();
        showMessage(`已加入 ${added} 篇文献`, 2500);
    });
    dialog.element.querySelector('[data-act="matrix-add-column"]')?.addEventListener("click", () => {
        const name = window.prompt("列名", "");
        if (!name?.trim()) return;
        const typeRaw = window.prompt("列类型：text / longtext / number / rating / select / checkbox / date", "text") || "text";
        const allowed = ["text", "longtext", "number", "rating", "select", "checkbox", "date"];
        const type = allowed.includes(typeRaw.trim()) ? typeRaw.trim() as MatrixColumn["type"] : "text";
        const options = type === "select" ? (window.prompt("选项，用逗号分隔", "") || "").split(",").map(item => item.trim()).filter(Boolean) : undefined;
        const column: MatrixColumn = {
            id: newId("mxcol"),
            name: name.trim(),
            type,
            options,
            visible: true,
            system: false,
            source: "custom",
            width: type === "longtext" ? 220 : 140,
        };
        project.columns.push(column);
        project.updatedAt = Date.now();
        void host.store.save();
        renderSortOptions();
        renderTable();
    });
    dialog.element.querySelector('[data-act="matrix-export-csv"]')?.addEventListener("click", () => {
        const columns = project.columns.filter(column => column.visible);
        const header = columns.map(column => column.name);
        const lines = [header, ...project.rows.map(row => columns.map(column => String(row.values[column.id] ?? "")))];
        const csv = lines.map(line => line.map(value => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n");
        downloadText(`${project.name}.csv`, csv);
    });
    dialog.element.querySelector('[data-act="matrix-export-siyuan"]')?.addEventListener("click", async () => {
        const editor = getActiveEditor() || getAllEditor()[0];
        const notebookId = String(editor?.protyle?.notebookId || "");
        if (!notebookId) {
            showMessage("请先打开一个思源文档，以确定导出笔记本", 3000, "error");
            return;
        }
        const columns = project.columns.filter(column => column.visible);
        const escapeCell = (value: unknown) => String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
        const lines = [
            `| ${columns.map(column => escapeCell(column.name)).join(" | ")} |`,
            `| ${columns.map(() => "---").join(" | ")} |`,
            ...project.rows.map(row => `| ${columns.map(column => escapeCell(row.values[column.id])).join(" | ")} |`),
        ];
        const safeName = project.name.replace(/[\\/:*?"<>|]/g, "_");
        const path = `/${safeName}-${new Date().toISOString().slice(0, 10)}-矩阵`;
        const docId = await createDocWithMd(notebookId, path, lines.join("\n"));
        if (docId) showMessage(`已导出 SiYuan 表格：${safeName}`, 4000);
        else showMessage("导出 SiYuan 表格失败", 4000, "error");
    });
    dialog.element.querySelector('[data-act="matrix-close"]')?.addEventListener("click", () => dialog.destroy());
    return dialog;
}
