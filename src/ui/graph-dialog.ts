import {showMessage} from "siyuan";
import type {PluginHost} from "../host";
import {buildGraph, expandFromNode, type SeedInput} from "../graph/openalex";
import {layoutGraph} from "../graph/layout";
import {findLocalTarget} from "../graph/local-match";
import {nodeColor} from "../graph/similarity";
import type {GraphData, GraphPaper} from "../graph/types";
import {newId} from "../storage";

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 680;
/** Graphs are expensive (three OpenAlex calls + layout); keep recent ones in memory. */
const graphCache = new Map<string, GraphData>();

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[ch] as string));
}

function shortTitle(title: string, max = 22): string {
    const text = String(title || "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Connected Papers labels nodes by first author + year, not by full title. */
function paperLabel(paper: {authors: string[]; year?: number; title: string}): string {
    const first = String(paper.authors?.[0] || "").replace(/\./g, "").trim();
    const surname = first ? first.split(/\s+/).pop() || "" : "";
    return surname ? `${surname} ${paper.year || ""}`.trim() : shortTitle(paper.title, 16);
}

function citationKey(paper: {authors: string[]; year?: number; title: string}): string {
    const first = String(paper.authors?.[0] || "").replace(/[^A-Za-z]/g, "").toLowerCase();
    return `${first || "ref"}${paper.year || ""}`;
}

function bibtexFor(paper: {title: string; authors: string[]; year?: number; venue?: string; doi?: string; citations: number}): string {
    const fields = [
        `  title = {${paper.title}}`,
        paper.authors.length ? `  author = {${paper.authors.join(" and ")}}` : "",
        paper.year ? `  year = {${paper.year}}` : "",
        paper.venue ? `  journal = {${paper.venue}}` : "",
        paper.doi ? `  doi = {${paper.doi}}` : "",
    ].filter(Boolean).join(",\n");
    return `@article{${citationKey(paper)},\n${fields}\n}`;
}

interface NodeView {
    group: SVGGElement;
    circle: SVGCircleElement;
    label: SVGTextElement | null;
    labelOffset: number;
}

interface EdgeView {
    line: SVGLineElement;
    from: string;
    to: string;
    kind: string;
}

export function openGraph(host: PluginHost, seed: SeedInput = {}): void {
    let data: GraphData | null = null;
    let selectedId = "";
    let hoverId = "";
    let highlight: "" | "prior" | "derivative" = "";
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let dragging = false;
    let dragMoved = false;
    let dragNodeId = "";
    let dragStart = {x: 0, y: 0, panX: 0, panY: 0, nodeX: 0, nodeY: 0};
    let busy = false;
    let animation = 0;
    let zoomAnimation = 0;

    let svg: SVGSVGElement | null = null;
    let viewport: SVGGElement | null = null;
    let nodeLayer: SVGGElement | null = null;
    let edgeLayer: SVGGElement | null = null;
    const nodeViews = new Map<string, NodeView>();
    const edgeViews: EdgeView[] = [];

    document.querySelectorAll(".pz-graph-overlay").forEach(element => element.remove());
    const overlay = document.createElement("div");
    overlay.className = "pz-graph-overlay";
    overlay.innerHTML = `<div class="pz-graph-window">
  <header class="pz-graph-header">
    <div class="pz-graph-title">文献网络</div>
    <div class="pz-graph-seed" data-role="graph-seed">输入 DOI 或标题开始</div>
    <div class="pz-graph-actions">
      <button class="pz-graph-tab" data-act="graph-prior">Prior works</button>
      <button class="pz-graph-tab" data-act="graph-derivative">Derivative works</button>
      <button class="pz-graph-tool" data-act="graph-list-view">列表视图</button>
      <button class="pz-graph-tool" data-act="graph-filters">筛选</button>
      <button class="pz-graph-tool" data-act="graph-more">更多 ⋯</button>
    </div>
    <button class="pz-graph-close" data-act="graph-close" title="关闭">×</button>
  </header>
  <div class="pz-graph-filters" data-role="graph-filters" hidden>
    <label>年份 <input type="number" data-role="filter-year-from" placeholder="起始" /> – <input type="number" data-role="filter-year-to" placeholder="结束" /></label>
    <label>最少被引 <input type="number" min="0" data-role="filter-min-citations" placeholder="0" /></label>
    <label class="pz-graph-check"><input type="checkbox" data-role="filter-has-doi" /> 仅含 DOI</label>
    <div class="pz-graph-filter-actions">
      <button class="b3-button b3-button--text" data-act="graph-filter-apply">应用</button>
      <button class="b3-button b3-button--outline" data-act="graph-filter-reset">重置</button>
      <span class="pz-graph-filter-count" data-role="filter-count"></span>
    </div>
  </div>
  <div class="pz-graph-body">
    <aside class="pz-graph-left">
      <div class="pz-graph-side" data-role="graph-side" hidden></div>
      <div class="pz-graph-legend">
        <span>节点大小 = 被引次数</span><span>颜色 = 年份（越深越新）</span><span>距离 = 共被引相似度</span><span>悬停高亮 · 双击打开</span>
      </div>
    </aside>
    <div class="pz-graph-canvas" data-role="graph-canvas">
      <div class="pz-graph-start-overlay">
        <div class="pz-graph-start" data-role="graph-start">
          <div class="pz-graph-start-title">从一篇论文开始</div>
          <div class="pz-graph-start-hint">输入 DOI、OpenAlex ID 或标题，例如 10.1038/nature14539</div>
          <div class="pz-graph-start-row"><input class="b3-text-field fn__block" data-role="graph-seed-input" placeholder="DOI / 标题" /><button class="pz-graph-generate" data-act="graph-start">生成网络</button></div>
        </div>
      </div>
      <div class="pz-graph-scale" data-role="graph-scale" hidden>
        <span data-role="scale-min"></span>
        <div class="pz-graph-scale-bar" data-role="scale-bar"></div>
        <span data-role="scale-max"></span>
        <em>年份</em>
      </div>
      <div class="pz-graph-listview" data-role="graph-listview" hidden></div>
      <div class="pz-graph-zoom">
        <button data-act="graph-zoom-in" title="放大">＋</button>
        <button data-act="graph-zoom-out" title="缩小">－</button>
      </div>
      <div class="pz-graph-tip" data-role="graph-tip" hidden></div>
    </div>
    <aside class="pz-graph-detail" data-role="graph-detail"><div class="pz-graph-hint">点击节点查看详情</div></aside>
  </div>
  <div class="pz-graph-resize" data-resize="n"></div>
  <div class="pz-graph-resize" data-resize="s"></div>
  <div class="pz-graph-resize" data-resize="e"></div>
  <div class="pz-graph-resize" data-resize="w"></div>
  <div class="pz-graph-resize" data-resize="ne"></div>
  <div class="pz-graph-resize" data-resize="nw"></div>
  <div class="pz-graph-resize" data-resize="se"></div>
  <div class="pz-graph-resize" data-resize="sw"></div>
</div>`;
    document.body.appendChild(overlay);

    const root = overlay.querySelector<HTMLElement>(".pz-graph-window")!;
    const windowEl = root;
    const closeGraph = () => {
        document.querySelectorAll(".pz-graph-menu").forEach(element => element.remove());
        if (viewportResizeHandler) window.removeEventListener("resize", viewportResizeHandler);
        overlay.remove();
        document.removeEventListener("keydown", handleWindowKey, true);
    };
    const handleWindowKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") closeGraph();
    };
    document.addEventListener("keydown", handleWindowKey, true);
    overlay.addEventListener("mousedown", event => {
        if (event.target === overlay) closeGraph();
    });
    const seedEl = root.querySelector<HTMLElement>('[data-role="graph-seed"]')!;
    const startEl = root.querySelector<HTMLElement>('[data-role="graph-start"]')!;
    const canvasEl = root.querySelector<HTMLElement>('[data-role="graph-canvas"]')!;
    const detailEl = root.querySelector<HTMLElement>('[data-role="graph-detail"]')!;
    const sideEl = root.querySelector<HTMLElement>('[data-role="graph-side"]')!;
    const tipEl = root.querySelector<HTMLElement>('[data-role="graph-tip"]')!;
    const matrixButton = root.querySelector<HTMLButtonElement>('[data-act="graph-matrix"]');
    const priorButton = root.querySelector<HTMLButtonElement>('[data-act="graph-prior"]')!;
    const derivativeButton = root.querySelector<HTMLButtonElement>('[data-act="graph-derivative"]')!;
    const seedInput = root.querySelector<HTMLInputElement>('[data-role="graph-seed-input"]')!;
    const scaleEl = root.querySelector<HTMLElement>('[data-role="graph-scale"]')!;
    const scaleMinEl = root.querySelector<HTMLElement>('[data-role="scale-min"]')!;
    const scaleMaxEl = root.querySelector<HTMLElement>('[data-role="scale-max"]')!;
    const scaleBarEl = root.querySelector<HTMLElement>('[data-role="scale-bar"]')!;
    const emptyEl = root.querySelector<HTMLElement>('[data-role="graph-empty"]');
    const mainEl = root.querySelector<HTMLElement>(".pz-graph-body")!;
    const listViewEl = root.querySelector<HTMLElement>('[data-role="graph-listview"]')!;
    const filtersEl = root.querySelector<HTMLElement>('[data-role="graph-filters"]')!;
    const filterYearFrom = root.querySelector<HTMLInputElement>('[data-role="filter-year-from"]')!;
    const filterYearTo = root.querySelector<HTMLInputElement>('[data-role="filter-year-to"]')!;
    const filterMinCitations = root.querySelector<HTMLInputElement>('[data-role="filter-min-citations"]')!;
    const filterHasDoi = root.querySelector<HTMLInputElement>('[data-role="filter-has-doi"]')!;
    const filterCountEl = root.querySelector<HTMLElement>('[data-role="filter-count"]')!;
    let listView = false;
    let filters = {from: 0, to: 0, minCitations: 0, hasDoi: false};
    const originIds = new Set<string>();
    const canvasSize = () => ({
        width: Math.max(480, Math.round(canvasEl.clientWidth || CANVAS_WIDTH)),
        height: Math.max(360, Math.round(canvasEl.clientHeight || CANVAS_HEIGHT)),
    });

    const MIN_W = 640;
    const MIN_H = 420;
    let resizeState: {dir: string; x: number; y: number; left: number; top: number; width: number; height: number} | null = null;
    let viewportResizeHandler: (() => void) | null = null;

    const applyDialogSize = (expanded: boolean) => {
        windowEl.classList.toggle("is-compact", !expanded);
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const width = Math.round(expanded ? Math.min(1200, vw - 48) : Math.min(760, vw - 32));
        windowEl.style.width = `${width}px`;
        windowEl.style.left = `${Math.max(8, (vw - width) / 2)}px`;
        if (expanded) {
            const height = Math.round(Math.min(760, vh - 48));
            windowEl.style.height = `${height}px`;
            windowEl.style.top = `${Math.max(8, (vh - height) / 2)}px`;
            window.setTimeout(() => {
                const rect = (element: Element | null) => {
                    if (!element) return null;
                    const box = element.getBoundingClientRect();
                    return {x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height)};
                };
                host.logDebug("graph.geometry", {
                    viewport: {w: vw, h: vh, dpr: window.devicePixelRatio},
                    window: rect(windowEl),
                    header: rect(windowEl.querySelector(".pz-graph-header")),
                    body: rect(mainEl),
                    left: rect(windowEl.querySelector(".pz-graph-left")),
                    canvas: rect(canvasEl),
                    detail: rect(windowEl.querySelector(".pz-graph-detail")),
                });
            }, 300);
        } else {
            windowEl.style.height = "auto";
            requestAnimationFrame(() => {
                const height = windowEl.offsetHeight;
                windowEl.style.top = `${Math.max(8, (vh - height) / 2)}px`;
            });
        }
    };
    applyDialogSize(false);

    for (const handle of Array.from(windowEl.querySelectorAll<HTMLElement>("[data-resize]"))) {
        const dir = handle.dataset.resize || "";
        handle.addEventListener("pointerdown", event => {
            event.preventDefault();
            event.stopPropagation();
            const rect = windowEl.getBoundingClientRect();
            resizeState = {dir, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height};
            handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener("pointermove", event => {
            if (!resizeState) return;
            let {left, top, width, height} = resizeState;
            const dx = event.clientX - resizeState.x;
            const dy = event.clientY - resizeState.y;
            if (resizeState.dir.includes("e")) width = Math.max(MIN_W, width + dx);
            if (resizeState.dir.includes("s")) height = Math.max(MIN_H, height + dy);
            if (resizeState.dir.includes("w")) {
                width = Math.max(MIN_W, width - dx);
                left = resizeState.left + (resizeState.width - width);
            }
            if (resizeState.dir.includes("n")) {
                height = Math.max(MIN_H, height - dy);
                top = resizeState.top + (resizeState.height - height);
            }
            width = Math.min(width, window.innerWidth - 8);
            height = Math.min(height, window.innerHeight - 8);
            left = Math.max(4, Math.min(left, window.innerWidth - width - 4));
            top = Math.max(4, Math.min(top, window.innerHeight - height - 4));
            Object.assign(windowEl.style, {left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`});
            windowEl.classList.remove("is-compact");
        });
        const stop = () => {
            resizeState = null;
        };
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
    }

    viewportResizeHandler = () => {
        if (!windowEl.isConnected) return;
        const rect = windowEl.getBoundingClientRect();
        const width = Math.min(rect.width, window.innerWidth - 16);
        const height = Math.min(rect.height, window.innerHeight - 16);
        const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4));
        const top = Math.max(4, Math.min(rect.top, window.innerHeight - height - 4));
        Object.assign(windowEl.style, {left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`});
    };
    window.addEventListener("resize", viewportResizeHandler);

    const nodeById = (id: string): GraphPaper | undefined => data?.nodes.find(node => node.id === id);

    const openOriginal = async (node: GraphPaper) => {
        const local = findLocalTarget(host.store.state, node);
        if (local?.kind === "zotero") {
            await host.openZoteroItem(local.id);
            return;
        }
        if (local?.kind === "attachment") {
            const attachment = host.store.getAttachment(local.id);
            if (attachment) {
                host.openAttachment(attachment);
                return;
            }
        }
        if (node.doi) {
            window.open(`https://doi.org/${node.doi}`, "_blank");
            return;
        }
        showMessage("本地没有这篇 PDF，OpenAlex 也没有 DOI", 3500);
    };

    const years = () => (data ? data.nodes.map(node => node.year || 0).filter(Boolean) : []);
    const minYear = () => (years().length ? Math.min(...years()) : 2000);
    const maxYear = () => (years().length ? Math.max(...years()) : 2024);

    const neighbourIds = (id: string): Set<string> => {
        const set = new Set<string>([id]);
        if (!data) return set;
        for (const edge of data.edges) {
            if (edge.from === id) set.add(edge.to);
            if (edge.to === id) set.add(edge.from);
        }
        return set;
    };

    const highlightIds = (): Set<string> | null => {
        if (!data) return null;
        if (highlight === "prior") return new Set(data.prior.map(paper => paper.id));
        if (highlight === "derivative") return new Set(data.derivative.map(paper => paper.id));
        // Only hover dims the rest of the graph; a click just selects (like the original site).
        if (!hoverId) return null;
        return neighbourIds(hoverId);
    };

    // ---- rendering -------------------------------------------------------

    const applyTransform = () => {
        viewport?.setAttribute("transform", `translate(${panX.toFixed(2)} ${panY.toFixed(2)}) scale(${zoom.toFixed(3)})`);
    };

    const syncNodePosition = (node: GraphPaper) => {
        const view = nodeViews.get(node.id);
        if (!view) return;
        const x = (node.x || 0).toFixed(1);
        const y = (node.y || 0).toFixed(1);
        view.circle.setAttribute("cx", x);
        view.circle.setAttribute("cy", y);
        if (view.label) {
            view.label.setAttribute("x", x);
            view.label.setAttribute("y", (Number(y) + view.labelOffset).toFixed(1));
        }
        for (const edge of edgeViews) {
            if (edge.from === node.id) {
                edge.line.setAttribute("x1", x);
                edge.line.setAttribute("y1", y);
            }
            if (edge.to === node.id) {
                edge.line.setAttribute("x2", x);
                edge.line.setAttribute("y2", y);
            }
        }
    };

    const syncAllPositions = () => {
        if (!data) return;
        for (const node of data.nodes) syncNodePosition(node);
    };

    const applyFocus = () => {
        if (!data) return;
        const focus = highlightIds();
        for (const node of data.nodes) {
            const view = nodeViews.get(node.id);
            if (!view) continue;
            const active = !focus || focus.has(node.id);
            view.group.classList.toggle("is-dim", !active);
            view.group.classList.toggle("is-hover", node.id === hoverId);
            view.group.classList.toggle("is-selected", node.id === selectedId);
        }
        for (const edge of edgeViews) {
            if (!focus) {
                edge.line.classList.remove("is-lit", "is-dim");
                continue;
            }
            const active = focus.has(edge.from) && focus.has(edge.to);
            edge.line.classList.toggle("is-lit", active);
            edge.line.classList.toggle("is-dim", !active);
        }
    };

    /** Original site behaviour: the right panel only follows clicks, never hover. */
    const renderDetailForFocus = () => {
        renderDetail(selectedId ? nodeById(selectedId) : undefined);
    };

    const buildScene = () => {
        if (!data) return;
        canvasEl.querySelector("svg")?.remove();
        nodeViews.clear();
        edgeViews.length = 0;

        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const size = canvasSize();
        svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svg.classList.add("pz-graph-svg");

        viewport = document.createElementNS("http://www.w3.org/2000/svg", "g");
        viewport.classList.add("pz-graph-viewport");
        edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        viewport.appendChild(edgeLayer);
        viewport.appendChild(nodeLayer);
        svg.appendChild(viewport);

        const low = minYear();
        const high = maxYear();
        const labels = new Set<string>();
        for (const node of data.nodes) labels.add(node.id);

        for (const edge of data.edges) {
            const from = nodeById(edge.from);
            const to = nodeById(edge.to);
            if (!from || !to) continue;
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", (from.x || 0).toFixed(1));
            line.setAttribute("y1", (from.y || 0).toFixed(1));
            line.setAttribute("x2", (to.x || 0).toFixed(1));
            line.setAttribute("y2", (to.y || 0).toFixed(1));
            line.setAttribute("vector-effect", "non-scaling-stroke");
            line.classList.add("pz-graph-edge", `is-${edge.kind}`);
            if (edge.kind !== "similar") line.classList.add("is-structural");
            if (edge.kind === "similar") line.style.strokeWidth = `${(0.7 + edge.weight * 1.4).toFixed(2)}px`;
            edgeLayer.appendChild(line);
            edgeViews.push({line, from: edge.from, to: edge.to, kind: edge.kind});
        }

        for (const node of data.nodes) {
            const radius = (node.radius || 8) + (node.relation === "seed" ? 3 : 0);
            const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
            group.classList.add("pz-graph-node");
            group.dataset.node = node.id;
            if (node.relation === "seed") group.classList.add("is-seed");
            if (originIds.has(node.id) || node.relation === "origin") group.classList.add("is-origin");
            if (node.id === selectedId) group.classList.add("is-selected");
            group.style.animationDelay = `${Math.min(240, nodeViews.size * 8)}ms`;
            group.classList.add("is-entering");

            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute("cx", (node.x || 0).toFixed(1));
            circle.setAttribute("cy", (node.y || 0).toFixed(1));
            circle.setAttribute("r", radius.toFixed(1));
            circle.setAttribute("fill", nodeColor(node.year, low, high));
            group.appendChild(circle);

            let label: SVGTextElement | null = null;
            if (labels.has(node.id)) {
                label = document.createElementNS("http://www.w3.org/2000/svg", "text");
                label.setAttribute("x", (node.x || 0).toFixed(1));
                label.setAttribute("y", ((node.y || 0) + radius + 12).toFixed(1));
                label.setAttribute("text-anchor", "middle");
                label.classList.add("pz-graph-label");
                label.textContent = paperLabel(node);
                group.appendChild(label);
            }
            nodeLayer.appendChild(group);
            nodeViews.set(node.id, {group, circle, label, labelOffset: radius + 12});
        }

        canvasEl.appendChild(svg);
        applyTransform();
        requestAnimationFrame(() => {
            for (const view of nodeViews.values()) view.group.classList.remove("is-entering");
        });
        applyFocus();
    };

    const animatePositions = (
        starts: Map<string, {x: number; y: number}>,
        targets: Map<string, {x: number; y: number}>,
        duration = 420,
    ) => {
        if (!data) return;
        cancelAnimationFrame(animation);
        const startTime = performance.now();
        const tick = (now: number) => {
            const raw = Math.min(1, (now - startTime) / duration);
            const eased = 1 - Math.pow(1 - raw, 3);
            for (const node of data!.nodes) {
                const from = starts.get(node.id);
                const to = targets.get(node.id);
                if (!from || !to) continue;
                node.x = from.x + (to.x - from.x) * eased;
                node.y = from.y + (to.y - from.y) * eased;
            }
            syncAllPositions();
            if (raw < 1) animation = requestAnimationFrame(tick);
        };
        animation = requestAnimationFrame(tick);
    };

    const animateTransform = (targetZoom: number, targetPanX: number, targetPanY: number, duration = 200) => {
        cancelAnimationFrame(zoomAnimation);
        wheelTarget = targetZoom;
        const startZoom = zoom;
        const startX = panX;
        const startY = panY;
        const startTime = performance.now();
        const tick = (now: number) => {
            const raw = Math.min(1, (now - startTime) / duration);
            const eased = 1 - Math.pow(1 - raw, 3);
            zoom = startZoom + (targetZoom - startZoom) * eased;
            panX = startX + (targetPanX - startX) * eased;
            panY = startY + (targetPanY - startY) * eased;
            applyTransform();
            if (raw < 1) zoomAnimation = requestAnimationFrame(tick);
        };
        zoomAnimation = requestAnimationFrame(tick);
    };

    const fitView = () => {
        if (!data?.nodes.length) return;
        const xs = data.nodes.map(node => node.x || 0);
        const ys = data.nodes.map(node => node.y || 0);
        const pad = 60;
        const minX = Math.min(...xs) - pad;
        const maxX = Math.max(...xs) + pad;
        const minY = Math.min(...ys) - pad;
        const maxY = Math.max(...ys) + pad;
        const size = canvasSize();
        const nextZoom = Math.min(3, Math.max(0.4, Math.min(size.width / (maxX - minX), size.height / (maxY - minY))));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        animateTransform(nextZoom, size.width / 2 - cx * nextZoom, size.height / 2 - cy * nextZoom);
    };

    const renderSeedLine = () => {
        seedEl.innerHTML = data
            ? `<strong>${escapeHtml(shortTitle(data.seed.title, 64))}</strong><span>${data.seed.year || "?"} · 被引 ${data.seed.citations} · ${data.nodes.length} 个节点 · ${data.edges.length} 条连线</span>`
            : "";
    };

    const renderDetail = (node: GraphPaper | undefined) => {
        if (!node) {
            detailEl.innerHTML = `<div class="pz-graph-hint">点击节点查看详情</div>`;
            if (matrixButton) matrixButton.disabled = true;
            return;
        }
        if (matrixButton) matrixButton.disabled = false;
        const openIn: Array<{label: string; href: string}> = [];
        if (node.doi) openIn.push({label: "DOI", href: `https://doi.org/${node.doi}`});
        if (node.title) {
            openIn.push({label: "Semantic Scholar", href: `https://www.semanticscholar.org/search?q=${encodeURIComponent(node.title)}`});
            openIn.push({label: "Google Scholar", href: `https://scholar.google.com/scholar?q=${encodeURIComponent(node.title)}`});
        }
        if (node.id) openIn.push({label: "OpenAlex", href: `https://openalex.org/${node.id}`});
        detailEl.innerHTML = `
  <div class="pz-graph-detail-head">
    <div class="pz-graph-detail-title">${escapeHtml(node.title)}</div>
    <button class="pz-graph-dots" data-act="graph-detail-more" title="更多">⋯</button>
  </div>
  <div class="pz-graph-detail-meta">${escapeHtml(node.authors.join("; ") || "未知作者")}</div>
  <div class="pz-graph-detail-meta">${node.year || ""}${node.venue ? `${node.year ? ", " : ""}${escapeHtml(node.venue)}` : ""}</div>
  <div class="pz-graph-detail-stat-row">
    <span class="pz-graph-detail-stat">${node.citations.toLocaleString()} Citations</span>
    <button class="pz-graph-save" data-act="graph-matrix" title="保存到文献矩阵">🔖 保存</button>
  </div>
  <div class="pz-graph-openin">Open in:${openIn.map(link => `<a href="#" data-act="graph-external" data-href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("")}</div>
  ${node.abstract ? `<div class="pz-graph-abstract">${escapeHtml(node.abstract)}</div>` : ""}
  <div class="pz-graph-detail-actions">
    <button class="pz-graph-linkbtn" data-act="graph-reseed" data-id="${escapeHtml(node.id)}">🕸 Open graph</button>
    <button class="pz-graph-linkbtn" data-act="graph-add-origin" data-id="${escapeHtml(node.id)}">＋ Add origin</button>
  </div>`;
    };

    const renderSide = () => {
        if (!data) {
            sideEl.hidden = true;
            sideEl.innerHTML = "";
            return;
        }
        sideEl.hidden = false;
        const seed = data.seed;
        const rows = highlight === "prior"
            ? data.prior
            : highlight === "derivative"
                ? data.derivative
                : [...data.nodes]
                    .filter(node => node.relation !== "seed")
                    .sort((a, b) => b.citations - a.citations);
        sideEl.innerHTML = `
  <div class="pz-graph-list">
    <div class="pz-graph-origin${selectedId === seed.id ? " is-active" : ""}" data-node="${escapeHtml(seed.id)}">
      <div class="pz-graph-origin-label">Origin paper</div>
      <div class="pz-graph-origin-title">${escapeHtml(seed.title)}</div>
      <div class="pz-graph-origin-meta"><span>${escapeHtml(seed.authors.join(", ") || "")}</span><em>${seed.year || ""}</em></div>
    </div>
    ${rows.map(paper => `<div class="pz-graph-row${selectedId === paper.id ? " is-active" : ""}" data-node="${escapeHtml(paper.id)}">
      <div class="pz-graph-row-title">${escapeHtml(paper.title)}</div>
      <div class="pz-graph-row-meta"><span>${escapeHtml(paper.authors.slice(0, 3).join(", "))}</span><em>${paper.year || ""}</em></div>
    </div>`).join("")}
  </div>`;
    };

    const revealSelectedRow = () => {
        const row = sideEl.querySelector<HTMLElement>(`[data-node="${CSS.escape(selectedId)}"]`);
        if (!row) return;
        for (const previous of Array.from(sideEl.querySelectorAll(".is-active"))) previous.classList.remove("is-active");
        row.classList.add("is-active");
        row.scrollIntoView({block: "nearest"});
    };

    const syncSelection = () => {
        for (const [id, view] of nodeViews) view.group.classList.toggle("is-selected", id === selectedId);
        renderDetail(selectedId ? nodeById(selectedId) : undefined);
        revealSelectedRow();
    };

    const nodePassesFilter = (node: GraphPaper): boolean => {
        if (filters.from && (node.year || 0) < filters.from) return false;
        if (filters.to && (node.year || 0) > filters.to) return false;
        if (filters.minCitations && node.citations < filters.minCitations) return false;
        if (filters.hasDoi && !node.doi) return false;
        return true;
    };

    const relationRows = (): GraphPaper[] => {
        if (!data) return [];
        const rows = highlight === "prior"
            ? data.prior
            : highlight === "derivative"
                ? data.derivative
                : [...data.nodes].filter(node => node.relation !== "seed");
        return rows.filter(nodePassesFilter).sort((a, b) => b.citations - a.citations);
    };

    const applyGraphVisibility = () => {
        if (!data) return;
        const visible = new Set(relationRows().map(node => node.id));
        for (const [id, view] of nodeViews) {
            const node = nodeById(id);
            if (!node) continue;
            const filtered = !nodePassesFilter(node);
            const relationFiltered = Boolean(highlight) && !visible.has(id) && id !== data.seed.id;
            view.group.classList.toggle("is-filtered", filtered || relationFiltered);
        }
        filterCountEl.textContent = `${relationRows().length} / ${Math.max(0, data.nodes.length - 1)} 篇`;
    };

    let listSort: {key: "title" | "authors" | "year" | "citations" | "references" | "similarity"; dir: 1 | -1} = {key: "similarity", dir: -1};

    const renderListView = () => {
        if (!data) {
            listViewEl.hidden = true;
            return;
        }
        listViewEl.hidden = !listView;
        if (!listView) return;
        const seed = data.seed;
        const similarity = (node: GraphPaper): number => {
            if (node.id === seed.id) return 100;
            const edge = data!.edges.find(item => (item.from === seed.id && item.to === node.id) || (item.to === seed.id && item.from === node.id));
            return edge ? Math.round(edge.weight * 1000) / 10 : 0;
        };
        const rows = [seed, ...relationRows()].filter(nodePassesFilter);
        const value = (node: GraphPaper): string | number => {
            switch (listSort.key) {
                case "title": return node.title.toLowerCase();
                case "authors": return node.authors.join(", ").toLowerCase();
                case "year": return node.year || 0;
                case "citations": return node.citations;
                case "references": return node.refIds.length;
                default: return similarity(node);
            }
        };
        rows.sort((a, b) => {
            const av = value(a);
            const bv = value(b);
            return (av < bv ? -1 : av > bv ? 1 : 0) * listSort.dir;
        });
        const arrow = (key: string) => listSort.key === key ? (listSort.dir === 1 ? " ▲" : " ▼") : "";
        const th = (key: typeof listSort.key, label: string) => `<th data-sort="${key}">${escapeHtml(label)}${arrow(key)}</th>`;
        listViewEl.innerHTML = `<div class="pz-graph-listview-head">
  <div class="pz-graph-listview-title">List view</div>
  <button class="pz-graph-listview-btn" data-act="graph-list-download" title="下载 CSV">⭳ Download</button>
  <button class="pz-graph-listview-btn" data-act="graph-list-close" title="关闭列表视图">✕</button>
</div>
<table class="pz-graph-table">
  <thead><tr>${th("title", "Title")}${th("authors", "Authors")}${th("year", "Year")}${th("citations", "Citations")}${th("references", "References")}${th("similarity", "Similarity to origin")}</tr></thead>
  <tbody>${rows.map(node => `<tr data-node="${escapeHtml(node.id)}" class="${node.id === selectedId ? "is-active" : ""}">
    <td class="pz-graph-table-title">${escapeHtml(node.title)}</td>
    <td class="pz-graph-table-authors">${escapeHtml(node.authors.join(", "))}</td>
    <td class="pz-graph-table-num">${node.year || ""}</td>
    <td class="pz-graph-table-num">${node.citations}</td>
    <td class="pz-graph-table-num">${node.refIds.length}</td>
    <td class="pz-graph-table-num">${similarity(node) || ""}</td>
  </tr>`).join("")}</tbody>
</table>`;
    };
    const renderAll = () => {
        renderSeedLine();
        canvasEl.classList.toggle("has-data", Boolean(data));
        mainEl.classList.toggle("is-empty", !data);
        canvasEl.classList.toggle("is-list", listView && Boolean(data));
        windowEl.classList.toggle("is-list", listView && Boolean(data));
        priorButton.classList.toggle("is-active", highlight === "prior");
        derivativeButton.classList.toggle("is-active", highlight === "derivative");
        renderSide();
        renderListView();
        applyGraphVisibility();
        renderDetail(selectedId ? nodeById(selectedId) : undefined);
        if (data) {
            const low = minYear();
            const high = maxYear();
            scaleEl.hidden = false;
            scaleMinEl.textContent = String(low);
            scaleMaxEl.textContent = String(high);
            scaleBarEl.style.background = `linear-gradient(90deg, ${nodeColor(low, low, high)}, ${nodeColor(high, low, high)})`;
        } else {
            scaleEl.hidden = true;
        }
    };

    // ---- data loading ----------------------------------------------------

    const load = async (input: SeedInput) => {
        renderSeedLine();
        seedEl.textContent = "正在向 OpenAlex 请求文献网络…";
        data = null;
        selectedId = "";
        hoverId = "";
        tipEl.hidden = true;
        canvasEl.querySelector("svg")?.remove();
        canvasEl.classList.remove("has-data");
        mainEl.classList.add("is-empty");
        if (emptyEl) emptyEl.hidden = true;
        nodeViews.clear();
        edgeViews.length = 0;
        const cacheKey = `${(input.doi || "").toLowerCase()}|${(input.title || "").trim().toLowerCase()}`;
        const cachedGraph = graphCache.get(cacheKey);
        if (cachedGraph) {
            data = cachedGraph;
            selectedId = data.seed.id;
            zoom = 1;
            panX = 0;
            panY = 0;
            applyDialogSize(true);
            buildScene();
            renderAll();
            requestAnimationFrame(() => fitView());
            return;
        }
        const loading = document.createElement("div");
        loading.className = "pz-graph-loading";
        loading.textContent = "正在获取参考文献与引用关系…";
        canvasEl.appendChild(loading);
        try {
            data = await buildGraph(host.store.state.settings, input, canvasSize());
            graphCache.set(cacheKey, data);
            loading.remove();
            applyDialogSize(true);
            selectedId = data.seed.id;
            zoom = 1;
            panX = 0;
            panY = 0;
            buildScene();
            renderAll();
            requestAnimationFrame(() => fitView());
        } catch (error: any) {
            loading.className = "pz-graph-error";
            loading.textContent = error?.message || String(error);
            seedEl.textContent = "建立失败";
        }
    };

    const startForm = () => {
        data = null;
        selectedId = "";
        hoverId = "";
        highlight = "";
        canvasEl.classList.remove("has-data");
        canvasEl.querySelector("svg")?.remove();
        canvasEl.querySelector(".pz-graph-loading, .pz-graph-error")?.remove();
        seedEl.textContent = "输入 DOI 或标题开始";
        sideEl.hidden = true;
        mainEl.classList.add("is-empty");
        applyDialogSize(false);
        if (emptyEl) emptyEl.hidden = false;
        renderDetail(undefined);
        seedInput.focus();
    };

    const startFromInput = () => {
        const value = seedInput.value.trim();
        if (!value) {
            seedInput.focus();
            return;
        }
        const input: SeedInput = /^10\.\d{4,9}\//.test(value) || /^https?:\/\//.test(value) ? {doi: value} : {title: value};
        void load(input);
    };

    // Re-run the force layout when the dialog/canvas is resized, so the graph fills the space.
    let resizeTimer = 0;
    const resizeObserver = new ResizeObserver(() => {
        if (!data) return;
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            if (!data) return;
            const size = canvasSize();
            layoutGraph(data.nodes, data.edges, size);
            buildScene();
            applyTransform();
            fitView();
        }, 220);
    });
    resizeObserver.observe(canvasEl);

    const reseed = (node: GraphPaper) => {
        void load({doi: node.doi, title: node.title});
    };

    const expand = async (node: GraphPaper) => {
        if (!data || busy) return;
        busy = true;
        renderDetail(node);
        const starts = new Map<string, {x: number; y: number}>();
        for (const paper of data.nodes) starts.set(paper.id, {x: paper.x || 0, y: paper.y || 0});
        const result = await expandFromNode(host.store.state.settings, node);
        busy = false;
        if (result.error) {
            showMessage(`展开失败：${result.error}`, 4500, "error");
            renderDetail(node);
            return;
        }
        const existing = new Set(data.nodes.map(paper => paper.id));
        const fresh = result.papers.filter(paper => !existing.has(paper.id));
        if (!fresh.length) {
            showMessage("没有更多可展开的邻居", 2500);
            renderDetail(node);
            return;
        }
        const origin = starts.get(node.id) || {x: node.x || 0, y: node.y || 0};
        for (const paper of fresh) {
            paper.x = origin.x;
            paper.y = origin.y;
            starts.set(paper.id, {x: origin.x, y: origin.y});
        }
        for (const edge of result.edges) {
            if (existing.has(edge.from) && existing.has(edge.to)) continue;
            data.edges.push(edge);
        }
        data.nodes.push(...fresh);

        // Compute the new layout, remember where everything should end up, then put
        // the graph back where it was so buildScene() can animate into place.
        layoutGraph(data.nodes, data.edges, canvasSize());
        const targets = new Map<string, {x: number; y: number}>();
        for (const paper of data.nodes) targets.set(paper.id, {x: paper.x || 0, y: paper.y || 0});
        for (const paper of data.nodes) {
            const start = starts.get(paper.id);
            if (start) {
                paper.x = start.x;
                paper.y = start.y;
            }
        }
        buildScene();
        renderAll();
        animatePositions(starts, targets, 460);
        showMessage(`展开 ${fresh.length} 篇`, 2200);
    };

    const addToMatrix = () => {
        const node = nodeById(hoverId || selectedId);
        if (!node) return;
        const projects = host.store.state.matrixProjects;
        if (!projects.length) {
            showMessage("还没有文献矩阵项目，先打开文献矩阵新建一个", 3500);
            return;
        }
        const project = projects.find(item => item.id === host.store.state.matrixActiveProjectId) || projects[0];
        if (project.rows.some(row => row.itemKey === `openalex:${node.id}`)) {
            showMessage("这篇文献已经在矩阵里了", 2500);
            return;
        }
        project.rows.push({
            id: newId("mxrow"),
            libraryId: 0,
            itemKey: `openalex:${node.id}`,
            values: {
                title: node.title,
                authors: node.authors.join("; "),
                year: node.year ? String(node.year) : "",
                venue: node.venue || "",
                doi: node.doi || "",
            },
            lastZoteroSyncAt: Date.now(),
        });
        project.updatedAt = Date.now();
        void host.store.save();
        showMessage(`已加入「${project.name}」`, 2500);
    };

    const downloadFile = (name: string, text: string, mime = "text/plain") => {
        const blob = new Blob([text], {type: `${mime};charset=utf-8`});
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = name;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };

    const exportBibtex = () => {
        if (!data) return;
        downloadFile(`${citationKey(data.seed)}.bib`, data.nodes.map(node => bibtexFor(node)).join("\n\n"));
    };

    const exportCsv = () => {
        if (!data) return;
        const header = "title,authors,year,venue,citations,doi\n";
        const rows = data.nodes.map(node => [node.title, node.authors.join("; "), node.year || "", node.venue || "", node.citations, node.doi || ""]
            .map(value => `"${String(value).replace(/"/g, '""')}"`).join(","));
        downloadFile(`${citationKey(data.seed)}.csv`, header + rows.join("\n"), "text/csv");
    };

    const addOrigin = async (node: GraphPaper) => {
        if (!data || busy || originIds.has(node.id) || node.relation === "seed") return;
        originIds.add(node.id);
        node.relation = "origin";
        await expand(node);
        buildScene();
        renderAll();
        showMessage("已加入 origin", 1800);
    };

    const showMoreMenu = (x: number, y: number) => {
        openGraphMenu(x, y, [
            {label: "适应窗口", disabled: !data, action: () => fitView()},
            {label: "换一篇", action: () => startForm()},
            {label: "刷新图谱", disabled: !data, action: () => {
                if (data) void load({doi: data.seed.doi, title: data.seed.title});
            }},
            {label: "-"},
            {label: "导出 BibTeX", disabled: !data, action: exportBibtex},
            {label: "导出 CSV", disabled: !data, action: exportCsv},
            {label: "复制种子 DOI", disabled: !data?.seed.doi, action: () => {
                if (data?.seed.doi) void copyText(data.seed.doi, " DOI");
            }},
            {label: "在 Connected Papers 打开", disabled: !data?.seed.doi && !data?.seed.title, action: () => {
                if (!data) return;
                const query = data.seed.doi || data.seed.title;
                window.open(`https://www.connectedpapers.com/search?q=${encodeURIComponent(query)}`, "_blank");
            }},
        ]);
    };

    const showDetailMenu = (x: number, y: number, node: GraphPaper) => {
        openGraphMenu(x, y, [
            {label: "打开原文", action: () => void openOriginal(node)},
            {label: "展开邻居", action: () => void expand(node)},
            {label: "以此为种子", action: () => reseed(node)},
            {label: "Add origin", disabled: originIds.has(node.id) || node.relation === "seed", action: () => void addOrigin(node)},
            {label: "-"},
            {label: "复制", children: [
                {label: "复制标题", action: () => void copyText(node.title, "标题")},
                {label: "复制 DOI", disabled: !node.doi, action: () => void copyText(node.doi || "", " DOI")},
                {label: "复制作者", action: () => void copyText(node.authors.join("; "), "作者")},
                {label: "复制 BibTeX", action: () => void copyText(bibtexFor(node), " BibTeX")},
            ]},
        ]);
    };

    // ---- interaction -----------------------------------------------------

    const moveTip = (event: PointerEvent, node: GraphPaper) => {
        const rect = canvasEl.getBoundingClientRect();
        tipEl.innerHTML = `<strong>${escapeHtml(shortTitle(node.title, 46))}</strong><span>${node.year || "?"} · 被引 ${node.citations}${node.venue ? ` · ${escapeHtml(node.venue)}` : ""}</span>`;
        const x = event.clientX - rect.left + 14;
        const y = event.clientY - rect.top + 14;
        tipEl.style.transform = `translate(${Math.min(rect.width - 240, Math.max(8, x))}px, ${Math.min(rect.height - 70, Math.max(8, y))}px)`;
        tipEl.hidden = false;
    };

    const copyText = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text);
            showMessage(`已复制${label}`, 1500);
        } catch {
            showMessage("复制失败", 2500, "error");
        }
    };

    const closeGraphMenu = () => document.querySelectorAll(".pz-graph-menu").forEach(element => element.remove());

    interface GraphMenuItem {
        label: string;
        action?: () => void;
        disabled?: boolean;
        children?: GraphMenuItem[];
    }

    const openGraphMenu = (x: number, y: number, items: GraphMenuItem[]) => {
        closeGraphMenu();
        const menu = document.createElement("div");
        menu.className = "pz-graph-menu";
        const renderItems = (list: GraphMenuItem[], parentPath: string): string => list.map((item, index) => {
            const path = parentPath ? `${parentPath}.${index}` : String(index);
            if (item.label === "-") return `<div class="pz-graph-menu-sep"></div>`;
            if (item.children?.length) {
                return `<div class="pz-graph-menu-item"><button data-graph-menu-path="${path}">${escapeHtml(item.label)} ▸</button><div class="pz-graph-submenu">${renderItems(item.children, path)}</div></div>`;
            }
            return `<button data-graph-menu-path="${path}" ${item.disabled ? "disabled" : ""}>${escapeHtml(item.label)}</button>`;
        }).join("");
        const resolve = (path: string): GraphMenuItem | undefined => {
            let list = items;
            let found: GraphMenuItem | undefined;
            for (const part of path.split(".")) {
                found = list[Number(part)];
                if (!found) return undefined;
                list = found.children || [];
            }
            return found;
        };
        menu.innerHTML = renderItems(items, "");
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`;
        menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`;
        menu.addEventListener("click", event => {
            const button = (event.target as HTMLElement).closest<HTMLElement>("[data-graph-menu-path]");
            if (!button) return;
            const item = resolve(button.dataset.graphMenuPath || "");
            if (!item || item.children?.length) return;
            closeGraphMenu();
            item.action?.();
        });
        const onPointerDown = (event: PointerEvent) => {
            if ((event.target as HTMLElement)?.closest?.(".pz-graph-menu")) return;
            closeGraphMenu();
            document.removeEventListener("pointerdown", onPointerDown, true);
        };
        window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown, true), 0);
    };
    const showGraphMenu = (x: number, y: number, node: GraphPaper) => {
        openGraphMenu(x, y, [
            {label: "在右侧查看详情", action: () => {
                selectedId = node.id;
                syncSelection();
                applyFocus();
            }},
            {label: "打开原文", action: () => void openOriginal(node)},
            {label: "展开邻居", action: () => void expand(node)},
            {label: "以此为种子", action: () => reseed(node)},
            {label: originIds.has(node.id) ? "已是 origin" : "Add origin", disabled: originIds.has(node.id) || node.relation === "seed", action: () => void addOrigin(node)},
            {label: "-"},
            {label: "复制", children: [
                {label: "复制标题", action: () => void copyText(node.title, "标题")},
                {label: "复制 DOI", disabled: !node.doi, action: () => void copyText(node.doi || "", " DOI")},
                {label: "复制作者", action: () => void copyText(node.authors.join("; "), "作者")},
                {label: "复制 BibTeX", action: () => void copyText(bibtexFor(node), " BibTeX")},
            ]},
        ]);
    };

    let graphMenuAt = 0;
    const handleGraphContextMenu = (event: MouseEvent): void => {
        if (!root.isConnected) return;
        const targetEl = event.target as HTMLElement;
        if (!targetEl || !root.contains(targetEl)) return;
        const nodeEl = targetEl.closest<HTMLElement>("[data-node]");
        const node = nodeEl ? nodeById(nodeEl.dataset.node || "") : undefined;
        if (!node) return;
        if (Date.now() - graphMenuAt < 200) return;
        graphMenuAt = Date.now();
        event.preventDefault();
        event.stopPropagation();
        showGraphMenu(event.clientX, event.clientY, node);
    };
    window.addEventListener("contextmenu", handleGraphContextMenu, true);
    window.addEventListener("mousedown", event => {
        if (event.button === 2) handleGraphContextMenu(event);
    }, true);
    sideEl.addEventListener("dblclick", event => {
        const row = (event.target as HTMLElement).closest<HTMLElement>("[data-node]");
        const node = row ? nodeById(row.dataset.node || "") : undefined;
        if (node) void openOriginal(node);
    });
    listViewEl.addEventListener("click", event => {
        const header = (event.target as HTMLElement).closest<HTMLElement>("th[data-sort]");
        if (header) {
            const key = header.dataset.sort as typeof listSort.key;
            listSort = {key, dir: listSort.key === key ? (listSort.dir === 1 ? -1 : 1) : (key === "title" || key === "authors" ? 1 : -1)};
            renderListView();
            return;
        }
        const row = (event.target as HTMLElement).closest<HTMLElement>("tr[data-node]");
        if (!row) return;
        selectedId = row.dataset.node || "";
        syncSelection();
        for (const previous of Array.from(listViewEl.querySelectorAll(".is-active"))) previous.classList.remove("is-active");
        row.classList.add("is-active");
    });
    listViewEl.addEventListener("dblclick", event => {
        const row = (event.target as HTMLElement).closest<HTMLElement>("tr[data-node]");
        const node = row ? nodeById(row.dataset.node || "") : undefined;
        if (node) void openOriginal(node);
    });
    sideEl.addEventListener("pointerover", event => {
        const row = (event.target as HTMLElement).closest<HTMLElement>("[data-node]");
        if (!row) return;
        if (row.dataset.node === hoverId) return;
        hoverId = row.dataset.node || "";
        applyFocus();
    });
    sideEl.addEventListener("pointerout", event => {
        const row = (event.target as HTMLElement).closest<HTMLElement>("[data-node]");
        if (!row) return;
        if ((event.relatedTarget as HTMLElement)?.closest?.("[data-node]") === row) return;
        if (hoverId === row.dataset.node) {
            hoverId = "";
            applyFocus();
        }
    });
    listViewEl.addEventListener("pointerover", event => {
        const row = (event.target as HTMLElement).closest<HTMLElement>("tr[data-node]");
        if (!row || row.dataset.node === hoverId) return;
        hoverId = row.dataset.node || "";
        applyFocus();
    });
    listViewEl.addEventListener("pointerout", event => {
        const row = (event.target as HTMLElement).closest<HTMLElement>("tr[data-node]");
        if (!row) return;
        if ((event.relatedTarget as HTMLElement)?.closest?.("tr[data-node]") === row) return;
        if (hoverId === row.dataset.node) {
            hoverId = "";
            applyFocus();
        }
    });
    seedInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            startFromInput();
        }
    });

    root.addEventListener("click", async event => {
        if (dragMoved) {
            dragMoved = false;
            return;
        }
        const target = event.target as HTMLElement;
        const action = target.closest<HTMLElement>("[data-act]")?.dataset.act;
        if (action === "graph-close") {
            closeGraph();
            return;
        }
        if (action === "graph-list-close") {
            listView = false;
            renderAll();
            return;
        }
        if (action === "graph-list-download") {
            exportCsv();
            return;
        }
        if (action === "graph-start") {
            startFromInput();
            return;
        }
        if (action === "graph-new-seed") {
            startForm();
            return;
        }
        if (action === "graph-list-view") {
            listView = !listView;
            renderAll();
            return;
        }
        if (action === "graph-filters") {
            filtersEl.hidden = !filtersEl.hidden;
            filterYearFrom.value = filters.from ? String(filters.from) : "";
            filterYearTo.value = filters.to ? String(filters.to) : "";
            filterMinCitations.value = filters.minCitations ? String(filters.minCitations) : "";
            filterHasDoi.checked = filters.hasDoi;
            return;
        }
        if (action === "graph-more") {
            showMoreMenu(event.clientX, event.clientY);
            return;
        }
        if (action === "graph-filter-apply") {
            filters = {
                from: Number(filterYearFrom.value) || 0,
                to: Number(filterYearTo.value) || 0,
                minCitations: Math.max(0, Number(filterMinCitations.value) || 0),
                hasDoi: filterHasDoi.checked,
            };
            filtersEl.hidden = true;
            renderAll();
            return;
        }
        if (action === "graph-filter-reset") {
            filters = {from: 0, to: 0, minCitations: 0, hasDoi: false};
            filterYearFrom.value = "";
            filterYearTo.value = "";
            filterMinCitations.value = "";
            filterHasDoi.checked = false;
            renderAll();
            return;
        }
        if (action === "graph-add-origin") {
            const node = nodeById(target.closest<HTMLElement>("[data-id]")?.dataset.id || selectedId);
            if (node) void addOrigin(node);
            return;
        }
        if (action === "graph-detail-more") {
            const node = nodeById(selectedId);
            if (node) showDetailMenu(event.clientX, event.clientY, node);
            return;
        }
        if (action === "graph-external") {
            event.preventDefault();
            const href = target.closest<HTMLElement>("[data-href]")?.dataset.href || "";
            if (href) window.open(href, "_blank");
            return;
        }
        if (action === "graph-prior" || action === "graph-derivative") {
            const next = action === "graph-prior" ? "prior" : "derivative";
            highlight = highlight === next ? "" : next;
            selectedId = "";
            renderAll();
            applyFocus();
            return;
        }
        if (action === "graph-fit") {
            fitView();
            return;
        }
        if (action === "graph-zoom-in" || action === "graph-zoom-out") {
            const factor = action === "graph-zoom-in" ? 1.25 : 0.8;
            animateTransform(Math.min(3, Math.max(0.4, zoom * factor)), panX, panY);
            return;
        }
        if (action === "graph-matrix") {
            addToMatrix();
            return;
        }
        if (action === "graph-open") {
            const node = nodeById(target.closest<HTMLElement>("[data-id]")?.dataset.id || "");
            if (node) await openOriginal(node);
            return;
        }
        if (action === "graph-open-doi") {
            const doi = target.closest<HTMLElement>("[data-doi]")?.dataset.doi || "";
            if (doi) window.open(`https://doi.org/${doi}`, "_blank");
            return;
        }
        if (action === "graph-reseed") {
            const node = nodeById(target.closest<HTMLElement>("[data-id]")?.dataset.id || "");
            if (node) reseed(node);
            return;
        }
        if (action === "graph-expand") {
            const node = nodeById(target.closest<HTMLElement>("[data-id]")?.dataset.id || "");
            if (node) void expand(node);
            return;
        }
        const sideRow = target.closest<HTMLElement>(".pz-graph-row[data-node], .pz-graph-origin[data-node]");
        if (sideRow) {
            selectedId = sideRow.dataset.node || "";
            syncSelection();
            applyFocus();
            return;
        }
        const nodeEl = target.closest<SVGGElement>(".pz-graph-node[data-node]");
        if (nodeEl) {
            selectedId = nodeEl.dataset.node || "";
            syncSelection();
            applyFocus();
        }
    });

    root.addEventListener("dblclick", event => {
        const nodeEl = (event.target as HTMLElement).closest<SVGGElement>(".pz-graph-node[data-node]");
        const node = nodeEl ? nodeById(nodeEl.dataset.node || "") : undefined;
        if (node) void openOriginal(node);
    });

    canvasEl.addEventListener("pointerover", event => {
        const nodeEl = (event.target as HTMLElement).closest<SVGGElement>(".pz-graph-node[data-node]");
        const id = nodeEl?.dataset.node || "";
        if (id === hoverId) return;
        hoverId = id;
        const node = id ? nodeById(id) : undefined;
        if (!node) {
            tipEl.hidden = true;
            applyFocus();
            renderDetailForFocus();
            return;
        }
        moveTip(event, node);
        applyFocus();
        renderDetailForFocus();
    });

    canvasEl.addEventListener("pointermove", event => {
        if (dragNodeId) {
            if (!dragMoved) dragMoved = true;
            const node = nodeById(dragNodeId);
            if (node) {
                const scale = zoom || 1;
                node.x = dragStart.nodeX + (event.clientX - dragStart.x) / scale;
                node.y = dragStart.nodeY + (event.clientY - dragStart.y) / scale;
                syncNodePosition(node);
            }
            return;
        }
        if (dragging) {
            panX = dragStart.panX + (event.clientX - dragStart.x);
            panY = dragStart.panY + (event.clientY - dragStart.y);
            applyTransform();
            return;
        }
        if (hoverId) {
            const node = nodeById(hoverId);
            if (node) moveTip(event, node);
        }
    });

    canvasEl.addEventListener("pointerout", event => {
        if ((event.relatedTarget as HTMLElement)?.closest?.(".pz-graph-node[data-node]")) return;
        if (!(event.target as HTMLElement).closest?.(".pz-graph-node[data-node]")) return;
        hoverId = "";
        tipEl.hidden = true;
        applyFocus();
    });

    canvasEl.addEventListener("mouseleave", () => {
        hoverId = "";
        tipEl.hidden = true;
        applyFocus();
        renderDetailForFocus();
    });

    canvasEl.addEventListener("pointerdown", event => {
        // The start card / list view are UI, not canvas surface: never treat them as a pan drag,
        // otherwise a 1px mouse move swallows the click and the button appears dead.
        const target = event.target as HTMLElement;
        if (target.closest(".pz-graph-start-overlay, .pz-graph-listview, .pz-graph-zoom, .pz-graph-scale")) return;
        const nodeEl = (event.target as HTMLElement).closest<SVGGElement>(".pz-graph-node[data-node]");
        if (nodeEl) {
            const node = nodeById(nodeEl.dataset.node || "");
            if (!node) return;
            dragNodeId = node.id;
            dragMoved = false;
            dragStart = {x: event.clientX, y: event.clientY, panX, panY, nodeX: node.x || 0, nodeY: node.y || 0};
            canvasEl.setPointerCapture(event.pointerId);
            return;
        }
        dragging = true;
        dragMoved = false;
        dragStart = {x: event.clientX, y: event.clientY, panX, panY, nodeX: 0, nodeY: 0};
        canvasEl.classList.add("is-panning");
        canvasEl.setPointerCapture(event.pointerId);
    });

    canvasEl.addEventListener("pointerup", () => {
        dragging = false;
        dragNodeId = "";
        canvasEl.classList.remove("is-panning");
    });

    let wheelTarget = 1;
    let wheelFrame = 0;
    const wheelAnchor = {x: 0, y: 0};
    const tickWheelZoom = () => {
        const diff = wheelTarget - zoom;
        if (Math.abs(diff) < 0.0015) {
            zoom = wheelTarget;
            applyTransform();
            wheelFrame = 0;
            return;
        }
        const previous = zoom;
        zoom += diff * 0.28;
        const ratio = zoom / previous;
        panX = wheelAnchor.x - (wheelAnchor.x - panX) * ratio;
        panY = wheelAnchor.y - (wheelAnchor.y - panY) * ratio;
        applyTransform();
        wheelFrame = requestAnimationFrame(tickWheelZoom);
    };
    canvasEl.addEventListener("wheel", event => {
        event.preventDefault();
        const rect = canvasEl.getBoundingClientRect();
        wheelAnchor.x = event.clientX - rect.left;
        wheelAnchor.y = event.clientY - rect.top;
        const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        wheelTarget = Math.min(3, Math.max(0.4, wheelTarget * Math.exp(-delta * 0.0018)));
        if (!wheelFrame) wheelFrame = requestAnimationFrame(tickWheelZoom);
    }, {passive: false});

    if (seed.doi || seed.title) void load(seed);
    else startForm();

}
