import type {ZoteroItemRecord} from "../types";

const TYPE_MAP: Record<string, string> = {
    journalArticle: "article-journal",
    magazineArticle: "article-magazine",
    newspaperArticle: "article-newspaper",
    book: "book",
    bookSection: "chapter",
    conferencePaper: "paper-conference",
    thesis: "thesis",
    report: "report",
    webpage: "webpage",
    blogPost: "post-weblog",
    forumPost: "post",
    patent: "patent",
    software: "software",
    dataset: "dataset",
    manuscript: "manuscript",
    artwork: "graphic",
    film: "motion_picture",
    videoRecording: "motion_picture",
    audioRecording: "song",
    presentation: "speech",
    standard: "standard",
    preprint: "article",
    document: "article",
};

function stripTags(value: string): string {
    return String(value || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function creatorName(creator: any): {family?: string; given?: string; literal?: string} | null {
    if (!creator) {
        return null;
    }
    if (creator.name) {
        return {literal: String(creator.name)};
    }
    if (!creator.lastName && !creator.firstName) {
        return null;
    }
    return {
        family: String(creator.lastName || "").trim() || undefined,
        given: String(creator.firstName || "").trim() || undefined,
    };
}

function creators(data: Record<string, any>, role: string): any[] {
    if (!Array.isArray(data.creators)) {
        return [];
    }
    return data.creators
        .filter((creator: any) => creator?.creatorType === role)
        .map(creatorName)
        .filter(Boolean);
}

export function parseIssued(dateValue: any, parsedDate?: any): { "date-parts": number[][] } | undefined {
    if (parsedDate) {
        const parts = String(parsedDate).split("-").map(Number).filter(Number.isFinite);
        if (parts.length) {
            return {"date-parts": [parts]};
        }
    }
    const text = String(dateValue || "");
    const full = text.match(/(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/);
    if (full) {
        const parts = [Number(full[1]), Number(full[2])];
        if (full[3]) {
            parts.push(Number(full[3]));
        }
        return {"date-parts": [parts]};
    }
    const year = text.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
    return year ? {"date-parts": [[Number(year[1])]]} : undefined;
}

function yearOf(issued: any): string {
    return String(issued?.["date-parts"]?.[0]?.[0] || "");
}

/**
 * Convert Zotero Local API item.data to a CSL-JSON item.
 * The item id is `${libraryId}:${key}` so multiple libraries can coexist.
 */
export function zoteroItemToCsl(data: Record<string, any>, libraryId = 0): Record<string, any> | null {
    if (!data || !data.key) {
        return null;
    }
    const issued = parseIssued(data.date, data.parsedDate);
    const type = TYPE_MAP[String(data.itemType || "")] || "article";
    const csl: Record<string, any> = {
        id: `${libraryId}:${data.key}`,
        type,
        title: stripTags(data.title || data.name || ""),
        "citation-key": data.citationKey || data.key,
    };
    const author = creators(data, "author");
    const editor = creators(data, "editor");
    const translator = creators(data, "translator");
    if (author.length) {
        csl.author = author;
    }
    if (editor.length) {
        csl.editor = editor;
    }
    if (translator.length) {
        csl.translator = translator;
    }
    if (issued) {
        csl.issued = issued;
    }
    const container = data.publicationTitle || data.bookTitle || data.proceedingsTitle
        || data.websiteTitle || data.blogTitle || data.forumTitle || data.seriesTitle;
    if (container) {
        csl["container-title"] = stripTags(container);
    }
    if (data.journalAbbreviation) {
        csl["container-title-short"] = stripTags(data.journalAbbreviation);
    }
    if (data.volume) {
        csl.volume = String(data.volume);
    }
    if (data.issue) {
        csl.issue = String(data.issue);
    }
    if (data.pages) {
        csl.page = String(data.pages).replace(/[–—]/g, "-");
    }
    if (data.number) {
        csl.number = String(data.number);
    }
    if (data.DOI) {
        csl.DOI = String(data.DOI);
    }
    if (data.url) {
        csl.URL = String(data.url);
    }
    if (data.publisher) {
        csl.publisher = stripTags(data.publisher);
    }
    if (data.place) {
        csl["publisher-place"] = stripTags(data.place);
    }
    if (data.edition) {
        csl.edition = String(data.edition);
    }
    if (data.ISBN) {
        csl.ISBN = String(data.ISBN);
    }
    if (data.ISSN) {
        csl.ISSN = String(data.ISSN);
    }
    if (data.language) {
        csl.language = String(data.language);
    }
    if (data.abstractNote) {
        csl.abstract = stripTags(data.abstractNote);
    }
    if (data.accessDate) {
        csl.accessed = parseIssued(data.accessDate);
    }
    if (data.conferenceName) {
        csl.event = stripTags(data.conferenceName);
    }
    if (data.thesisType) {
        csl.genre = stripTags(data.thesisType);
    }
    if (data.reportType) {
        csl.genre = stripTags(data.reportType);
    }
    if (data.institution) {
        csl.publisher = stripTags(data.institution);
    }
    return csl;
}

export function cslYear(csl: Record<string, any> | undefined): string {
    return yearOf(csl?.issued);
}

export function zoteroRecordToCsl(record: ZoteroItemRecord, libraryId = 0): Record<string, any> | null {
    return zoteroItemToCsl(record.data, libraryId);
}
