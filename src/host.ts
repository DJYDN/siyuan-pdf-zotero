import type {Store} from "./storage";
import type {PdfAttachment} from "./types";

export interface NoteInsertionTarget {
    docId: string;
    range?: Range;
    blockId?: string;
    textOffset?: number;
    trackedHandle?: {readonly id: string};
}

export interface PluginHost {
    readonly name: string;
    readonly store: Store;

    openAttachment(attachment: PdfAttachment, page?: number, annotationId?: string): void;

    /** Make one PDF the workspace target; only it exposes the full shared controls. */
    activateReader(attachmentId: string): void;

    refreshDock(): void;

    importLocalPdfFromPicker(): Promise<void>;

    importLocalPath(filePath: string): Promise<PdfAttachment | null>;

    refreshZotero(): Promise<void>;

    openZoteroItem(itemKey: string): Promise<void>;

    /** Open the source document and focus the block that holds the note link. */
    openNoteBlock(docId: string, blockId: string): Promise<void>;

    openCitationDialog(citationId?: string, initialItemKeys?: string[]): void;

    /** Re-authorize a moved/deleted PDF without losing annotations or note links. */
    relinkAttachment(attachmentId: string): Promise<void>;

    /** Last document editor the user focused; screenshot images insert here. */
    getLastNoteDocId(): string;

    /** Frozen note caret used while focus is temporarily inside the PDF reader. */
    captureNoteInsertionTarget(): NoteInsertionTarget;

    logDebug(event: string, data?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error"): void;

    /** Restart the settings-only notebook automation after settings change. */
    restartAutomation(): void;
}
