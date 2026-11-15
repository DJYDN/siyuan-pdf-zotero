import {showMessage} from "siyuan";
import {getBlockKramdown, updateBlockMarkdown} from "../api";
import {extractLatexFromKramdown, formatLatex} from "../ocr/latex-format";

let menu: HTMLElement | null = null;

function closeMenu(): void {
    menu?.remove();
    menu = null;
}

function placeMenu(element: HTMLElement, x: number, y: number): void {
    const width = element.offsetWidth || 160;
    const height = element.offsetHeight || 80;
    const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
}

async function formatBlock(blockId: string): Promise<void> {
    const kramdown = await getBlockKramdown(blockId);
    const latex = extractLatexFromKramdown(kramdown);
    if (!latex) {
        throw new Error("没有从块中读到公式源码");
    }
    const formatted = formatLatex(latex);
    if (formatted === latex) {
        showMessage("公式已经是可读格式，无需调整", 2400);
        return;
    }
    await updateBlockMarkdown(blockId, `$$\n${formatted}\n$$`);
    showMessage("已格式化公式（Ctrl+Z 可撤销）", 2600);
}

async function copyBlockLatex(blockId: string): Promise<void> {
    const kramdown = await getBlockKramdown(blockId);
    const latex = extractLatexFromKramdown(kramdown);
    if (!latex) {
        throw new Error("没有从块中读到公式源码");
    }
    await navigator.clipboard.writeText(latex);
    showMessage("已复制公式 LaTeX", 1800);
}

/**
 * Adds a custom context menu to SiYuan formula blocks:
 * 「格式化公式」pretty-prints the source in place (undoable) and
 * 「复制 LaTeX」copies the raw source.
 */
export function bindFormulaFormatMenu(): () => void {
    const onContextMenu = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        const block = target.closest<HTMLElement>('[data-type="NodeMathBlock"]');
        if (!block) return;
        // Do not hijack menus opened from the block gutter / breadcrumb.
        if (target.closest(".protyle-gutters, .protyle-breadcrumb")) return;
        const blockId = block.getAttribute("data-node-id") || "";
        if (!blockId) return;

        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        const element = document.createElement("div");
        element.className = "pz-formula-format-menu";
        element.innerHTML = `<button type="button" data-act="format-formula">格式化公式</button><button type="button" data-act="copy-formula">复制 LaTeX</button>`;
        document.body.append(element);
        menu = element;
        placeMenu(element, event.clientX, event.clientY);

        const onOutside = (outsideEvent: Event): void => {
            if (menu && !menu.contains(outsideEvent.target as Node)) {
                closeMenu();
                document.removeEventListener("mousedown", onOutside, true);
                document.removeEventListener("keydown", onKey, true);
            }
        };
        const onKey = (keyEvent: KeyboardEvent): void => {
            if (keyEvent.key === "Escape") {
                closeMenu();
                document.removeEventListener("mousedown", onOutside, true);
                document.removeEventListener("keydown", onKey, true);
            }
        };
        document.addEventListener("mousedown", onOutside, true);
        document.addEventListener("keydown", onKey, true);

        element.querySelector('[data-act="format-formula"]')?.addEventListener("click", async () => {
            closeMenu();
            try {
                await formatBlock(blockId);
            } catch (error: any) {
                showMessage(`格式化失败：${error?.message || String(error)}`, 5000, "error");
            }
        });
        element.querySelector('[data-act="copy-formula"]')?.addEventListener("click", async () => {
            closeMenu();
            try {
                await copyBlockLatex(blockId);
            } catch (error: any) {
                showMessage(`复制失败：${error?.message || String(error)}`, 5000, "error");
            }
        });
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => {
        document.removeEventListener("contextmenu", onContextMenu, true);
        closeMenu();
    };
}
