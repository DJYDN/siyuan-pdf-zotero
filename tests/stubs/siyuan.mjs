/**
 * Minimal `siyuan` module stub used by the DOM-based UI tests.
 * The plugin only needs Dialogs/messages/editor accessors at runtime; tests
 * assert on the rendered DOM instead of the real SiYuan host.
 */

export const __messages = [];

export class Dialog {
    constructor(options = {}) {
        this.options = options;
        this.element = document.createElement("div");
        this.element.className = "b3-dialog";
        this.element.dataset.testDialog = "1";
        const wrapper = document.createElement("div");
        wrapper.className = "b3-dialog__container";
        wrapper.innerHTML = String(options.content || "");
        this.element.append(wrapper);
        document.body.append(this.element);
        this.destroyed = false;
    }

    destroy() {
        this.destroyed = true;
        this.element.remove();
    }
}

export function showMessage(message, timeout = 0, type = "") {
    __messages.push({message: String(message), timeout, type});
}

export function getActiveEditor() {
    return null;
}

export function getAllEditor() {
    return [];
}

export function openTab() {
    return null;
}

export function getFrontend() {
    return "desktop";
}
