import {Dialog, showMessage} from "siyuan";
import type {PluginHost} from "../host";
import type {MatrixColumn, MatrixProject, MatrixRow} from "../types";
import {chatWithSiyuanAI} from "../automation/provider";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch] as string));
}

export function openMatrixAI(host: PluginHost, project: MatrixProject, rows: Set<string>): Dialog {
    const columns = project.columns.filter(column => !column.system && column.visible);
    const dialog = new Dialog({
        title: "矩阵 AI 填充",
        width: "620px",
        content: `<div class="b3-dialog__content">
  <p class="pz-muted">将对选中的 ${rows.size} 行，根据 Zotero 标题和摘要生成指定字段。需要先在思源中配置 AI Provider。</p>
  <label class="fn__block" style="margin-bottom:8px">目标字段
    <select class="b3-select fn__block" data-role="matrix-ai-column">${columns.map(column => `<option value="${column.id}">${column.name}</option>`).join("")}</select>
  </label>
  <label class="fn__block" style="margin-bottom:8px">额外要求（可选）
    <textarea class="b3-text-field fn__block" data-role="matrix-ai-instruction" rows="3" placeholder="例如：用中文，控制在 80 字以内"></textarea>
  </label>
  <div class="pz-muted" data-role="matrix-ai-status"></div>
  <div class="pz-matrix-ai-preview" data-role="matrix-ai-preview" style="max-height:180px;overflow:auto;font-size:11px;margin-top:8px"></div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="matrix-ai-cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--outline" data-act="matrix-ai-apply" disabled>应用结果</button><div class="fn__space"></div><button class="b3-button b3-button--text" data-act="matrix-ai-run">生成预览</button></div>`,
    });
    const columnSelect = dialog.element.querySelector<HTMLSelectElement>('[data-role="matrix-ai-column"]')!;
    const instruction = dialog.element.querySelector<HTMLTextAreaElement>('[data-role="matrix-ai-instruction"]')!;
    const status = dialog.element.querySelector<HTMLElement>('[data-role="matrix-ai-status"]')!;
    const preview = dialog.element.querySelector<HTMLElement>('[data-role="matrix-ai-preview"]')!;
    const results = new Map<string, string>();
    const apply = dialog.element.querySelector<HTMLButtonElement>('[data-act="matrix-ai-apply"]')!;
    dialog.element.querySelector('[data-act="matrix-ai-cancel"]')?.addEventListener("click", () => dialog.destroy());
    apply.addEventListener("click", async () => {
        const column = project.columns.find(item => item.id === columnSelect.value);
        if (!column) return;
        for (const row of project.rows) {
            const value = results.get(row.id);
            if (value !== undefined) row.values[column.id] = value;
        }
        project.updatedAt = Date.now();
        await host.store.save();
        showMessage(`已应用 AI 结果：${results.size} 行`, 3000);
        dialog.destroy();
    });
    dialog.element.querySelector('[data-act="matrix-ai-run"]')?.addEventListener("click", async () => {
        if (!rows.size) {
            showMessage("请先在矩阵中勾选行", 3000);
            return;
        }
        const column = project.columns.find(item => item.id === columnSelect.value);
        if (!column) {
            showMessage("请选择目标字段", 3000);
            return;
        }
        const button = dialog.element.querySelector<HTMLButtonElement>('[data-act="matrix-ai-run"]')!;
        button.disabled = true;
        let done = 0;
        let failed = 0;
        results.clear();
        preview.innerHTML = "";
        for (const row of project.rows) {
            if (!rows.has(row.id)) continue;
            const item = (host.store.state.zotero.items || []).find(entry => entry.key === row.itemKey);
            if (!item) {
                failed++;
                continue;
            }
            status.textContent = `正在处理 ${done + failed + 1}/${rows.size}：${item.title || row.itemKey}`;
            try {
                const answer = await chatWithSiyuanAI([
                    {role: "system", content: "你是严谨的学术文献分析助手。只输出目标字段的内容，不要输出解释、标题、引号或 Markdown 代码块。"},
                    {role: "user", content: `文献标题：${item.title || ""}\n摘要：${(item as any).abstract || item.csl?.abstract || ""}\n\n请填写字段「${column.name}」。${instruction.value.trim()}\n如果摘要信息不足，请写“摘要信息不足”。`},
                ], "");
                const value = String(answer || "").trim().replace(/^["“]|["”]$/g, "");
                results.set(row.id, value);
                preview.innerHTML += `<div style="padding:4px 0;border-bottom:1px solid var(--b3-border-color)"><b>${escapeHtml(String(row.values.title || row.itemKey)).slice(0, 80)}</b><br>${escapeHtml(value)}</div>`;
                done++;
            } catch (error: any) {
                failed++;
                status.textContent = `AI 调用失败：${error?.message || String(error)}`;
            }
        }
        button.disabled = false;
        apply.disabled = results.size === 0;
        status.textContent = `预览完成：成功 ${done} 行，失败 ${failed} 行；确认后点“应用结果”`;
        showMessage(`AI 预览完成：${done} 成功，${failed} 失败`, 4000);
    });
    return dialog;
}
