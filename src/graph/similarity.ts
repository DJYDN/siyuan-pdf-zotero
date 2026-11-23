import type {GraphEdge, GraphPaper} from "./types";

/** Jaccard overlap of two reference sets; 0 when either side has no references. */
export function jaccard(a: string[], b: string[]): number {
    if (!a.length || !b.length) return 0;
    const left = new Set(a);
    const right = new Set(b);
    let shared = 0;
    for (const id of left) {
        if (right.has(id)) shared += 1;
    }
    const union = left.size + right.size - shared;
    return union > 0 ? shared / union : 0;
}

export interface SimilarityOptions {
    minWeight?: number;
    /** Keep at most this many similarity edges per node. */
    perNode?: number;
}

/**
 * Co-citation graph: papers that share references are pulled together, which is
 * the closest public approximation of Connected Papers' proximity.
 */
export function buildSimilarityEdges(papers: GraphPaper[], options: SimilarityOptions = {}): GraphEdge[] {
    const minWeight = options.minWeight ?? 0.06;
    const perNode = options.perNode ?? 4;
    const candidates: GraphEdge[] = [];
    for (let i = 0; i < papers.length; i += 1) {
        for (let j = i + 1; j < papers.length; j += 1) {
            const weight = jaccard(papers[i].refIds, papers[j].refIds);
            if (weight < minWeight) continue;
            candidates.push({from: papers[i].id, to: papers[j].id, weight, kind: "similar"});
        }
    }
    candidates.sort((a, b) => b.weight - a.weight);
    const degree = new Map<string, number>();
    const kept: GraphEdge[] = [];
    for (const edge of candidates) {
        const fromCount = degree.get(edge.from) || 0;
        const toCount = degree.get(edge.to) || 0;
        if (fromCount >= perNode && toCount >= perNode) continue;
        kept.push(edge);
        degree.set(edge.from, fromCount + 1);
        degree.set(edge.to, toCount + 1);
    }
    return kept;
}

/** Node radius grows with log citations so one giant paper cannot dominate. */
export function nodeRadius(citations: number): number {
    const value = Math.max(0, Number(citations) || 0);
    return Math.min(22, 4.5 + Math.log10(value + 1) * 6);
}

/** Year -> colour: older pale teal, newer deep teal (matches the reference palette). */
export function nodeColor(year: number | undefined, minYear: number, maxYear: number): string {
    if (!year || !Number.isFinite(year)) return "#94a3b8";
    const span = Math.max(1, maxYear - minYear);
    const ratio = Math.min(1, Math.max(0, (year - minYear) / span));
    const light = 72 - 32 * ratio;
    return `hsl(174 30% ${light.toFixed(0)}%)`;
}
