export interface RectSelection {
    page: number;
    /** Normalized, top-left origin. */
    rect: {x: number; y: number; w: number; h: number};
    /** Rendered crop of the selection, used to embed the region in a note. */
    blob?: Blob;
}

/** Drag a rectangle on a PDF page; used by PDF++-style "embed rectangular selection". */
export class RectSelectTool {
    private active = false;
    private dragging = false;
    private start = {x: 0, y: 0};
    private pageElement: HTMLElement | null = null;
    private box: HTMLElement | null = null;

    constructor(
        private readonly pagesElement: HTMLElement,
        private readonly onSelect: (selection: RectSelection) => void,
    ) {
    }

    setActive(active: boolean): void {
        this.active = active;
        this.pagesElement.classList.toggle("pz-rect-mode", active);
        document.body.classList.toggle("pz-rect-cursor", active);
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
        this.box.style.left = `${Math.min(x, this.start.x)}px`;
        this.box.style.top = `${Math.min(y, this.start.y)}px`;
        this.box.style.width = `${Math.abs(x - this.start.x)}px`;
        this.box.style.height = `${Math.abs(y - this.start.y)}px`;
    };

    private readonly onMouseUp = async () => {
        if (!this.dragging || !this.pageElement || !this.box) {
            this.cleanup();
            return;
        }
        const page = this.pageElement;
        const pageRect = page.getBoundingClientRect();
        const boxRect = this.box.getBoundingClientRect();
        const left = boxRect.left - pageRect.left;
        const top = boxRect.top - pageRect.top;
        const width = boxRect.width;
        const height = boxRect.height;
        const pageNumber = Number.parseInt(page.dataset.page || "1", 10);
        let blob: Blob | undefined;
        const canvas = page.querySelector<HTMLCanvasElement>("canvas.pz-canvas");
        if (canvas && width >= 8 && height >= 8) {
            const scaleX = canvas.width / page.clientWidth;
            const scaleY = canvas.height / page.clientHeight;
            const out = document.createElement("canvas");
            out.width = Math.max(1, Math.round(width * scaleX));
            out.height = Math.max(1, Math.round(height * scaleY));
            const context = out.getContext("2d");
            if (context) {
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
                blob = await new Promise<Blob | undefined>(resolve => {
                    out.toBlob(value => resolve(value || undefined), "image/png");
                });
            }
        }
        this.cleanup();
        this.setActive(false);
        if (width < 8 || height < 8 || !pageRect.width || !pageRect.height) {
            return;
        }
        this.onSelect({
            page: pageNumber,
            rect: {
                x: left / pageRect.width,
                y: top / pageRect.height,
                w: width / pageRect.width,
                h: height / pageRect.height,
            },
            blob,
        });
    };

    private cleanup(): void {
        this.dragging = false;
        this.pageElement = null;
        this.box?.remove();
        this.box = null;
        document.removeEventListener("mousemove", this.onMouseMove);
        document.removeEventListener("mouseup", this.onMouseUp);
    }

    private readonly onKeyDown = (event: KeyboardEvent) => {
        if (!this.active || event.key !== "Escape") {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.cleanup();
        this.setActive(false);
    };

    bind(): void {
        this.pagesElement.addEventListener("mousedown", this.onMouseDown, true);
        this.pagesElement.ownerDocument.addEventListener("keydown", this.onKeyDown, true);
    }
}
