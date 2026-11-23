import {apiPost} from "../api";
import type {Settings} from "../types";
import {layoutGraph} from "./layout";
import {buildSimilarityEdges} from "./similarity";
import type {GraphData, GraphPaper, GraphRelation} from "./types";

const BASE = "https://api.openalex.org";
const SELECT = "id,title,publication_year,cited_by_count,doi,referenced_works,related_works,primary_location,authorships,abstract_inverted_index";

function shortId(value: string): string {
    return String(value || "").replace(/^https?:\/\/openalex\.org\//, "");
}

function shortDoi(value: string | null | undefined): string {
    return String(value || "").replace(/^https?:\/\/doi\.org\//i, "");
}

/** OpenAlex stores abstracts as an inverted index; rebuild readable text. */
function abstractOf(work: any): string {
    const inverted = work?.abstract_inverted_index;
    if (!inverted || typeof inverted !== "object") return "";
    const words: Array<[number, string]> = [];
    for (const [word, positions] of Object.entries<any>(inverted)) {
        if (!Array.isArray(positions)) continue;
        for (const position of positions) {
            const index = Number(position);
            if (Number.isFinite(index)) words.push([index, word]);
        }
    }
    return words.sort((a, b) => a[0] - b[0]).map(item => item[1]).join(" ").slice(0, 900);
}

function toPaper(work: any, relation: GraphRelation): GraphPaper {
    const authors = Array.isArray(work?.authorships)
        ? work.authorships.map((entry: any) => String(entry?.author?.display_name || "")).filter(Boolean)
        : [];
    return {
        id: shortId(work?.id),
        title: String(work?.display_name || work?.title || "(无标题)"),
        year: Number(work?.publication_year) || undefined,
        citations: Number(work?.cited_by_count) || 0,
        doi: shortDoi(work?.doi),
        venue: String(work?.primary_location?.source?.display_name || ""),
        authors: authors.slice(0, 3),
        abstract: abstractOf(work),
        refIds: Array.isArray(work?.referenced_works) ? work.referenced_works.map(shortId).filter(Boolean) : [],
        relation,
    };
}

async function request(path: string, params: Record<string, string>, settings: Settings): Promise<any> {
    const query = new URLSearchParams(params);
    if (settings.openAlexApiKey) query.set("api_key", settings.openAlexApiKey);
    const url = `${BASE}${path}${query.toString() ? `?${query.toString()}` : ""}`;
    const data = await apiPost<any>("/network/forwardProxy", {
        url,
        method: "GET",
        timeout: 20000,
        contentType: "application/json",
        headers: [],
        payload: "",
    });
    const body = data?.body ?? data?.data?.body;
    let parsed: any;
    try {
        parsed = typeof body === "string" ? JSON.parse(body) : body;
    } catch {
        throw new Error("OpenAlex 返回了无法解析的内容");
    }
    if (parsed?.error) {
        throw new Error(String(parsed.error).slice(0, 200));
    }
    if (parsed?.meta?.notice && !parsed?.results && !parsed?.id) {
        throw new Error("OpenAlex 免费额度已用完，请在设置里填一个免费的 OpenAlex API Key");
    }
    return parsed;
}

export interface SeedInput {
    doi?: string;
    title?: string;
}

export async function resolveSeedWork(settings: Settings, input: SeedInput): Promise<any> {
    const doi = shortDoi(input.doi);
    if (doi) {
        const work = await request(`/works/doi:${encodeURIComponent(doi)}`, {select: SELECT}, settings);
        if (work?.id) return work;
    }
    const title = String(input.title || "").trim();
    if (!title) throw new Error("这篇文献没有 DOI 或标题，无法建立网络");
    const found = await request("/works", {
        search: title,
        "per-page": "1",
        select: SELECT,
    }, settings);
    const first = Array.isArray(found?.results) ? found.results[0] : null;
    if (!first) throw new Error("OpenAlex 找不到这篇文献");
    return first;
}

async function fetchWorksByIds(settings: Settings, ids: string[]): Promise<any[]> {
    if (!ids.length) return [];
    const result = await request("/works", {
        filter: `openalex_id:${ids.join("|")}`,
        "per-page": String(Math.min(100, ids.length)),
        select: SELECT,
    }, settings);
    return Array.isArray(result?.results) ? result.results : [];
}

async function fetchCiting(settings: Settings, seedId: string, limit: number): Promise<any[]> {
    if (!seedId) return [];
    const result = await request("/works", {
        filter: `cites:${seedId}`,
        sort: "cited_by_count:desc",
        "per-page": String(limit),
        select: SELECT,
    }, settings);
    return Array.isArray(result?.results) ? result.results : [];
}

function uniqueById(papers: GraphPaper[]): GraphPaper[] {
    const seen = new Set<string>();
    const out: GraphPaper[] = [];
    for (const paper of papers) {
        if (!paper.id || seen.has(paper.id)) continue;
        seen.add(paper.id);
        out.push(paper);
    }
    return out;
}

export interface ExpandResult {
    papers: GraphPaper[];
    edges: GraphData["edges"];
    error?: string;
}

/**
 * Connected-Papers style "expand": pull a selected node's own references and
 * citing papers into the current graph. Neighbours are capped so one expansion
 * cannot flood the view.
 */
export async function expandFromNode(settings: Settings, node: GraphPaper): Promise<ExpandResult> {
    try {
        let refIds = node.refIds.slice(0, 40);
        if (!refIds.length) {
            const full = await request(`/works/${encodeURIComponent(node.id)}`, {select: SELECT}, settings);
            refIds = Array.isArray(full?.referenced_works) ? full.referenced_works.map(shortId).slice(0, 40) : [];
        }
        const [referenceWorks, citingWorks] = await Promise.all([
            fetchWorksByIds(settings, refIds),
            fetchCiting(settings, node.id, 10),
        ]);
        const references = uniqueById(referenceWorks.map(work => toPaper(work, "reference")))
            .sort((a, b) => b.citations - a.citations)
            .slice(0, 8);
        const citing = uniqueById(citingWorks.map(work => toPaper(work, "citation")))
            .sort((a, b) => b.citations - a.citations)
            .slice(0, 8);
        const papers = uniqueById([...references, ...citing]).filter(paper => paper.id !== node.id);
        const edges: GraphData["edges"] = [];
        for (const paper of references) {
            if (paper.id !== node.id) edges.push({from: node.id, to: paper.id, weight: 1, kind: "reference"});
        }
        for (const paper of citing) {
            if (paper.id !== node.id) edges.push({from: paper.id, to: node.id, weight: 1, kind: "citation"});
        }
        return {papers, edges};
    } catch (error: any) {
        return {papers: [], edges: [], error: error?.message || String(error)};
    }
}

export interface BuildGraphOptions {
    maxReferences?: number;
    maxRelated?: number;
    maxCiting?: number;
    width?: number;
    height?: number;
}

/**
 * Connected-Papers style neighbourhood:
 *   seed + its references (prior works) + papers citing it (derivative works)
 *   + OpenAlex related works, positioned by co-citation similarity.
 */
export async function buildGraph(settings: Settings, input: SeedInput, options: BuildGraphOptions = {}): Promise<GraphData> {
    const seedWork = await resolveSeedWork(settings, input);
    const seed = toPaper(seedWork, "seed");
    const referenceIds = (Array.isArray(seedWork.referenced_works) ? seedWork.referenced_works : [])
        .map(shortId)
        .filter(Boolean)
        .slice(0, 80);
    const relatedIds = (Array.isArray(seedWork.related_works) ? seedWork.related_works : [])
        .map(shortId)
        .filter(Boolean)
        .slice(0, 20);

    const [referenceWorks, relatedWorks, citingWorks] = await Promise.all([
        fetchWorksByIds(settings, referenceIds),
        fetchWorksByIds(settings, relatedIds),
        fetchCiting(settings, seed.id, options.maxCiting ?? 20),
    ]);

    const seedIds = new Set([seed.id, ...referenceIds]);
    const references = uniqueById(referenceWorks.map(work => toPaper(work, "reference")))
        .sort((a, b) => b.citations - a.citations)
        .slice(0, options.maxReferences ?? 20);

    const related = uniqueById(relatedWorks
        .map(work => toPaper(work, "related"))
        .filter(paper => !seedIds.has(paper.id) && !references.some(item => item.id === paper.id)))
        .sort((a, b) => b.citations - a.citations)
        .slice(0, options.maxRelated ?? 8);

    const derivative = uniqueById(citingWorks.map(work => toPaper(work, "citation")))
        .sort((a, b) => b.citations - a.citations)
        .slice(0, options.maxCiting ?? 15);

    const nodes = uniqueById([seed, ...references, ...related, ...derivative]);
    const nodeIds = new Set(nodes.map(paper => paper.id));
    const edges = [] as GraphData["edges"];

    for (const paper of references) {
        if (nodeIds.has(paper.id)) edges.push({from: seed.id, to: paper.id, weight: 1, kind: "reference"});
    }
    for (const paper of derivative) {
        if (nodeIds.has(paper.id)) edges.push({from: paper.id, to: seed.id, weight: 1, kind: "citation"});
    }
    // OpenAlex related works are already algorithmic neighbours; anchor them to the
    // seed so they stay in the core cluster even when reference overlap is sparse.
    for (const paper of related) {
        if (nodeIds.has(paper.id)) edges.push({from: seed.id, to: paper.id, weight: 0.45, kind: "similar"});
    }
    edges.push(...buildSimilarityEdges(nodes));

    layoutGraph(nodes, edges, {width: options.width, height: options.height});

    return {
        seed,
        nodes,
        edges,
        prior: [...references].sort((a, b) => (a.year || 9999) - (b.year || 9999)).slice(0, 10),
        derivative: [...derivative].slice(0, 10),
        fetchedAt: Date.now(),
    };
}
