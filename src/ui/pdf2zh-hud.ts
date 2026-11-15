export class Pdf2zhHud {
    private readonly root: HTMLElement;
    private readonly ring: HTMLElement;
    private readonly label: HTMLElement;
    private readonly panel: HTMLElement;
    private readonly title: HTMLElement;
    private readonly detail: HTMLElement;
    private readonly logElement: HTMLElement;
    private readonly logs: string[] = [];
    private hideTimer = 0;
    private destroyed = false;
    private cancelled = false;
    private readonly provider: string;
    private readonly isOcr: boolean;
    private readonly onCancel?: () => void;
    private readonly onEscape = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || this.destroyed) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.cancelled = true;
        this.onCancel?.();
        this.destroy();
    };
    private readonly onOutsidePointerDown = (event: PointerEvent): void => {
        if (this.panel.hidden) return;
        if (this.root.contains(event.target as Node)) return;
        this.panel.hidden = true;
    };

    constructor(provider = "PDF2zh", options: {onCancel?: () => void} = {}) {
        this.provider = provider;
        this.isOcr = provider === "OCR";
        this.onCancel = options.onCancel;
        this.root = document.createElement("div");
        this.root.className = "pz-pdf2zh-hud";
        this.root.dataset.state = "running";
        this.root.innerHTML = `
  <button class="pz-pdf2zh-ring" type="button" title="${this.isOcr ? "点击查看 OCR 进度" : "点击查看 PDF2zh 详细进度"}">
    <span data-role="label">0%</span>
  </button>
  <div class="pz-pdf2zh-panel" hidden>
    <div class="pz-pdf2zh-panel-head">
      <strong data-role="title">${this.isOcr ? "OCR 识别" : `${provider} 整篇翻译`}</strong>
      <button data-role="close" type="button" title="关闭">×</button>
    </div>
    <div class="pz-pdf2zh-panel-status" data-role="detail">准备中…</div>
    <div class="pz-pdf2zh-panel-log" data-role="log"></div>
  </div>`;
        this.ring = this.root.querySelector<HTMLElement>(".pz-pdf2zh-ring")!;
        this.label = this.root.querySelector<HTMLElement>('[data-role="label"]')!;
        this.panel = this.root.querySelector<HTMLElement>(".pz-pdf2zh-panel")!;
        this.title = this.root.querySelector<HTMLElement>('[data-role="title"]')!;
        this.detail = this.root.querySelector<HTMLElement>('[data-role="detail"]')!;
        this.logElement = this.root.querySelector<HTMLElement>('[data-role="log"]')!;
        this.ring.addEventListener("click", event => {
            event.stopPropagation();
            this.panel.hidden = !this.panel.hidden;
        });
        // Clicking anywhere outside the HUD closes the detail panel; clicking
        // the ring again also toggles it closed.
        document.addEventListener("pointerdown", this.onOutsidePointerDown, {capture: true});
        this.root.querySelector('[data-role="close"]')?.addEventListener("click", event => {
            event.stopPropagation();
            this.destroy();
        });
        this.ring.style.setProperty("--pz-progress", "0");
        document.addEventListener("keydown", this.onEscape, true);
        document.body.append(this.root);
    }

    /** True once the user pressed Esc / closed the running progress. */
    isCancelled(): boolean {
        return this.cancelled;
    }

    setProgress(progress: number, status?: string): void {
        window.clearTimeout(this.hideTimer);
        const value = Math.max(0, Math.min(100, Math.round(progress)));
        this.ring.style.setProperty("--pz-progress", String(value));
        this.label.textContent = `${value}%`;
        this.root.classList.remove("is-indeterminate");
        if (status) this.setStatus(status);
    }

    setIndeterminate(status = "翻译中…"): void {
        window.clearTimeout(this.hideTimer);
        this.root.classList.add("is-indeterminate");
        this.label.textContent = "…";
        this.setStatus(status);
    }

    setStatus(status: string): void {
        this.detail.textContent = status;
        this.logs.push(`${new Date().toLocaleTimeString()}  ${status}`);
        if (this.logs.length > 40) this.logs.shift();
        this.logElement.textContent = this.logs.join("\n");
        this.logElement.scrollTop = this.logElement.scrollHeight;
    }

    addLog(line: string): void {
        const value = String(line || "").trim();
        if (!value) return;
        this.logs.push(`${new Date().toLocaleTimeString()}  ${value}`);
        if (this.logs.length > 80) this.logs.shift();
        this.logElement.textContent = this.logs.join("\n");
        this.logElement.scrollTop = this.logElement.scrollHeight;
    }

    setWaiting(seconds: number): void {
        this.detail.textContent = `${this.provider} 正在翻译中… 已等待 ${seconds} 秒（页数较多时可能需要数分钟）`;
    }

    complete(message = "翻译完成"): void {
        this.root.dataset.state = "success";
        this.root.classList.remove("is-indeterminate");
        this.setProgress(100, message);
        this.title.textContent = this.isOcr ? "OCR 识别完成" : `${this.provider} 翻译完成`;
        this.hideTimer = window.setTimeout(() => this.destroy(), 1800);
    }

    fail(message: string): void {
        this.root.dataset.state = "error";
        this.root.classList.remove("is-indeterminate");
        this.label.textContent = "!";
        this.title.textContent = this.isOcr ? "OCR 识别失败" : `${this.provider} 翻译失败`;
        this.setStatus(message);
        this.panel.hidden = false;
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        window.clearTimeout(this.hideTimer);
        document.removeEventListener("pointerdown", this.onOutsidePointerDown, {capture: true});
        document.removeEventListener("keydown", this.onEscape, true);
        this.root.remove();
    }
}
