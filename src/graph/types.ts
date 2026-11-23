export type GraphRelation = "seed" | "origin" | "reference" | "citation" | "related";

export interface GraphPaper {
    /** OpenAlex work id without the URL prefix, e.g. W2919115771. */
    id: string;
    title: string;
    year?: number;
    citations: number;
    doi?: string;
    venue?: string;
    authors: string[];
    /** Reconstructed abstract, truncated for the detail panel. */
    abstract?: string;
    /** Normalized ids of the works this paper references, used for co-citation. */
    refIds: string[];
    relation: GraphRelation;
    /** Layout output, filled by layoutGraph. */
    x?: number;
    y?: number;
    radius?: number;
}

export interface GraphEdge {
    from: string;
    to: string;
    weight: number;
    kind: "reference" | "citation" | "similar";
}

export interface GraphData {
    seed: GraphPaper;
    nodes: GraphPaper[];
    edges: GraphEdge[];
    prior: GraphPaper[];
    derivative: GraphPaper[];
    fetchedAt: number;
}
