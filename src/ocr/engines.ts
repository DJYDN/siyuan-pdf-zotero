import type {OcrEngineConfig, OcrEngineId, OcrEngineMap, Settings} from "../types";

/**
 * Engine registry for the local OCR sidecars.
 *
 * Each engine is a small local HTTP service (see `ocr-server/` and
 * `release/OCR-Texo-Portable/`). Engines that share one service directory are
 * served by the same process: the legacy `OCR-Service-Portable` hosts Pix2Text
 * and UniMERNet on a single port, while the standalone packages each host one
 * engine on their own port.
 */

export const OCR_ENGINE_IDS: OcrEngineId[] = ["pix2text", "unimernet", "texo"];

export interface OcrEngineCapabilities {
    formula: boolean;
    text: boolean;
    mixed: boolean;
}

export interface OcrEngineDefinition {
    id: OcrEngineId;
    name: string;
    /** Short capability label for the settings card. */
    summary: string;
    defaultPort: number;
    capabilities: OcrEngineCapabilities;
    /** Script names to look for inside the service directory, first match wins. */
    scriptCandidates: string[];
    /** Hint shown next to the directory picker. */
    dirHint: string;
    /** True when the model files live inside the engine directory (standalone package). */
    selfContained: boolean;
}

export const OCR_ENGINE_DEFS: Record<OcrEngineId, OcrEngineDefinition> = {
    pix2text: {
        id: "pix2text",
        name: "Pix2Text",
        summary: "公式 / 文本 / 混合",
        defaultPort: 8891,
        capabilities: {formula: true, text: true, mixed: true},
        scriptCandidates: ["pz_ocr_server.py", "service.py"],
        dirHint: "含 pz_ocr_server.py 与 runtime/ 的目录",
        selfContained: false,
    },
    unimernet: {
        id: "unimernet",
        name: "UniMERNet",
        summary: "仅公式",
        defaultPort: 8892,
        capabilities: {formula: true, text: false, mixed: false},
        scriptCandidates: ["service.py", "pz_ocr_server.py"],
        dirHint: "含 service.py（或旧版 pz_ocr_server.py）与模型的目录",
        selfContained: false,
    },
    texo: {
        id: "texo",
        name: "Texo",
        summary: "仅公式（20M 轻量模型）",
        defaultPort: 8893,
        capabilities: {formula: true, text: false, mixed: false},
        scriptCandidates: ["service.py"],
        dirHint: "OCR-Texo-Portable 解压目录（含 service.py 与 models/）",
        selfContained: true,
    },
};

export interface LegacyOcrSettings {
    ocrServerPath?: string;
    ocrPort?: number;
    ocrAutoStart?: boolean;
    ocrEngine?: string;
    unimernetPath?: string;
}

export function engineDefinition(id: OcrEngineId): OcrEngineDefinition {
    return OCR_ENGINE_DEFS[id];
}

export function isOcrEngineId(value: unknown): value is OcrEngineId {
    return typeof value === "string" && (OCR_ENGINE_IDS as string[]).includes(value);
}

function clampPort(value: unknown, fallback: number): number {
    const port = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return fallback;
    }
    return port;
}

function sanitizeEngineConfig(value: unknown, fallback: OcrEngineConfig): OcrEngineConfig {
    const raw = value && typeof value === "object" ? value as Partial<OcrEngineConfig> : {};
    return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
        dir: typeof raw.dir === "string" ? raw.dir.trim() : fallback.dir,
        port: clampPort(raw.port, fallback.port),
        autoStart: typeof raw.autoStart === "boolean" ? raw.autoStart : fallback.autoStart,
    };
}

/**
 * Build engine configs from the pre-0.9.58 settings model:
 * one service directory hosting Pix2Text (and optionally UniMERNet).
 */
export function legacyEngineMap(legacy: LegacyOcrSettings): OcrEngineMap {
    const serviceDir = String(legacy.ocrServerPath || "").trim();
    const servicePort = clampPort(legacy.ocrPort, OCR_ENGINE_DEFS.pix2text.defaultPort);
    const autoStart = legacy.ocrAutoStart !== false;
    const unimernetModel = String(legacy.unimernetPath || "").trim();
    const unimernetSelected = String(legacy.ocrEngine || "").trim() === "unimernet";
    return {
        pix2text: {enabled: true, dir: serviceDir, port: servicePort, autoStart},
        unimernet: {
            // Legacy packages share the Pix2Text service directory and pick the
            // engine through the request payload, so keep both cards on one dir.
            enabled: unimernetSelected && Boolean(unimernetModel || serviceDir),
            dir: serviceDir,
            port: servicePort,
            autoStart,
        },
        texo: {enabled: false, dir: "", port: OCR_ENGINE_DEFS.texo.defaultPort, autoStart: true},
    };
}

/** Sanitize persisted engine configs, falling back to the legacy layout. */
export function normalizeEngineMap(value: unknown, legacy: LegacyOcrSettings): OcrEngineMap {
    const base = legacyEngineMap(legacy);
    if (!value || typeof value !== "object") {
        return base;
    }
    const raw = value as Partial<Record<OcrEngineId, Partial<OcrEngineConfig>>>;
    const result = {} as OcrEngineMap;
    for (const id of OCR_ENGINE_IDS) {
        result[id] = sanitizeEngineConfig(raw[id], base[id]);
    }
    return result;
}

export function engineConfig(settings: Settings, id: OcrEngineId): OcrEngineConfig {
    return settings.ocrEngines?.[id] || legacyEngineMap(settings as LegacyOcrSettings)[id];
}

export function enabledEngineIds(settings: Settings): OcrEngineId[] {
    return OCR_ENGINE_IDS.filter(id => engineConfig(settings, id).enabled);
}

/** Configured formula priority, sanitized to enabled engines that can read formulas. */
export function formulaEngineOrder(settings: Settings): OcrEngineId[] {
    const configured = Array.isArray(settings.ocrFormulaOrder) ? settings.ocrFormulaOrder : [];
    const order: OcrEngineId[] = [];
    for (const id of configured) {
        if (isOcrEngineId(id) && !order.includes(id)) {
            order.push(id);
        }
    }
    for (const id of OCR_ENGINE_IDS) {
        if (!order.includes(id)) {
            order.push(id);
        }
    }
    return order.filter(id => engineConfig(settings, id).enabled && OCR_ENGINE_DEFS[id].capabilities.formula);
}

/**
 * Engines to try for a recognition mode, best first.
 *
 * - `formula`: user-configured formula priority.
 * - `text` / `auto`: the text engine, then any other engine that can read text;
 *   formula-only engines are only used as a last resort for `auto`.
 */
export function enginesForMode(settings: Settings, mode: string): OcrEngineId[] {
    const enabled = enabledEngineIds(settings);
    if (mode === "formula") {
        return formulaEngineOrder(settings);
    }
    const preferred = isOcrEngineId(settings.ocrTextEngine) ? settings.ocrTextEngine : "pix2text";
    const capableText = enabled.filter(id => OCR_ENGINE_DEFS[id].capabilities.text);
    const ordered: OcrEngineId[] = [];
    if (capableText.includes(preferred)) {
        ordered.push(preferred);
    }
    for (const id of capableText) {
        if (!ordered.includes(id)) {
            ordered.push(id);
        }
    }
    if (ordered.length) {
        return ordered;
    }
    // No text-capable engine configured: fall back to formula engines so that a
    // single-engine Texo/UniMERNet setup still produces something for "auto".
    return formulaEngineOrder(settings);
}

export function normalizeDirKey(dir: string): string {
    return String(dir || "").trim().replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}

export interface OcrServiceGroup {
    /** Normalized directory key used for grouping and diffing. */
    key: string;
    dir: string;
    port: number;
    engines: OcrEngineId[];
    autoStart: boolean;
    scriptCandidates: string[];
}

/** Group enabled engines by service directory: one directory == one process. */
export function serviceGroups(settings: Settings): OcrServiceGroup[] {
    const groups = new Map<string, OcrServiceGroup>();
    for (const id of OCR_ENGINE_IDS) {
        const config = engineConfig(settings, id);
        if (!config.enabled || !config.dir.trim()) {
            continue;
        }
        const key = normalizeDirKey(config.dir);
        const existing = groups.get(key);
        if (existing) {
            existing.engines.push(id);
            existing.autoStart = existing.autoStart || config.autoStart;
            continue;
        }
        const def = OCR_ENGINE_DEFS[id];
        groups.set(key, {
            key,
            dir: config.dir.trim(),
            port: config.port,
            engines: [id],
            autoStart: config.autoStart,
            scriptCandidates: def.scriptCandidates,
        });
    }
    return [...groups.values()];
}

export function serviceGroupForEngine(settings: Settings, id: OcrEngineId): OcrServiceGroup | undefined {
    const key = normalizeDirKey(engineConfig(settings, id).dir);
    return serviceGroups(settings).find(group => group.key === key);
}

/** True when the engine needs the legacy `options.unimernetPath` model override. */
export function needsLegacyUnimernetOptions(settings: Settings, group?: OcrServiceGroup): boolean {
    if (!group) {
        return false;
    }
    return group.engines.includes("unimernet") && !group.engines.includes("texo");
}

export function defaultFormulaOrder(): OcrEngineId[] {
    return ["texo", "unimernet", "pix2text"];
}
