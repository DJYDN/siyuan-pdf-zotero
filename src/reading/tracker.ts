/**
 * Dwell-time tracker for the PDF reader.
 *
 * Style only measures reading that happens inside Zotero; this plugin measures
 * reading inside SiYuan, so the numbers are complementary rather than copied.
 *
 * Rules:
 * - one tick per `intervalSeconds`, each tick credits exactly that many seconds
 *   to the current page;
 * - ticks stop when the reader is hidden, the window loses focus, or the user
 *   has not interacted for `idleSeconds` (walked away);
 * - state is flushed through `onPersist` on a slower cadence to keep disk writes
 *   off the scroll path.
 */
export interface ReadingTrackerOptions {
    /** Seconds credited per tick. */
    intervalSeconds?: number;
    /** Stop counting after this many seconds without interaction. */
    idleSeconds?: number;
    /** How often `onPersist` is called while reading. */
    persistSeconds?: number;
    getPage(): number;
    getPages(): number;
    /** False when the tab is hidden, the window is blurred, or the element collapsed. */
    isActive(): boolean;
    onChange(page: number, pages: number, seconds: number): void;
    onPersist?(): void;
}

export class ReadingTracker {
    private timer: number | undefined;
    private persistTimer: number | undefined;
    private running = false;
    private lastActivityAt = 0;

    constructor(private readonly options: ReadingTrackerOptions) {
    }

    get isRunning(): boolean {
        return this.running;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.lastActivityAt = Date.now();
        const interval = Math.max(1, this.options.intervalSeconds ?? 10);
        const persist = Math.max(interval, this.options.persistSeconds ?? 60);
        this.timer = globalThis.setInterval(() => this.tick(), interval * 1000) as unknown as number;
        this.persistTimer = globalThis.setInterval(() => this.persist(), persist * 1000) as unknown as number;
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        if (this.timer !== undefined) globalThis.clearInterval(this.timer as any);
        if (this.persistTimer !== undefined) globalThis.clearInterval(this.persistTimer as any);
        this.timer = undefined;
        this.persistTimer = undefined;
        this.persist();
    }

    /** Called on scroll, page jump, click and pointer movement. */
    markActivity(now = Date.now()): void {
        this.lastActivityAt = now;
    }

    /** One accounting step. Exposed for tests; the interval calls it. */
    tick(now = Date.now()): boolean {
        if (!this.running) return false;
        if (!this.options.isActive()) return false;
        const idleMs = Math.max(10, this.options.idleSeconds ?? 120) * 1000;
        if (now - this.lastActivityAt > idleMs) return false;
        const page = Math.floor(Number(this.options.getPage()));
        const pages = Math.floor(Number(this.options.getPages()));
        if (!Number.isFinite(page) || page < 1 || !Number.isFinite(pages) || pages < 1) return false;
        this.options.onChange(page, pages, Math.max(1, this.options.intervalSeconds ?? 10));
        return true;
    }

    private persist(): void {
        try {
            this.options.onPersist?.();
        } catch {
            // Persisting must never break reading.
        }
    }
}
