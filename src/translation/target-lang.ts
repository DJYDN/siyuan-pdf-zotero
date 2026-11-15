import type {Settings} from "../types";

export type TranslationTargetScope = "selection" | "pdf2zh" | "doc2x";

const FALLBACK_TARGET = "zh-CN";

/**
 * Resolve the target language for one translation entry point.
 * A per-engine value wins; otherwise the shared default is used.
 */
export function effectiveTargetLang(settings: Settings, scope: TranslationTargetScope): string {
    const fallback = String(settings.translationDefaultTargetLang || "").trim() || FALLBACK_TARGET;
    const override = scope === "selection"
        ? settings.translationTargetLang
        : scope === "pdf2zh"
            ? settings.pdf2zhTargetLang
            : settings.doc2xTargetLang;
    const value = String(override || "").trim();
    return value || fallback;
}
