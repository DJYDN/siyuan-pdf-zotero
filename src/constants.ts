export const PLUGIN_NAME = "siyuan-pdf-zotero";
export const PLUGIN_DISPLAY_NAME = "PDF × Zotero";
export const VERSION = "0.9.96";

export const TAB_TYPE = "pdf_zotero_reader";
export const DOCK_TYPE = "pdf_zotero_dock";
export const STORAGE_KEY = "state-v1";
export const STATE_VERSION = 6;
export const MATRIX_SCHEMA_VERSION = 3;
export const MATRIX_MIGRATION_BACKUP_KEY = "matrix-migration-backup-v1";

/** Custom SiYuan URL used by notes. Format: siyuan://plugins/<plugin>/annotation?id=<annotationId> */
export const ANNOTATION_ROUTE = "annotation";

export const PDFJS_ASSETS = {
    pdf: "pdf.min.mjs",
    worker: "pdf.worker.min.mjs",
    cmaps: "cmaps/",
    standardFonts: "standard_fonts/",
    wasm: "wasm/",
    iccs: "iccs/",
} as const;

export const HIGHLIGHT_COLORS: ReadonlyArray<{id: string; label: string; value: string}> = [
    {id: "none", label: "Don't specify color", value: "transparent"},
    {id: "yellow", label: "Yellow", value: "#ffd000"},
    {id: "red", label: "Red", value: "#ea5252"},
    {id: "blue", label: "Note", value: "#086ddd"},
    {id: "purple", label: "Important", value: "#bb61e5"},
];

export const DEFAULT_COLOR = "yellow";
export const DEFAULT_ZOOM = 1.15;
