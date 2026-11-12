import {requireNode} from "./runtime";

/**
 * Chromium heavily throttles renderer timers when the SiYuan window is
 * occluded. Electron's Node timer keeps acceptance tests deterministic while
 * still falling back to the browser timer in browser-desktop builds.
 */
export function e2eSleep(ms: number): Promise<void> {
    const nodeSetTimeout = requireNode("timers")?.setTimeout;
    return new Promise(resolve => {
        if (typeof nodeSetTimeout === "function") {
            nodeSetTimeout(resolve, ms);
        } else {
            globalThis.setTimeout(resolve, ms);
        }
    });
}
