import { tool } from "ai";
import { z } from "zod";
import type { GraphStore, EdgeRecord } from "../storage/GraphStore";
import type { VectorStore, VectorSearchHit } from "../storage/VectorStore";
import type { Embedder } from "../providers/Embedder";
import type { LLMProviderHandle } from "../providers/LLMProvider";
import { generateText } from "ai";

export interface UniverseBundle {
  id: string;
  name: string;
  graph: GraphStore;
  vectors: VectorStore;
}

export interface AgentRetrievalConfig {
  hybridEnabled: boolean;
  graphExpansionEnabled: boolean;
  graphExpansionDepth: number;
  graphExpansionWeight: number;
}

export interface ToolsContext {
  universes: UniverseBundle[];
  embedder: Embedder;
  llm: LLMProviderHandle;
  saveAgentMemory: (input: {
    universeId: string;
    kind: "note" | "insight" | "preference" | "fact";
    content: string;
    reason: string;
    links: string[];
  }) => Promise<{ id: string }>;
  recallAgentMemory: (input: { universeId: string; query: string; topK: number }) => Promise<
    { id: string; content: string; kind: string; score: number }[]
  >;
  recordSource: (hit: VectorSearchHit & { universeName?: string }) => void;
  retrieval?: AgentRetrievalConfig;
}

/**
 * Boost multipliers applied when extending a vector-search result through its
 * graph neighborhood. Chosen empirically so explicit relations (RELATED /
 * REFERENCES_DOC) rank above simple containment or domain bucketing.
 */
const RELATION_WEIGHTS: Record<string, number> = {
  CONTAINS: 0.3,
  ABOUT: 0.6,
  MENTIONS: 0.5,
  RELATED: 0.7,
  PART_OF: 0.5,
  REFERENCES_DOC: 0.6,
  SIMILAR_TO: 0.5,
  IN_DOMAIN: 0.2,
  TAGGED: 0.2,
  DERIVED_FROM_DOC: 0.3,
};

const DEFAULT_RETRIEVAL: AgentRetrievalConfig = {
  hybridEnabled: true,
  graphExpansionEnabled: true,
  graphExpansionDepth: 1,
  graphExpansionWeight: 0.4,
};

/**
 * Construct the tool set exposed to the RAG agent. All tools are scoped to the
 * universes provided in the context — for universe chat this is [current], for
 * the global chat it is all universes.
 */
export function createTools(ctx: ToolsContext) {
  const retrieval: AgentRetrievalConfig = { ...DEFAULT_RETRIEVAL, ...(ctx.retrieval ?? {}) };
  const uniById = new Map(ctx.universes.map((u) => [u.id, u]));
  const universeIdEnum = z.enum(
    ctx.universes.length > 0
      ? (ctx.universes.map((u) => u.id) as [string, ...string[]])
      : ["__none__"],
  );

  const vectorSearch = tool({
    description:
      "Hybrid retrieval over the knowledge base. Runs semantic vector search and BM25 full-text search in parallel, fuses via reciprocal rank, then optionally expands the top hits through the knowledge graph. Use this as the default entry point for any fact-finding task.",
    parameters: z.object({
      query: z.string().describe("Natural-language query."),
      universeIds: z.array(universeIdEnum).optional(),
      kinds: z.array(z.enum(["doc_summary", "chunk", "entity", "topic", "agent_note"])).optional(),
      topK: z.number().int().min(1).max(30).default(8),
      domain: z.string().optional(),
      expandViaGraph: z.boolean().optional(),
      expansionDepth: z.number().int().min(0).max(2).optional(),
    }),
    execute: async ({ query, universeIds, kinds, topK, domain, expandViaGraph, expansionDepth }) => {
      const targets = (universeIds && universeIds.length ? universeIds : ctx.universes.map((u) => u.id))
        .map((id) => uniById.get(id))
        .filter(Boolean) as UniverseBundle[];
      const embedding = (await ctx.embedder.embed([query], "query"))[0];
      const perUniverse = await Promise.all(
        targets.map(async (u) => {
          const lists: VectorSearchHit[][] = [];
          const vectorHits = await u.vectors.search(embedding, topK * 2, {
            kind: kinds,
            domain,
          }, { includeVector: retrieval.graphExpansionEnabled && (expandViaGraph ?? true) });
          lists.push(vectorHits);

          if (retrieval.hybridEnabled) {
            const ftsHits = await u.graph.ftsSearch(query, topK * 2, kinds);
            if (ftsHits.length) {
              const converted = await hydrateFtsHits(u, ftsHits);
              lists.push(converted);
            }
          }

          const fused = rrfMerge(lists, topK * 2, u.name);

          const expand = expandViaGraph ?? retrieval.graphExpansionEnabled;
          if (!expand || fused.length === 0) return fused.slice(0, topK);

          const depth = Math.max(0, Math.min(2, expansionDepth ?? retrieval.graphExpansionDepth));
          if (depth === 0) return fused.slice(0, topK);

          const expanded = await expandViaGraphNeighborhood(u, fused, embedding, depth, retrieval.graphExpansionWeight);
          return expanded.slice(0, topK);
        }),
      );
      const merged = rrfMergeRanked(perUniverse, topK);
      for (const hit of merged) ctx.recordSource(hit);
      return merged.map((h) => ({
        id: h.id,
        universeId: h.universe_id,
        universeName: h.universeName,
        kind: h.kind,
        title: h.title,
        snippet: h.text.slice(0, 400),
        score: Number(h.score.toFixed(3)),
        sourceId: h.source_id,
        fileId: h.file_id,
        graphNodeId: h.graph_node_id,
        domain: h.domain,
        topics: h.topics,
      }));
    },
  });

  const entitySearch = tool({
    description:
      "Directly search for Entity nodes by name/description. Returns each entity enriched with aliases, centrality, top linked documents and its outgoing typed RELATED triples (predicate + object). Use this for questions about specific people, products, concepts or organizations before diving into documents.",
    parameters: z.object({
      query: z.string(),
      universeIds: z.array(universeIdEnum).optional(),
      topK: z.number().int().min(1).max(30).default(8),
      type: z.string().optional().describe("Optional filter on the canonical entity type (person, organization, product, ...)."),
      includeTriples: z.boolean().default(true).describe("If true, include up to 8 outgoing RELATED triples per entity."),
      includeDocuments: z.boolean().default(true).describe("If true, include the top 5 documents that mention each entity."),
    }),
    execute: async ({ query, universeIds, topK, type, includeTriples, includeDocuments }) => {
      const targets = (universeIds && universeIds.length ? universeIds : ctx.universes.map((u) => u.id))
        .map((id) => uniById.get(id))
        .filter(Boolean) as UniverseBundle[];
      const embedding = (await ctx.embedder.embed([query], "query"))[0];
      const perUniverse: VectorSearchHit[][] = [];
      for (const u of targets) {
        const hits = await u.vectors.search(
          embedding,
          topK,
          { kind: "entity", ...(type ? { entityType: type } : {}) },
        );
        perUniverse.push(hits.map((h) => ({ ...h, universeName: u.name })));
      }
      const merged = rrfMergeRanked(perUniverse, topK);
      for (const h of merged) ctx.recordSource(h);
      const enriched = await Promise.all(
        merged.map(async (h) => {
          const u = uniById.get(h.universe_id);
          const node = u ? await u.graph.getNode(h.source_id) : null;
          const aliases = Array.isArray((node?.props as Record<string, unknown>)?.["aliases"])
            ? ((node?.props as Record<string, unknown>)["aliases"] as string[])
            : [];
          const centrality = Number((node?.props as Record<string, unknown>)?.["centrality"] ?? 0);
          const [triples, docs] = u
            ? await Promise.all([
                includeTriples ? u.graph.entityTriples(h.source_id, 8) : Promise.resolve([]),
                includeDocuments ? u.graph.documentsForEntity(h.source_id, 5) : Promise.resolve([]),
              ])
            : [[], []];
          return {
            sourceId: h.source_id,
            universeId: h.universe_id,
            universeName: h.universeName,
            name: h.title,
            type: h.domain,
            description: h.text,
            aliases,
            centrality,
            score: Number(h.score.toFixed(3)),
            triples: triples.map((t) => ({
              direction: t.direction,
              predicate: t.predicate,
              otherId: t.otherId,
              otherName: t.otherName,
              otherType: t.otherType,
            })),
            linkedDocuments: docs.map((d) => ({ sourceId: d.documentId, title: d.title, mentionCount: d.count })),
          };
        }),
      );
      return enriched;
    },
  });

  const findEntityMentions = tool({
    description:
      "Return the chunks that actually mention a given entity, ordered by mention count. Use this right after entitySearch when you need the passages where the entity is discussed.",
    parameters: z.object({
      universeId: universeIdEnum,
      entityId: z.string().describe("The sourceId of an Entity node (e.g. as returned by entitySearch)."),
      topK: z.number().int().min(1).max(20).default(8),
    }),
    execute: async ({ universeId, entityId, topK }) => {
      const u = uniById.get(universeId);
      if (!u) return [];
      const rows = await u.graph.chunksMentioningEntity(entityId, topK);
      // Hydrate vector-side metadata (domain/topics) so the agent has full context.
      const hydrated = await u.vectors.getBySourceIds(rows.map((r) => r.chunkId));
      for (const r of rows) {
        const vec = hydrated.get(r.chunkId);
        if (vec) {
          ctx.recordSource({
            ...vec,
            score: r.count,
            universeName: u.name,
          });
        }
      }
      return rows.map((r) => ({
        sourceId: r.chunkId,
        documentId: r.documentId,
        documentTitle: r.documentTitle,
        position: r.position,
        snippet: r.text.slice(0, 500),
        mentionCount: r.count,
        universeId,
        universeName: u.name,
      }));
    },
  });

  const findRelatedDocs = tool({
    description:
      "Find documents related to a given document through shared entities, topics, explicit references, or a combination.",
    parameters: z.object({
      universeId: universeIdEnum,
      documentId: z.string(),
      via: z.enum(["entities", "topics", "references", "all"]).default("all"),
      topK: z.number().int().min(1).max(30).default(8),
    }),
    execute: async ({ universeId, documentId, via, topK }) => {
      const u = uniById.get(universeId);
      if (!u) return [];
      const rows = await u.graph.relatedDocuments(documentId, via, topK);
      return rows.map((r) => ({
        sourceId: r.id,
        title: r.title,
        score: Number(r.score.toFixed(3)),
        reason: r.reason,
        universeId,
        universeName: u.name,
      }));
    },
  });

  const findPath = tool({
    description:
      "BFS shortest path between two graph nodes. Pass the sourceId of documents, chunks, entities or topics (as returned by other tools). Returns a narrative chain like 'Person X --[works_at]--> Organization Y <--[MENTIONS]-- Document Z' together with raw nodes/edges. Use for 'how are X and Y connected' questions only when both ids are already known.",
    parameters: z.object({
      universeId: universeIdEnum,
      fromNodeId: z.string(),
      toNodeId: z.string(),
      maxHops: z.number().int().min(1).max(6).default(4),
    }),
    execute: async ({ universeId, fromNodeId, toNodeId, maxHops }) => {
      const u = uniById.get(universeId);
      if (!u) return { found: false, narrative: "", hops: [], nodes: [], edges: [] };
      const path = await u.graph.findPath(fromNodeId, toNodeId, maxHops);
      if (!path) return { found: false, narrative: "", hops: [], nodes: [], edges: [] };
      const descriptions = await u.graph.describeNodes(path.nodes);
      const byId = new Map(descriptions.map((d) => [d.id, d]));
      const hops = path.edges.map((e: EdgeRecord) => {
        const from = byId.get(e.src);
        const to = byId.get(e.dst);
        const predicate = typeof e.props?.["predicate"] === "string" ? String(e.props["predicate"]) : null;
        const label = predicate && e.rel === "RELATED" ? `${e.rel}:${predicate}` : e.rel;
        return {
          fromId: e.src,
          fromLabel: from?.label ?? e.src,
          fromType: from?.type ?? "",
          toId: e.dst,
          toLabel: to?.label ?? e.dst,
          toType: to?.type ?? "",
          relation: e.rel,
          predicate,
          renderedLabel: label,
          props: e.props,
        };
      });
      // Render a compact, directional narrative the agent can quote verbatim.
      const narrativeParts: string[] = [];
      let cursor = path.nodes[0];
      for (let i = 0; i < path.edges.length; i++) {
        const e = path.edges[i];
        const hop = hops[i];
        const cur = byId.get(cursor);
        const curLabel = cur?.label ?? cursor;
        if (e.src === cursor) {
          narrativeParts.push(`${curLabel} --[${hop.renderedLabel}]--> ${hop.toLabel}`);
          cursor = e.dst;
        } else {
          narrativeParts.push(`${curLabel} <--[${hop.renderedLabel}]-- ${hop.fromLabel}`);
          cursor = e.src;
        }
      }
      return {
        found: true,
        narrative: narrativeParts.join(" | "),
        hops,
        nodes: descriptions,
        edges: path.edges.map((e: EdgeRecord) => ({ src: e.src, dst: e.dst, relation: e.rel, props: e.props })),
      };
    },
  });

  const topicHierarchy = tool({
    description:
      "Return the topic hierarchy (PART_OF edges) of the universe. Optionally rooted at a specific topic id. Useful for surveying what an archive is about before drilling in.",
    parameters: z.object({
      universeId: universeIdEnum,
      rootTopicId: z.string().optional(),
    }),
    execute: async ({ universeId, rootTopicId }) => {
      const u = uniById.get(universeId);
      if (!u) return [];
      return await u.graph.topicHierarchy(rootTopicId);
    },
  });

  const listDomains = tool({
    description: "List all domains available in a universe with document counts.",
    parameters: z.object({ universeId: universeIdEnum }),
    execute: async ({ universeId }) => {
      const u = uniById.get(universeId)!;
      return await u.graph.listDomains();
    },
  });

  const listTopics = tool({
    description: "List top topics in a universe (sorted by document count).",
    parameters: z.object({ universeId: universeIdEnum, limit: z.number().int().min(1).max(200).default(50) }),
    execute: async ({ universeId, limit }) => {
      const u = uniById.get(universeId)!;
      return await u.graph.listTopics(limit);
    },
  });

  const listEntities = tool({
    description: "List salient entities in a universe (aggregated, with aliases).",
    parameters: z.object({ universeId: universeIdEnum, limit: z.number().int().min(1).max(200).default(50) }),
    execute: async ({ universeId, limit }) => {
      const u = uniById.get(universeId)!;
      return await u.graph.listEntities(limit);
    },
  });

  const graphNavigate = tool({
    description:
      "Navigate the knowledge graph starting from a node id (document, entity, topic, domain, or chunk). Returns the semantic neighborhood (ABOUT, MENTIONS, RELATED, PART_OF, REFERENCES_DOC, SIMILAR_TO, IN_DOMAIN). Use `includeStructural: true` to also see CONTAINS/TAGGED, but expect heavy noise on large documents.",
    parameters: z.object({
      universeId: universeIdEnum,
      nodeId: z.string(),
      depth: z.number().int().min(1).max(3).default(1),
      includeStructural: z
        .boolean()
        .default(false)
        .describe("If true, include CONTAINS and TAGGED edges (structural/trivial). Default false for a semantic view."),
      onlyRelations: z
        .array(z.string())
        .optional()
        .describe("Optional explicit whitelist of edge relation labels. Overrides includeStructural."),
    }),
    execute: async ({ universeId, nodeId, depth, includeStructural, onlyRelations }) => {
      const u = uniById.get(universeId)!;
      const filter = onlyRelations && onlyRelations.length
        ? { includeRels: onlyRelations }
        : includeStructural
          ? undefined
          : { excludeRels: ["CONTAINS", "TAGGED"] };
      return await u.graph.neighborhood(nodeId, depth, filter);
    },
  });

  const getDocumentSummary = tool({
    description: "Retrieve the full summary for a Document node by id.",
    parameters: z.object({ universeId: universeIdEnum, documentId: z.string() }),
    execute: async ({ universeId, documentId }) => {
      const u = uniById.get(universeId)!;
      return await u.graph.getDocumentSummary(documentId);
    },
  });

  const getChunk = tool({
    description: "Retrieve the full text of a chunk by id.",
    parameters: z.object({ universeId: universeIdEnum, chunkId: z.string() }),
    execute: async ({ universeId, chunkId }) => {
      const u = uniById.get(universeId)!;
      return await u.graph.getChunk(chunkId);
    },
  });

  const sampleKnowledge = tool({
    description: "Sample records from a universe. Useful for breadth discovery when the exact query is unclear.",
    parameters: z.object({
      universeId: universeIdEnum,
      kind: z.enum(["doc_summary", "chunk", "entity", "topic", "agent_note"]).default("doc_summary"),
      n: z.number().int().min(1).max(20).default(6),
      strategy: z.enum(["random", "recent", "diverse"]).default("diverse"),
    }),
    execute: async ({ universeId, kind, n, strategy }) => {
      const u = uniById.get(universeId)!;
      const rows = await u.vectors.sample(n, strategy, { kind });
      for (const hit of rows) ctx.recordSource({ ...hit, universeName: u.name });
      return rows.map((r) => ({
        id: r.id,
        universeId: r.universe_id,
        kind: r.kind,
        title: r.title,
        snippet: r.text.slice(0, 300),
        sourceId: r.source_id,
        fileId: r.file_id,
      }));
    },
  });

  const summarizeSubthread = tool({
    description:
      "Spawn an internal sub-thread to answer a focused sub-question using the provided sources without polluting the main context. Returns only the concise answer.",
    parameters: z.object({
      sourceIds: z.array(z.string()).min(1).max(12).describe("Chunk or document source ids previously returned by search tools."),
      universeId: universeIdEnum,
      subQuestion: z.string(),
    }),
    execute: async ({ sourceIds, universeId, subQuestion }) => {
      const u = uniById.get(universeId)!;
      const passages: string[] = [];
      for (const sid of sourceIds) {
        if (sid.startsWith("chunk:")) {
          const ch = await u.graph.getChunk(sid);
          if (ch) passages.push(`[${sid}]\n${ch.text}`);
        } else if (sid.startsWith("doc:")) {
          const d = await u.graph.getDocumentSummary(sid);
          if (d) passages.push(`[${sid}] ${d.title}\n${d.summary}`);
        }
      }
      if (!passages.length) return { answer: "No matching sources.", citations: [] };
      const r = await generateText({
        model: ctx.llm.chatModel,
        system:
          "You are a focused summarizer. Answer the sub-question strictly from the provided passages. Be concise (<=150 words). Cite passage ids in square brackets.",
        prompt: `Sub-question: ${subQuestion}\n\nPassages:\n${passages.join("\n\n")}\n\nAnswer:`,
        temperature: 0.0,
      });
      return { answer: r.text, citations: sourceIds };
    },
  });

  const saveAgentNote = tool({
    description:
      "Persist an insight, fact or preference that will be useful later. Use sparingly for non-obvious conclusions or user preferences.",
    parameters: z.object({
      universeId: universeIdEnum,
      kind: z.enum(["note", "insight", "preference", "fact"]).default("insight"),
      content: z.string().min(5).max(2000),
      reason: z.string().max(500),
      links: z.array(z.string()).max(20).default([]),
    }),
    execute: async ({ universeId, kind, content, reason, links }) => {
      const { id } = await ctx.saveAgentMemory({ universeId, kind, content, reason, links });
      return { saved: true, id };
    },
  });

  const recallAgentMemory = tool({
    description: "Recall the agent's own previously saved notes related to the query.",
    parameters: z.object({
      universeId: universeIdEnum,
      query: z.string(),
      topK: z.number().int().min(1).max(20).default(5),
    }),
    execute: async ({ universeId, query, topK }) => {
      return await ctx.recallAgentMemory({ universeId, query, topK });
    },
  });

  return {
    vectorSearch,
    entitySearch,
    findEntityMentions,
    findRelatedDocs,
    findPath,
    topicHierarchy,
    listDomains,
    listTopics,
    listEntities,
    graphNavigate,
    getDocumentSummary,
    getChunk,
    sampleKnowledge,
    summarizeSubthread,
    saveAgentNote,
    recallAgentMemory,
  };
}

/**
 * Turn an FTS hit into a VectorSearchHit-shaped record so both result lists can
 * be fused by the same RRF merge. Hydrates extra fields (domain, topics) from
 * the vector store when available.
 */
async function hydrateFtsHits(
  bundle: UniverseBundle,
  ftsHits: { sourceId: string; kind: string; title: string; text: string; fileId: string; graphNodeId: string; score: number }[],
): Promise<VectorSearchHit[]> {
  const sids = ftsHits.map((h) => h.sourceId);
  const lookup = await bundle.vectors.getBySourceIds(sids);
  return ftsHits.map((h) => {
    const vec = lookup.get(h.sourceId);
    return {
      id: `fts:${h.sourceId}`,
      kind: (vec?.kind ?? (h.kind as VectorSearchHit["kind"])) as VectorSearchHit["kind"],
      source_id: h.sourceId,
      universe_id: vec?.universe_id ?? bundle.id,
      title: h.title,
      text: h.text,
      vector: [],
      keywords: vec?.keywords ?? [],
      domain: vec?.domain ?? "",
      topics: vec?.topics ?? [],
      graph_node_id: h.graphNodeId,
      file_id: h.fileId,
      created_at: vec?.created_at ?? 0,
      score: h.score,
    };
  });
}

/**
 * Expand top fused hits via the graph neighborhood. For each top hit we pull
 * the first-order (or deeper) neighborhood from the graph store, then boost
 * the fused score by `relation_weight * centrality * expansionWeight`. New
 * neighbor candidates are hydrated from the vector store for their text and
 * folded into the final ranked list.
 */
async function expandViaGraphNeighborhood(
  bundle: UniverseBundle,
  fused: (VectorSearchHit & { universeName?: string })[],
  queryVector: number[],
  depth: number,
  expansionWeight: number,
): Promise<(VectorSearchHit & { universeName?: string })[]> {
  const byId = new Map<string, VectorSearchHit & { universeName?: string }>();
  for (const h of fused) byId.set(h.source_id, h);
  const topSeeds = fused.slice(0, Math.min(fused.length, 6));
  const neighborIds = new Set<string>();
  const bestRelationFor = new Map<string, string>();
  const edgeSignalFor = new Map<string, number>();

  for (const seed of topSeeds) {
    if (!seed.graph_node_id) continue;
    // Expansion ignores trivial structural edges so the neighborhood is
    // dominated by meaningful connections (MENTIONS, RELATED, PART_OF, etc.).
    const snap = await bundle.graph.neighborhood(seed.graph_node_id, depth, { excludeRels: ["TAGGED"] });
    for (const e of snap.edges) {
      const otherId = e.source === seed.graph_node_id ? e.target : e.source;
      if (!otherId || otherId === seed.graph_node_id) continue;
      if (byId.has(otherId)) continue;
      neighborIds.add(otherId);
      const prev = bestRelationFor.get(otherId);
      const prevW = prev ? RELATION_WEIGHTS[prev] ?? 0.3 : 0;
      const thisW = RELATION_WEIGHTS[e.label] ?? 0.3;
      if (thisW > prevW) bestRelationFor.set(otherId, e.label);

      // Additional signal: MENTIONS.count and explicit edge.weight flow into
      // a per-neighbour multiplier (capped so one super-frequent entity
      // cannot dominate the rank).
      const propCount = Number((e.properties as Record<string, unknown> | undefined)?.["count"] ?? 0);
      const propWeight = Number((e.properties as Record<string, unknown> | undefined)?.["weight"] ?? 0);
      const edgeSignal = Math.min(2.0, 1 + Math.log1p(propCount) * 0.3 + propWeight * 0.3);
      const prevSignal = edgeSignalFor.get(otherId) ?? 1;
      edgeSignalFor.set(otherId, Math.max(prevSignal, edgeSignal));
    }
  }

  if (neighborIds.size === 0) return fused;

  const hydrated = await bundle.vectors.getBySourceIds(Array.from(neighborIds));
  for (const [otherId, vec] of hydrated.entries()) {
    const rel = bestRelationFor.get(otherId) ?? "RELATED";
    const relW = RELATION_WEIGHTS[rel] ?? 0.3;
    const node = await bundle.graph.getNode(otherId);
    const centrality = Number((node?.props as Record<string, unknown> | undefined)?.["centrality"] ?? 0.1);
    const cos = vec.vector.length && queryVector.length ? cosine(queryVector, vec.vector) : 0;
    const edgeSignal = edgeSignalFor.get(otherId) ?? 1;
    const boost = expansionWeight * relW * Math.max(0.1, centrality) * Math.max(0.1, (cos + 1) / 2) * edgeSignal;
    byId.set(otherId, {
      id: `graph:${otherId}`,
      kind: vec.kind,
      source_id: otherId,
      universe_id: vec.universe_id,
      title: vec.title,
      text: vec.text,
      vector: [],
      keywords: vec.keywords,
      domain: vec.domain,
      topics: vec.topics,
      graph_node_id: vec.graph_node_id,
      file_id: vec.file_id,
      created_at: vec.created_at,
      score: boost,
      universeName: bundle.name,
    });
  }

  const boostedByRel = new Map<string, number>();
  for (const [id, rel] of bestRelationFor.entries()) boostedByRel.set(id, RELATION_WEIGHTS[rel] ?? 0.3);

  const merged = Array.from(byId.values()).map((h) => {
    if (boostedByRel.has(h.source_id) && !h.id.startsWith("graph:")) {
      const signal = edgeSignalFor.get(h.source_id) ?? 1;
      const bonus = expansionWeight * (boostedByRel.get(h.source_id) ?? 0) * signal;
      return { ...h, score: h.score + bonus };
    }
    return h;
  });

  merged.sort((a, b) => b.score - a.score);
  return merged;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Reciprocal Rank Fusion across multiple ranked lists. Keys by `source_id` so
 * lexical (FTS) and semantic (vector) hits for the same logical record
 * collapse into one ranked entry.
 */
function rrfMerge(
  perSource: VectorSearchHit[][],
  topK: number,
  universeName?: string,
): (VectorSearchHit & { universeName?: string })[] {
  const k = 60;
  const scores = new Map<string, { hit: VectorSearchHit & { universeName?: string }; score: number }>();
  for (const list of perSource) {
    list.forEach((hit, rank) => {
      const key = hit.source_id;
      const entry = scores.get(key);
      const score = 1 / (k + rank + 1);
      if (entry) {
        entry.score += score;
      } else {
        scores.set(key, {
          hit: { ...hit, universeName: (hit as VectorSearchHit & { universeName?: string }).universeName ?? universeName },
          score,
        });
      }
    });
  }
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => ({ ...x.hit, score: x.score }));
}

function rrfMergeRanked(
  perSource: (VectorSearchHit & { universeName?: string })[][],
  topK: number,
): (VectorSearchHit & { universeName?: string })[] {
  const k = 60;
  const scores = new Map<string, { hit: VectorSearchHit & { universeName?: string }; score: number }>();
  for (const list of perSource) {
    list.forEach((hit, rank) => {
      const key = `${hit.universe_id}:${hit.source_id}`;
      const entry = scores.get(key);
      const score = 1 / (k + rank + 1);
      if (entry) entry.score += score;
      else scores.set(key, { hit, score });
    });
  }
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => ({ ...x.hit, score: x.score }));
}
