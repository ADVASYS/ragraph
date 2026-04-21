import log from "electron-log/main.js";
import type { GraphStore, NodeRecord } from "../storage/GraphStore";
import type { VectorStore } from "../storage/VectorStore";

export interface ConsolidationOptions {
  entityMergeThreshold?: number;
  topicMergeThreshold?: number;
  similarDocMinEntityOverlap?: number;
}

export interface ConsolidationProgress {
  universeId: string;
  phase: "entity_merge" | "topic_cluster" | "similar_docs" | "centrality" | "housekeeping" | "done" | "error";
  percent: number;
  merged?: number;
  clustered?: number;
  similar?: number;
  message?: string;
}

const DEFAULTS: Required<ConsolidationOptions> = {
  entityMergeThreshold: 0.95,
  topicMergeThreshold: 0.85,
  similarDocMinEntityOverlap: 3,
};

/**
 * Background job that consolidates the knowledge graph once enough documents
 * have accumulated. The consolidator:
 *
 *  1. Agglomerative-clusters entities per type via cosine similarity and
 *     merges alias clusters into a single canonical node.
 *  2. Agglomerative-clusters topics and creates PART_OF edges into the
 *     chosen canonical super-topic.
 *  3. Links documents with >= N shared entities via SIMILAR_TO (unless they
 *     already reference each other).
 *  4. Recomputes degree centrality for every node.
 *  5. Deletes orphan chunks.
 *
 * The job is purely core: it depends only on `GraphStore`, `VectorStore` and
 * a progress callback. An AbortSignal lets the caller cancel mid-flight.
 */
export class GraphConsolidator {
  private readonly options: Required<ConsolidationOptions>;

  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorStore,
    options: ConsolidationOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  async run(
    universeId: string,
    onProgress?: (p: ConsolidationProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const started = Date.now();
    const emit = (p: ConsolidationProgress) => onProgress?.({ ...p, universeId });
    try {
      emit({ universeId, phase: "entity_merge", percent: 5 });
      const merged = await this.mergeEntities(signal);
      emit({ universeId, phase: "entity_merge", percent: 30, merged });

      emit({ universeId, phase: "topic_cluster", percent: 35 });
      const clustered = await this.clusterTopics(signal);
      emit({ universeId, phase: "topic_cluster", percent: 55, clustered });

      emit({ universeId, phase: "similar_docs", percent: 60 });
      const similar = await this.linkSimilarDocs(signal);
      emit({ universeId, phase: "similar_docs", percent: 75, similar });

      emit({ universeId, phase: "centrality", percent: 80 });
      await this.graph.recomputeCentrality();
      emit({ universeId, phase: "centrality", percent: 90 });

      emit({ universeId, phase: "housekeeping", percent: 92 });
      await this.cleanupOrphans();
      emit({ universeId, phase: "housekeeping", percent: 98 });

      emit({ universeId, phase: "done", percent: 100, merged, clustered, similar });
      log.info("consolidate.done", { universeId, ms: Date.now() - started, merged, clustered, similar });
    } catch (err) {
      const message = (err as Error).message || String(err);
      emit({ universeId, phase: "error", percent: 0, message });
      log.error("consolidate.failed", { universeId, err: message });
      throw err;
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("consolidation aborted");
  }

  private async mergeEntities(signal?: AbortSignal): Promise<number> {
    // Group by entity type, cluster via single-link agglomerative merging.
    const byType = await this.collectEntitiesByType();
    let mergedCount = 0;
    for (const [type, nodes] of byType.entries()) {
      this.throwIfAborted(signal);
      if (nodes.length < 2) continue;
      const vectors = await this.fetchVectorsFor(nodes.map((n) => n.id));
      const clusters = singleLinkClusters(
        nodes.map((n) => ({ id: n.id, degree: deriveDegree(n) })),
        (a, b) => {
          const va = vectors.get(a) ?? [];
          const vb = vectors.get(b) ?? [];
          if (va.length === 0 || vb.length === 0) return 0;
          return cosine(va, vb);
        },
        this.options.entityMergeThreshold,
      );

      for (const cluster of clusters) {
        if (cluster.length < 2) continue;
        this.throwIfAborted(signal);
        const canonical = chooseCanonical(cluster);
        for (const other of cluster) {
          if (other.id === canonical.id) continue;
          await this.graph.mergeNode(other.id, canonical.id);
          await this.vectors.rewriteSourceId(other.id, canonical.id);
          mergedCount += 1;
        }
        const aliasSet = new Set<string>();
        for (const m of cluster) {
          const node = await this.graph.getNode(m.id);
          const name = (node?.props as { name?: string } | undefined)?.name;
          if (name) aliasSet.add(name);
          const aliases = Array.isArray((node?.props as { aliases?: string[] } | undefined)?.aliases)
            ? ((node?.props as { aliases?: string[] } | undefined)?.aliases ?? [])
            : [];
          for (const a of aliases) aliasSet.add(a);
        }
        await this.graph.updateNodeProps(canonical.id, { aliases: Array.from(aliasSet).slice(0, 20) });
      }
      void type;
    }
    return mergedCount;
  }

  private async collectEntitiesByType(): Promise<Map<string, NodeRecord<"Entity">[]>> {
    const out = new Map<string, NodeRecord<"Entity">[]>();
    const entities = await this.graph.listEntities(5000);
    for (const e of entities) {
      const node = await this.graph.getNode(e.id);
      if (!node || node.type !== "Entity") continue;
      const type = (node.props as { type?: string }).type ?? "other";
      if (!out.has(type)) out.set(type, []);
      out.get(type)!.push(node as NodeRecord<"Entity">);
    }
    return out;
  }

  private async fetchVectorsFor(sourceIds: string[]): Promise<Map<string, number[]>> {
    const lookup = await this.vectors.getBySourceIds(sourceIds);
    const out = new Map<string, number[]>();
    for (const [sid, rec] of lookup.entries()) out.set(sid, rec.vector);
    return out;
  }

  private async clusterTopics(signal?: AbortSignal): Promise<number> {
    const topics = await this.graph.listAllTopics();
    if (topics.length < 2) return 0;
    const vectors = await this.fetchVectorsFor(topics.map((t) => t.id));
    const clusters = singleLinkClusters(
      topics.map((t) => ({ id: t.id, degree: 0 })),
      (a, b) => {
        const va = vectors.get(a) ?? [];
        const vb = vectors.get(b) ?? [];
        if (va.length === 0 || vb.length === 0) return 0;
        return cosine(va, vb);
      },
      this.options.topicMergeThreshold,
    );
    let created = 0;
    for (const cluster of clusters) {
      this.throwIfAborted(signal);
      if (cluster.length < 2) continue;
      const canonical = chooseCanonical(cluster);
      for (const other of cluster) {
        if (other.id === canonical.id) continue;
        // Conservative: create a PART_OF edge rather than merging — topics
        // carry semantic weight and aliasing them would hide structure.
        this.graph.db
          .prepare(
            `INSERT OR IGNORE INTO edges (rel, src, dst, props_json) VALUES ('PART_OF', ?, ?, ?)`,
          )
          .run(other.id, canonical.id, JSON.stringify({ source: "consolidator" }));
        created += 1;
      }
    }
    return created;
  }

  private async linkSimilarDocs(signal?: AbortSignal): Promise<number> {
    this.throwIfAborted(signal);
    const min = this.options.similarDocMinEntityOverlap;
    // Pairs of documents sharing at least N entities, without an existing
    // REFERENCES_DOC in either direction.
    const rows = this.graph.db
      .prepare(
        `SELECT d1.id AS a, d2.id AS b, COUNT(DISTINCT e1.dst) AS overlap
         FROM edges e1
         JOIN edges e2 ON e1.dst = e2.dst AND e1.rel = 'MENTIONS' AND e2.rel = 'MENTIONS' AND e1.src < e2.src
         JOIN nodes d1 ON d1.id = e1.src AND d1.type = 'Document'
         JOIN nodes d2 ON d2.id = e2.src AND d2.type = 'Document'
         GROUP BY e1.src, e2.src
         HAVING overlap >= ?`,
      )
      .all(min) as { a: string; b: string; overlap: number }[];

    const existingRef = this.graph.db.prepare(
      `SELECT 1 FROM edges WHERE rel = 'REFERENCES_DOC' AND ((src = ? AND dst = ?) OR (src = ? AND dst = ?))`,
    );
    const ins = this.graph.db.prepare(
      `INSERT OR IGNORE INTO edges (rel, src, dst, props_json) VALUES ('SIMILAR_TO', ?, ?, ?)`,
    );
    let count = 0;
    for (const r of rows) {
      const hasRef = existingRef.get(r.a, r.b, r.b, r.a);
      if (hasRef) continue;
      ins.run(r.a, r.b, JSON.stringify({ overlap: r.overlap }));
      count += 1;
    }
    return count;
  }

  private async cleanupOrphans(): Promise<void> {
    // Drop Chunk nodes that have no parent Document (CONTAINS edge inbound).
    this.graph.db
      .prepare(
        `DELETE FROM nodes WHERE type = 'Chunk'
         AND id NOT IN (SELECT dst FROM edges WHERE rel = 'CONTAINS')`,
      )
      .run();
  }
}

function chooseCanonical<T extends { id: string; degree: number }>(cluster: T[]): T {
  let best = cluster[0];
  for (const c of cluster) {
    if (c.degree > best.degree) best = c;
    else if (c.degree === best.degree && c.id < best.id) best = c;
  }
  return best;
}

function deriveDegree(node: NodeRecord): number {
  const c = (node.props as { centrality?: number }).centrality;
  return typeof c === "number" ? c : 0;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Single-link agglomerative clustering at a fixed similarity cut. O(n^2) but
 * fine for the node counts we realistically see per universe (<= few thousand
 * entities).
 */
function singleLinkClusters<T extends { id: string; degree: number }>(
  items: T[],
  similarity: (a: string, b: string) => number,
  threshold: number,
): T[][] {
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = i;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent.set(ri, rj);
  };
  for (let i = 0; i < items.length; i++) parent.set(i, i);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (similarity(items[i].id, items[j].id) >= threshold) {
        union(i, j);
      }
    }
  }
  const groups = new Map<number, T[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(items[i]);
  }
  return Array.from(groups.values());
}
