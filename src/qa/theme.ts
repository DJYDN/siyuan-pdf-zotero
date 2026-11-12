import type {Settings} from "../types";

let styleElement: HTMLStyleElement | null = null;

export async function repairQaBlockAttributes(title: string): Promise<void> {
    try {
        const token = String((window as any).siyuan?.config?.api?.token || "");
        const safeTitle = String(title || "PDF 问答").replaceAll("'", "''").replaceAll("%", "\\%").replaceAll("_", "\\_");
        const query = await fetch("/api/query/sql", {
            method: "POST",
            headers: {"Content-Type": "application/json", ...(token ? {Authorization: `Token ${token}`} : {})},
            body: JSON.stringify({stmt: `select id from blocks where type='b' and markdown like '%${safeTitle}%' order by updated desc limit 100`}),
        });
        const result = await query.json();
        const ids: string[] = (Array.isArray(result.data) ? result.data : [])
            .map((item: any) => String(item?.id || ""))
            .filter(Boolean);
        for (const id of ids) {
            await fetch("/api/attr/setBlockAttrs", {
                method: "POST",
                headers: {"Content-Type": "application/json", ...(token ? {Authorization: `Token ${token}`} : {})},
                body: JSON.stringify({id, attrs: {"custom-qa-block": "true"}}),
            });
        }
    } catch {
        // Best-effort repair for blocks inserted before the attribute fix.
    }
}

export function applyQaBlockTheme(settings: Settings): void {
    if (!styleElement?.isConnected) {
        styleElement = document.createElement("style");
        styleElement.dataset.pzQaTheme = "true";
        document.head.append(styleElement);
    }
    const radius = Math.max(0, Math.min(24, Number(settings.qaBlockRadius) || 8));
    const font = settings.qaFontFamily?.trim() ? `font-family:${settings.qaFontFamily.trim()};` : "";
    const qSize = Math.max(10, Math.min(24, Number(settings.qaQuestionFontSize) || 13));
    const aSize = Math.max(10, Math.min(24, Number(settings.qaAnswerFontSize) || 14));
    styleElement.textContent = `
[custom-qa-block="true"] {
  border: 1px solid ${settings.qaBlockBorderColor || "#d7dcef"} !important;
  border-left: 1px solid ${settings.qaBlockBorderColor || "#d7dcef"} !important;
  border-radius: ${radius}px !important;
  background: ${settings.qaBlockBackground || "#f7f8fd"} !important;
  padding: 9px 12px !important;
  ${font}
}
[custom-qa-block="true"] > .p:first-child [data-type="strong"] {
  color: ${settings.qaTitleColor || "#4f63d2"} !important;
}
[custom-qa-block="true"] > .p:nth-of-type(2) [data-type="strong"] {
  color: ${settings.qaQuestionColor || "#2563eb"} !important;
  font-size: ${qSize}px !important;
}
[custom-qa-block="true"] > .p:nth-of-type(3) {
  font-size: ${qSize}px !important;
}
[custom-qa-block="true"] > .p:nth-of-type(4) [data-type="strong"] {
  color: ${settings.qaAnswerColor || "#15803d"} !important;
  font-size: ${aSize}px !important;
}
[custom-qa-block="true"] > .p:nth-of-type(n+5) {
  font-size: ${aSize}px !important;
}
`;
}
