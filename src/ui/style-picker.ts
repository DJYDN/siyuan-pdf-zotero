import {Dialog} from "siyuan";
import {CITATION_STYLES} from "../citation/csl";

export const POPULAR_CITATION_STYLES = [
    "gbt7714",
    "apa",
    "ieee",
    "modern-language-association",
    "chicago-author-date",
];

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch] as string));
}

export function citationStyleLabel(id: string): string {
    return CITATION_STYLES[id]?.label || id;
}

/** Options used by native selects: five common styles plus a search entry. */
export function citationStyleOptions(current: string): string {
    const ids = [...new Set([...POPULAR_CITATION_STYLES, current].filter(Boolean))];
    return ids.map(id => `<option value="${escapeHtml(id)}" ${current === id ? "selected" : ""}>${escapeHtml(citationStyleLabel(id))}</option>`).join("")
        + `<option value="__more__">更多样式（搜索 100+ 种）…</option>`;
}

/** Searchable catalog dialog for the long tail of CSL styles. */
export function openCitationStylePicker(current: string, onSelect: (id: string) => void): Dialog {
    const dialog = new Dialog({
        title: "选择引用样式",
        width: "680px",
        content: `<div class="b3-dialog__content pz-style-picker">
  <input class="b3-text-field fn__block" data-role="style-search" placeholder="搜索样式名称，例如 APA、Nature、IEEE、GB/T…" autofocus />
  <div class="pz-style-picker-list" data-role="style-list"></div>
</div>
<div class="b3-dialog__action"><button class="b3-button b3-button--cancel" data-act="style-cancel">取消</button></div>`,
    });
    const search = dialog.element.querySelector<HTMLInputElement>('[data-role="style-search"]')!;
    const list = dialog.element.querySelector<HTMLElement>('[data-role="style-list"]')!;
    const all = Object.entries(CITATION_STYLES);
    let filtered = false;
    const render = () => {
        const query = search.value.trim().toLowerCase();
        filtered = Boolean(query);
        const popular = new Set(POPULAR_CITATION_STYLES);
        const source = all.filter(([id, meta]) => {
            if (!query) return popular.has(id) || id === current;
            return [id, meta.label, meta.title || "", meta.file].join(" ").toLowerCase().includes(query);
        });
        list.innerHTML = source.length
            ? source.map(([id, meta]) => `<button type="button" class="pz-style-option${id === current ? " is-current" : ""}" data-style-id="${escapeHtml(id)}">
  <span><strong>${escapeHtml(meta.label)}</strong><small>${escapeHtml(meta.title || id)} · ${meta.numeric ? "数字" : "作者-年份"}</small></span>
  ${id === current ? "<b>✓</b>" : ""}
</button>`).join("")
            : `<div class="pz-muted">没有匹配的样式</div>`;
        for (const button of Array.from(list.querySelectorAll<HTMLElement>("[data-style-id]"))) {
            button.addEventListener("click", () => {
                const id = button.dataset.styleId || "";
                if (!id) return;
                onSelect(id);
                dialog.destroy();
            });
        }
        if (!filtered) {
            const hint = document.createElement("div");
            hint.className = "pz-muted pz-style-picker-hint";
            hint.textContent = `默认显示 5 种常用样式；输入关键词可搜索 ${all.length} 种 CSL 样式。`;
            list.prepend(hint);
        }
    };
    search.addEventListener("input", render);
    dialog.element.querySelector('[data-act="style-cancel"]')?.addEventListener("click", () => dialog.destroy());
    render();
    requestAnimationFrame(() => search.focus());
    return dialog;
}
