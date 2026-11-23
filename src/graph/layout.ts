import type {GraphEdge, GraphPaper} from "./types";
import {nodeRadius} from "./similarity";

export interface LayoutOptions {
    width?: number;
    height?: number;
    iterations?: number;
}

/**
 * Small deterministic force-directed layout.
 *
 * - repulsion keeps unrelated nodes apart;
 * - springs on similarity edges pull related work together (shorter for heavier weight);
 * - the seed sits at the centre and everything is gently pulled back so outliers
 *   cannot escape the viewport.
 *
 * Deterministic on purpose: the same graph always renders the same way, which
 * makes it comparable across sessions without persisting coordinates.
 */
export function layoutGraph(papers: GraphPaper[], edges: GraphEdge[], options: LayoutOptions = {}): void {
    const width = options.width ?? 1000;
    const height = options.height ?? 700;
    const iterations = options.iterations ?? 260;
    const count = papers.length;
    if (!count) return;
    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = nodeRadius(Math.max(...papers.map(paper => paper.citations), 0));
    const ring = Math.min(width, height) / 2 - maxRadius - 24;

    const index = new Map<string, number>();
    papers.forEach((paper, i) => {
        index.set(paper.id, i);
        paper.radius = nodeRadius(paper.citations);
        if (paper.relation === "seed") {
            paper.x = centerX;
            paper.y = centerY;
            return;
        }
        const angle = (i / Math.max(1, count - 1)) * Math.PI * 2;
        paper.x = centerX + Math.cos(angle) * ring * 0.72;
        paper.y = centerY + Math.sin(angle) * ring * 0.72;
    });

    const xs = papers.map(paper => paper.x ?? centerX);
    const ys = papers.map(paper => paper.y ?? centerY);
    const links = edges
        .map(edge => ({from: index.get(edge.from), to: index.get(edge.to), weight: edge.weight, kind: edge.kind}))
        .filter((link): link is {from: number; to: number; weight: number; kind: GraphEdge["kind"]} => link.from !== undefined && link.to !== undefined);

    for (let step = 0; step < iterations; step += 1) {
        const cooling = 1 - step / iterations;
        // Repulsion.
        for (let i = 0; i < count; i += 1) {
            for (let j = i + 1; j < count; j += 1) {
                let dx = xs[i] - xs[j];
                let dy = ys[i] - ys[j];
                let dist = Math.hypot(dx, dy);
                if (dist < 0.01) {
                    dx = (i - j) * 0.5 + 0.1;
                    dy = (j - i) * 0.5 + 0.1;
                    dist = Math.hypot(dx, dy);
                }
                const force = (5200 / (dist * dist)) * cooling;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                xs[i] += fx;
                ys[i] += fy;
                xs[j] -= fx;
                ys[j] -= fy;
            }
        }
        // Springs: similarity pulls hard, raw reference/citation links barely tug,
        // otherwise every node lines up on spokes around the seed.
        for (const link of links) {
            const dx = xs[link.to] - xs[link.from];
            const dy = ys[link.to] - ys[link.from];
            const dist = Math.max(0.01, Math.hypot(dx, dy));
            const similar = link.kind === "similar";
            const target = similar ? 210 - 140 * link.weight : 320;
            const strength = similar ? 0.06 : 0.014;
            const force = (dist - target) * strength * cooling;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            xs[link.from] += fx;
            ys[link.from] += fy;
            xs[link.to] -= fx;
            ys[link.to] -= fy;
        }
        // Gravity towards the centre.
        for (let i = 0; i < count; i += 1) {
            xs[i] += (centerX - xs[i]) * 0.012 * cooling;
            ys[i] += (centerY - ys[i]) * 0.012 * cooling;
        }
        // Keep inside a padded box.
        for (let i = 0; i < count; i += 1) {
            const pad = (papers[i].radius || 8) + 10;
            xs[i] = Math.min(width - pad, Math.max(pad, xs[i]));
            ys[i] = Math.min(height - pad, Math.max(pad, ys[i]));
        }
    }

    papers.forEach((paper, i) => {
        paper.x = xs[i];
        paper.y = ys[i];
    });
}
