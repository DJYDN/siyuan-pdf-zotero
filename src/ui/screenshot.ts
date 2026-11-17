export interface ScreenshotCapture {
    blob: Blob;
    page: number;
    width: number;
    height: number;
    /** Normalized rectangle on the page, for PDF++-style backlink metadata. */
    rect?: {x: number; y: number; w: number; h: number};
}

export class ScreenshotTool {
    private active = false;
    private dragging = false;
    private start = {x: 0, y: 0};
    private pageElement: HTMLElement | null = null;
    private box: HTMLElement | null = null;

    constructor(
        private readonly pagesElement: HTMLElement,
        private readonly onCapture: (capture: ScreenshotCapture) => void,
    ) {
    }

    setActive(active: boolean): void {
        this.active = active;
        this.pagesElement.classList.toggle("pz-shot-mode", active);
        document.body.classList.toggle("pz-shot-cursor", active);
        if (!active) {
            this.cleanup();
        }
    }

    isActive(): boolean {
        return this.active;
    }

    destroy(): void {
        this.setActive(false);
    }

    private readonly onMouseDown = (event: MouseEvent) => {
        if (!this.active || event.button !== 0) {
            return;
        }
        const page = (event.target as HTMLElement).closest<HTMLElement>(".pz-page");
        if (!page) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.dragging = true;
        this.pageElement = page;
        const rect = page.getBoundingClientRect();
        this.start = {x: event.clientX - rect.left, y: event.clientY - rect.top};
        this.box = document.createElement("div");
        this.box.className = "pz-shot-box";
        page.append(this.box);
        document.addEventListener("mousemove", this.onMouseMove);
        document.addEventListener("mouseup", this.onMouseUp);
    };

    private readonly onMouseMove = (event: MouseEvent) => {
        if (!this.dragging || !this.pageElement || !this.box) {
            return;
        }
        const rect = this.pageElement.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
        const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
        const left = Math.min(x, this.start.x);
        const top = Math.min(y, this.start.y);
        const width = Math.abs(x - this.start.x);
        const height = Math.abs(y - this.start.y);
        this.box.style.left = `${left}px`;
        this.box.style.top = `${top}px`;
        this.box.style.width = `${width}px`;
        this.box.style.height = `${height}px`;
    };

    private readonly onMouseUp = () => {
        if (!this.dragging || !this.pageElement || !this.box) {
            this.cleanup();
            return;
        }
        const page = this.pageElement;
        const boxRect = this.box.getBoundingClientRect();
        const pageRect = page.getBoundingClientRect();
        const left = boxRect.left - pageRect.left;
        const top = boxRect.top - pageRect.top;
        const width = boxRect.width;
        const height = boxRect.height;
        this.cleanup();
        if (width < 8 || height < 8) {
            return;
        }
        const canvas = page.querySelector<HTMLCanvasElement>("canvas.pz-canvas");
        if (!canvas) {
            return;
        }
        const scaleX = canvas.width / page.clientWidth;
        const scaleY = canvas.height / page.clientHeight;
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(width * scaleX));
        out.height = Math.max(1, Math.round(height * scaleY));
        const context = out.getContext("2d");
        if (!context) {
            return;
        }
        context.drawImage(
            canvas,
            left * scaleX,
            top * scaleY,
            width * scaleX,
            height * scaleY,
            0,
            0,
            out.width,
            out.height,
        );
        const pageNumber = Number.parseInt(page.dataset.page || "1", 10);
        out.toBlob(blob => {
            if (blob) {
                this.onCapture({
                    blob,
                    page: pageNumber,
                    width: out.width,
                    height: out.height,
                    rect: {
                        x: left / pageRect.width,
                        y: top / pageRect.height,
                        w: width / pageRect.width,
                        h: height / pageRect.height,
                    },
                });
            }
        }, "image/png");
    };

    private cleanup(): void {
        this.dragging = false;
        this.pageElement = null;
        this.box?.remove();
        this.box = null;
        document.removeEventListener("mousemove", this.onMouseMove);
        document.removeEventListener("mouseup", this.onMouseUp);
    }

    bind(): void {
        this.pagesElement.addEventListener("mousedown", this.onMouseDown, true);
    }
}
