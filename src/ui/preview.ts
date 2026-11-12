import type {PdfDocument} from "../pdf/pdfjs";
import {requireNode} from "../runtime";

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch] as string));
}

export class PreviewManager {
    private element: HTMLElement | null = null;
    private timer: any = 0;
    private token = 0;
    private cache = new Map<string, string>();

    showHtml(html: string, anchor: DOMRect, delay = 260): void {
        this.schedule(delay, () => this.render(html, anchor));
    }

    showPage(
        pdf: PdfDocument,
        pageNumber: number,
        anchor: DOMRect,
        title = "",
        delay = 260,
    ): void {
        this.schedule(delay, async () => {
            const token = ++this.token;
            this.ensureElement();
            this.render(`<div class="pz-preview-title">第 ${pageNumber} 页${title ? ` · ${escapeHtml(title)}` : ""}</div><div class="pz-preview-loading">正在生成预览…</div>`, anchor);
            let dataUrl = this.cache.get(String(pageNumber));
            if (!dataUrl) {
                try {
                    const page = await pdf.getPage(pageNumber);
                    const viewport = page.getViewport({scale: 0.34});
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.max(1, Math.floor(viewport.width));
                    canvas.height = Math.max(1, Math.floor(viewport.height));
                    const context = canvas.getContext("2d");
                    if (!context) {
                        return;
                    }
                    await page.render({canvas, canvasContext: context, viewport}).promise;
                    dataUrl = canvas.toDataURL("image/png");
                    this.cache.set(String(pageNumber), dataUrl);
                } catch {
                    return;
                }
            }
            if (token !== this.token || !this.element) {
                return;
            }
            this.render(`<div class="pz-preview-title">第 ${pageNumber} 页${title ? ` · ${escapeHtml(title)}` : ""}</div><img class="pz-preview-page" src="${dataUrl}" alt="page ${pageNumber}" />`, anchor);
        });
    }

    /** Show a compact annotation card; used by PDF highlights and note links. */
    showAnnotation(options: {
        text: string;
        page: number;
        bookTitle?: string;
        noteCount?: number;
        anchor: DOMRect;
    }, delay = 220): void {
        const notes = options.noteCount ? `<div class="pz-preview-meta">${options.noteCount} 条关联笔记</div>` : "";
        this.showHtml(`
<div class="pz-preview-title">${escapeHtml(options.bookTitle || "PDF 标注")} · 第 ${options.page} 页</div>
<div class="pz-preview-text">${escapeHtml(options.text.slice(0, 360))}</div>
${notes}`, options.anchor, delay);
    }

    isVisible(): boolean {
        return Boolean(this.element && this.element.style.display !== "none");
    }

    hide(): void {
        this.clearTimer();
        this.timer = 0;
        ++this.token;
        this.element?.remove();
        this.element = null;
    }

    private schedule(delay: number, action: () => void | Promise<void>): void {
        this.clearTimer();
        const schedule = requireNode("timers")?.setTimeout || globalThis.setTimeout;
        this.timer = schedule(() => {
            this.timer = 0;
            void action();
        }, delay);
    }

    private clearTimer(): void {
        if (!this.timer) {
            return;
        }
        const clear = requireNode("timers")?.clearTimeout || globalThis.clearTimeout;
        clear(this.timer);
    }

    private ensureElement(): void {
        if (this.element) {
            return;
        }
        const element = document.createElement("div");
        element.className = "pz-preview";
        document.body.append(element);
        this.element = element;
    }

    private render(html: string, anchor: DOMRect): void {
        this.ensureElement();
        if (!this.element) {
            return;
        }
        this.element.innerHTML = html;
        this.element.style.display = "block";
        const width = this.element.offsetWidth || 280;
        const height = this.element.offsetHeight || 180;
        let left = anchor.right + 12;
        if (left + width > window.innerWidth - 8) {
            left = anchor.left - width - 12;
        }
        let top = anchor.top;
        if (top + height > window.innerHeight - 8) {
            top = window.innerHeight - height - 8;
        }
        this.element.style.left = `${Math.max(8, left)}px`;
        this.element.style.top = `${Math.max(8, top)}px`;
    }
}
