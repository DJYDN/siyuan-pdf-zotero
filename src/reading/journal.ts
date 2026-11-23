import {apiPost} from "../api";
import type {Settings} from "../types";

/** easyScholar open API. Same data source Zotero Style uses, but the key belongs to the user. */
const EASYSCHOLAR_ENDPOINT = "https://www.easyscholar.cc/open/getPublicationRank";

/** Short Chinese labels for the fields users actually enable. */
const FIELD_LABEL: Record<string, string> = {
    sci: "SCI",
    ssci: "SSCI",
    sciif: "IF",
    sciif5: "IF5",
    jci: "JCI",
    sciBase: "中科院基础版",
    sciUp: "中科院升级版",
    sciwarn: "预警",
    ccf: "CCF",
    cssci: "CSSCI",
    cscd: "CSCD",
    pku: "北大核心",
    zhongguokejihexin: "中国科技核心期刊",
    eii: "EI",
    ahci: "A&HCI",
    ajg: "AJG",
    ft50: "FT50",
    utd24: "UTD24",
};

export function normalizeJournalName(name: string): string {
    return String(name || "").replace(/\s+/g, " ").trim();
}

interface MapRule {
    regex: RegExp | null;
    literal: string;
    replacement: string;
}

/** Parse "SCIIF(5)=IF(5), /^SCI(\d+)$/=Q$1, SCI=" rules. */
export function parseJournalMap(map: string): MapRule[] {
    const rules: MapRule[] = [];
    for (const raw of String(map || "").split(",")) {
        const entry = raw.trim();
        if (!entry) continue;
        const index = entry.indexOf("=");
        if (index <= 0) continue;
        const left = entry.slice(0, index).trim();
        const replacement = entry.slice(index + 1).trim();
        const regexMatch = left.match(/^\/(.+)\/([a-z]*)$/);
        if (regexMatch) {
            try {
                rules.push({regex: new RegExp(regexMatch[1], regexMatch[2]), literal: "", replacement});
            } catch {
                // Ignore an invalid rule instead of failing the whole column.
            }
            continue;
        }
        rules.push({regex: null, literal: left, replacement});
    }
    return rules;
}

/**
 * Apply the user's display rules to one field.
 *
 * Returns:
 * - `null`  → no rule matched, caller uses the default label;
 * - `""`    → the rule hides this field (`SCI=`);
 * - string  → the mapped label.
 */
export function applyJournalMap(key: string, value: string, rules: MapRule[]): string | null {
    const text = value ? `${key} ${value}` : key;
    const decorated = value ? `${key}(${value})` : key;
    for (const rule of rules) {
        if (rule.regex) {
            const compact = `${key}${value}`;
            if (rule.regex.test(text)) return text.replace(rule.regex, rule.replacement).trim();
            if (rule.regex.test(compact)) return compact.replace(rule.regex, rule.replacement).trim();
            continue;
        }
        const literal = rule.literal.toUpperCase();
        if (literal !== key.toUpperCase() && literal !== decorated.toUpperCase()) continue;
        if (!rule.replacement) return "";
        if (!value) return rule.replacement;
        return rule.replacement.includes(value) ? rule.replacement : `${rule.replacement} ${value}`;
    }
    return null;
}

/**
 * One compact label line, e.g. "IF 8.2 · 中科院升级版1区 · EI".
 * `wantedFields` is the user's comma separated field list; only those are shown.
 */
export function formatJournalTags(fields: Record<string, string> | undefined, map: string, wantedFields = ""): string {
    if (!fields) return "";
    const rules = parseJournalMap(map);
    const wanted = String(wantedFields || "").split(",").map(item => item.trim()).filter(Boolean);
    const keys = wanted.length ? wanted : Object.keys(fields).slice(0, 4);
    const labels: string[] = [];
    for (const key of keys) {
        if (!(key in fields)) continue;
        const value = String(fields[key] ?? "");
        const mapped = applyJournalMap(key, value, rules);
        if (mapped === "") continue;
        if (mapped) {
            labels.push(mapped);
            continue;
        }
        if (!value) continue;
        const label = FIELD_LABEL[key] || key;
        // "pku: 1" or "cssci: CSSCI" mean "included"; repeating the value adds noise.
        const redundant = value === "1" || label.toUpperCase().includes(value.toUpperCase());
        labels.push(redundant ? label : `${label} ${value}`);
    }
    return labels.slice(0, 4).join(" · ");
}

export function extractJournalFields(payload: any): Record<string, string> | null {
    const data = payload?.data ?? payload;
    if (!data || typeof data !== "object") return null;
    const groups = [
        data.officialRank?.all,
        data.officialRank?.custom,
        data.customRank?.all,
    ];
    const fields: Record<string, string> = {};
    for (const group of groups) {
        if (!group || typeof group !== "object" || Array.isArray(group)) continue;
        for (const [key, value] of Object.entries<any>(group)) {
            if (value === null || value === undefined || value === "") continue;
            const text = typeof value === "object" ? String((value as any).value ?? "") : String(value);
            if (text && !(key in fields)) fields[key] = text;
        }
    }
    return Object.keys(fields).length ? fields : null;
}

/**
 * Ask easyScholar for one journal. Routed through the SiYuan kernel proxy to
 * avoid CORS; any failure returns null so the UI degrades to an empty cell.
 */
export async function fetchJournalFields(settings: Settings, journalName: string): Promise<Record<string, string> | null> {
    const name = normalizeJournalName(journalName);
    if (!settings.journalApiKey || !name) return null;
    const url = `${EASYSCHOLAR_ENDPOINT}?secretKey=${encodeURIComponent(settings.journalApiKey)}&publicationName=${encodeURIComponent(name)}`;
    try {
        const data = await apiPost<any>("/network/forwardProxy", {
            url,
            method: "GET",
            timeout: 15000,
            contentType: "application/json",
            headers: [],
            payload: "",
        });
        const body = data?.body ?? data?.data?.body ?? data;
        const parsed = typeof body === "string" ? JSON.parse(body) : body;
        if (parsed?.code !== undefined && Number(parsed.code) !== 1 && Number(parsed.code) !== 0 && Number(parsed.code) !== 200) {
            return null;
        }
        return extractJournalFields(parsed);
    } catch {
        return null;
    }
}
