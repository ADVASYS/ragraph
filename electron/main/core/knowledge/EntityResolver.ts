import type { GraphStore, EntityInput, TopicInput } from "../storage/GraphStore";
import type { VectorStore, VectorRecord } from "../storage/VectorStore";
import type { Embedder } from "../providers/Embedder";

export interface ResolverOptions {
  entityMergeThreshold?: number;
  topicMergeThreshold?: number;
}

export interface ResolvedEntity extends EntityInput {
  id: string;
  /** True when the resolver merged this input into an existing node. */
  merged: boolean;
  /** Existing aliases carried over from the merged node. */
  aliases: string[];
}

export interface ResolvedTopic extends TopicInput {
  id: string;
  merged: boolean;
}

export interface ResolutionResult {
  entities: ResolvedEntity[];
  topics: ResolvedTopic[];
  /** New vector records that should be upserted into the VectorStore. */
  newVectorRecords: VectorRecord[];
  /** Existing entity vector ids that received a running-mean embedding update. */
  updatedVectorRecords: VectorRecord[];
}

const DEFAULTS: Required<ResolverOptions> = {
  entityMergeThreshold: 0.92,
  topicMergeThreshold: 0.9,
};

/**
 * Pure, framework-independent knowledge-graph resolver. Given raw analyzer
 * output, it decides whether each entity/topic should merge into an existing
 * canonical node or become a fresh one — based on cosine similarity of the
 * embedding over `type: name. description`. Aliases accumulate on the
 * canonical node; the embedding is updated via a running mean so the canonical
 * vector drifts toward the centroid of its surface forms.
 *
 * The resolver never writes to SQLite or LanceDB directly; it returns the
 * intended `entities`, `topics` and vector-record mutations, and the caller
 * (IngestionPipeline) decides when to persist.
 */
export class EntityResolver {
  private readonly options: Required<ResolverOptions>;

  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorStore,
    private readonly embedder: Embedder,
    private readonly universeId: string,
    options: ResolverOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  async resolve(
    entities: EntityInput[],
    topics: (TopicInput | string)[],
  ): Promise<ResolutionResult> {
    const topicsNormalized: TopicInput[] = topics.map((t) =>
      typeof t === "string" ? { name: t, description: "" } : t,
    );

    const resolvedEntities: ResolvedEntity[] = [];
    const resolvedTopics: ResolvedTopic[] = [];
    const newVectorRecords: VectorRecord[] = [];
    const updatedVectorRecords: VectorRecord[] = [];

    // Entities ---------------------------------------------------------------
    if (entities.length > 0) {
      const texts = entities.map((e) => buildEntityText(e));
      const vectors = await this.embedder.embed(texts, "passage");
      for (let i = 0; i < entities.length; i++) {
        const input = entities[i];
        const vec = vectors[i];
        const canonicalFallbackId = `ent:${slug(input.type)}:${slug(input.name)}`;
        const candidates = await this.vectors.search(
          vec,
          5,
          { kind: "entity", entityType: input.type },
          { includeVector: true },
        );
        const best = candidates[0];
        if (best && best.score >= this.options.entityMergeThreshold && best.source_id !== canonicalFallbackId) {
          const mergedAliases = mergeAliases([...(best.keywords ?? []), input.name, best.title]);
          resolvedEntities.push({
            id: best.source_id,
            name: best.title || input.name,
            type: input.type,
            description: input.description ?? best.text,
            merged: true,
            aliases: mergedAliases,
          });
          const updated = runningMean(best.vector, vec, /* weightNew */ 0.4);
          updatedVectorRecords.push({
            ...rebuildVectorRecord(best, this.universeId),
            vector: updated,
            keywords: mergedAliases,
            text: input.description ?? best.text,
          });
        } else {
          resolvedEntities.push({
            id: canonicalFallbackId,
            name: input.name,
            type: input.type,
            description: input.description ?? "",
            merged: false,
            aliases: [input.name],
          });
          newVectorRecords.push(buildEntityVectorRecord({
            id: canonicalFallbackId,
            name: input.name,
            type: input.type,
            description: input.description ?? "",
            vector: vec,
            universeId: this.universeId,
            aliases: [input.name],
          }));
        }
      }
    }

    // Topics -----------------------------------------------------------------
    if (topicsNormalized.length > 0) {
      const texts = topicsNormalized.map((t) => `${t.name}. ${t.description ?? ""}`);
      const vectors = await this.embedder.embed(texts, "passage");
      for (let i = 0; i < topicsNormalized.length; i++) {
        const input = topicsNormalized[i];
        const vec = vectors[i];
        const fallbackId = `top:${slug(input.name)}`;
        const candidates = await this.vectors.search(
          vec,
          5,
          { kind: "topic" },
          { includeVector: true },
        );
        const best = candidates[0];
        if (best && best.score >= this.options.topicMergeThreshold && best.source_id !== fallbackId) {
          resolvedTopics.push({
            id: best.source_id,
            name: best.title || input.name,
            description: input.description ?? best.text,
            merged: true,
          });
          const updated = runningMean(best.vector, vec, 0.4);
          updatedVectorRecords.push({
            ...rebuildVectorRecord(best, this.universeId),
            vector: updated,
            text: input.description ?? best.text,
          });
        } else {
          resolvedTopics.push({
            id: fallbackId,
            name: input.name,
            description: input.description ?? "",
            merged: false,
          });
          newVectorRecords.push(buildTopicVectorRecord({
            id: fallbackId,
            name: input.name,
            description: input.description ?? "",
            vector: vec,
            universeId: this.universeId,
          }));
        }
      }
    }

    return { entities: resolvedEntities, topics: resolvedTopics, newVectorRecords, updatedVectorRecords };
  }

  /**
   * Sync FTS entries for resolver-written entity/topic records. Called by the
   * IngestionPipeline after writeAnalysis to keep BM25 in lockstep with the
   * semantic index.
   */
  async syncFts(result: ResolutionResult): Promise<void> {
    const all = [...result.newVectorRecords, ...result.updatedVectorRecords];
    for (const r of all) {
      if (r.kind !== "entity" && r.kind !== "topic") continue;
      await this.graph.upsertNodeFts({
        sourceId: r.source_id,
        kind: r.kind,
        title: r.title,
        text: r.text,
      });
    }
  }
}

function buildEntityText(e: EntityInput): string {
  const desc = e.description?.trim() ?? "";
  return `${e.type}: ${e.name}. ${desc}`.trim();
}

function buildEntityVectorRecord(input: {
  id: string;
  name: string;
  type: string;
  description: string;
  vector: number[];
  universeId: string;
  aliases: string[];
}): VectorRecord {
  return {
    id: vectorIdFor(input.id, "entity"),
    kind: "entity",
    source_id: input.id,
    universe_id: input.universeId,
    title: input.name,
    text: input.description,
    vector: input.vector,
    // Use `keywords` to stash aliases so FTS and sample paths can cheaply
    // surface them without a graph-node join.
    keywords: input.aliases,
    domain: input.type,
    topics: [],
    graph_node_id: input.id,
    file_id: "",
    created_at: Date.now(),
  };
}

function buildTopicVectorRecord(input: {
  id: string;
  name: string;
  description: string;
  vector: number[];
  universeId: string;
}): VectorRecord {
  return {
    id: vectorIdFor(input.id, "topic"),
    kind: "topic",
    source_id: input.id,
    universe_id: input.universeId,
    title: input.name,
    text: input.description,
    vector: input.vector,
    keywords: [],
    domain: "",
    topics: [],
    graph_node_id: input.id,
    file_id: "",
    created_at: Date.now(),
  };
}

function rebuildVectorRecord(hit: { vector: number[]; source_id: string; universe_id: string; title: string; text: string; kind: VectorRecord["kind"]; keywords: string[]; domain: string; topics: string[]; graph_node_id: string; file_id: string; created_at: number }, universeId: string): VectorRecord {
  return {
    id: vectorIdFor(hit.source_id, hit.kind),
    kind: hit.kind,
    source_id: hit.source_id,
    universe_id: hit.universe_id || universeId,
    title: hit.title,
    text: hit.text,
    vector: hit.vector,
    keywords: hit.keywords,
    domain: hit.domain,
    topics: hit.topics,
    graph_node_id: hit.graph_node_id || hit.source_id,
    file_id: hit.file_id,
    created_at: hit.created_at || Date.now(),
  };
}

function vectorIdFor(sourceId: string, kind: VectorRecord["kind"]): string {
  const safe = sourceId.replace(/[^A-Za-z0-9_\-:.]+/g, "_");
  return `vec_${kind}_${safe}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 128) || "_";
}

function mergeAliases(items: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const it of items) {
    if (!it) continue;
    const trimmed = it.trim();
    if (trimmed) out.add(trimmed);
  }
  return Array.from(out).slice(0, 20);
}

function runningMean(existing: number[], incoming: number[], weightNew: number): number[] {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;
  const n = Math.min(existing.length, incoming.length);
  const out = new Array<number>(n);
  const wOld = 1 - weightNew;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    out[i] = existing[i] * wOld + incoming[i] * weightNew;
    norm += out[i] * out[i];
  }
  const len = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) out[i] /= len;
  return out;
}
