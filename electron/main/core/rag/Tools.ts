import { tool } from "ai";
import { z } from "zod";
import type { GraphStore, EdgeRecord } from "../storage/GraphStore";
import type { VectorStore, VectorSearchHit } from "../storage/VectorStore";
import type { Embedder } from "../providers/Embedder";
import type { LLMProviderHandle } from "../providers/LLMProvider";
import { generateText } from "ai";
import { evaluateRelevance, type GateVerdict, type Relevance } from "./RelevanceGate";

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

/**
 * Full-fidelity record of one hit kept in the per-turn evidence cache. The
 * main model only ever sees the compact projection built by `gateAndCache`;
 * the full `text` / `meta` remain here and can be pulled on demand via the
 * `inspect` or `quote` drills.
 */
export interface EvidenceRecord {
  sourceId: string;
  kind: string;
  title: string;
  text: string;
  universeId: string;
  universeName?: string;
  fileId?: string | null;
  graphNodeId?: string | null;
  toolName: string;
  capturedAt: number;
  meta?: Record<string, unknown>;
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
  /**
   * Per-turn evidence cache. Heavy retrieval/navigation tools populate this
   * with full payloads; the main model can pull a cached record back via
   * the `inspect` / `quote` drills without re-running the tool.
   */
  evidence: Map<string, EvidenceRecord>;
  /**
   * Current agent goal — typically the last user message for the turn.
   * Tools can override with a per-call `subGoal` to sharpen the gate.
   */
  goalRef: { current: string };
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

/** Compact projection returned to the main model after the relevance gate. */
interface CompactRef {
  sourceId: string;
  kind: string;
  title: string;
  relevance: Relevance;
  why: string;
  universeId: string;
  universeName?: string;
}

interface GateSubject {
  sourceId: string;
  kind: string;
  title: string;
  text: string;
  universeId: string;
  universeName?: string;
  fileId?: string | null;
  graphNodeId?: string | null;
  hint?: string;
  meta?: Record<string, unknown>;
}

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

  /**
   * Run the full tool output through the relevance gate. Every subject is
   * mirrored into the evidence cache first (so the main model can `inspect`
   * dropped items later if it wants), then the compact verdicts are returned.
   */
  async function gateAndCache(
    toolName: string,
    subjects: GateSubject[],
    subGoal: string | undefined,
    maxKeep: number,
  ): Promise<CompactRef[]> {
    if (!subjects.length) return [];

    const now = Date.now();
    for (const s of subjects) {
      if (!ctx.evidence.has(s.sourceId)) {
        ctx.evidence.set(s.sourceId, {
          sourceId: s.sourceId,
          kind: s.kind,
          title: s.title,
          text: s.text,
          universeId: s.universeId,
          universeName: s.universeName,
          fileId: s.fileId ?? null,
          graphNodeId: s.graphNodeId ?? null,
          toolName,
          capturedAt: now,
          meta: s.meta,
        });
      }
    }

    const verdict = await evaluateRelevance({
      llm: ctx.llm,
      goal: (subGoal && subGoal.trim()) || ctx.goalRef.current || "",
      toolName,
      maxKeep,
      items: subjects.map((s) => ({
        sourceId: s.sourceId,
        title: s.title,
        text: s.text,
        hint: s.hint,
      })),
    });

    const bySource = new Map(subjects.map((s) => [s.sourceId, s]));
    const out: CompactRef[] = [];
    for (const v of verdict.kept) {
      const s = bySource.get(v.sourceId);
      if (!s) continue;
      out.push({
        sourceId: s.sourceId,
        kind: s.kind,
        title: s.title,
        relevance: v.relevance,
        why: v.why,
        universeId: s.universeId,
        universeName: s.universeName,
      });
    }
    return out;
  }

  const vectorSearch = tool({
    description:
      "Hybrid retrieval over the knowledge base (BM25 + vector, optional graph expansion). Results are evaluated by a relevance sub-LLM in a sub-context; you only receive a compact ranked list. Use `inspect(sourceId)` to pull the full passage into context when needed.",
    parameters: z.object({
      query: z.string().describe("Natural-language query."),
      subGoal: z
        .string()
        .optional()
        .describe("Optional refinement of the user's goal for the relevance gate (one short sentence)."),
      universeIds: z.array(universeIdEnum).optional(),
      kinds: z.array(z.enum(["doc_summary", "chunk", "entity", "topic", "agent_note"])).optional(),
      topK: z.number().int().min(1).max(30).default(8),
      domain: z.string().optional(),
      expandViaGraph: z.boolean().optional(),
      expansionDepth: z.number().int().min(0).max(2).optional(),
    }),
    execute: async ({ query, subGoal, universeIds, kinds, topK, domain, expandViaGraph, expansionDepth }) => {
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

      const subjects: GateSubject[] = merged.map((h) => ({
        sourceId: h.source_id,
        kind: h.kind,
        title: h.title,
        text: h.text,
        universeId: h.universe_id,
        universeName: h.universeName,
        fileId: h.file_id,
        graphNodeId: h.graph_node_id,
        hint: h.domain ? `domain=${h.domain}` : undefined,
        meta: { score: Number(h.score.toFixed(3)), topics: h.topics, domain: h.domain },
      }));

      const compact = await gateAndCache("vectorSearch", subjects, subGoal, Math.min(topK, 6));
      return {
        goal: (subGoal && subGoal.trim()) || ctx.goalRef.current,
        results: compact,
        note: "Snippets are intentionally omitted. Call inspect(sourceId) or quote(sourceId, question) to read the passage.",
      };
    },
  });

  const entitySearch = tool({
    description:
      "Directly search for Entity nodes by name/description. Returns enriched entities (aliases, top linked documents, outgoing RELATED triples) filtered by a relevance sub-LLM. Use for questions about specific people, products, concepts or organizations.",
    parameters: z.object({
      query: z.string(),
      subGoal: z
        .string()
        .optional()
        .describe("Optional refinement of the user's goal for the relevance gate."),
      universeIds: z.array(universeIdEnum).optional(),
      topK: z.number().int().min(1).max(30).default(8),
      type: z.string().optional().describe("Optional filter on the canonical entity type (person, organization, product, ...)."),
      includeTriples: z.boolean().default(true).describe("If true, include up to 8 outgoing RELATED triples per entity."),
      includeDocuments: z.boolean().default(true).describe("If true, include the top 5 documents that mention each entity."),
    }),
    execute: async ({ query, subGoal, universeIds, topK, type, includeTriples, includeDocuments }) => {
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
          return { hit: h, node, aliases, centrality, triples, docs };
        }),
      );

      const subjects: GateSubject[] = enriched.map((e) => {
        const triplesLine = e.triples.length
          ? e.triples
              .map((t) => `${t.direction === "out" ? "->" : "<-"}[${t.predicate}] ${t.otherName}`)
              .slice(0, 5)
              .join("; ")
          : "";
        const docsLine = e.docs.length
          ? e.docs
              .map((d) => `${d.title} (${d.count})`)
              .slice(0, 3)
              .join("; ")
          : "";
        const hintParts: string[] = [];
        if (e.hit.domain) hintParts.push(`type=${e.hit.domain}`);
        if (e.aliases.length) hintParts.push(`aliases=${e.aliases.slice(0, 4).join(", ")}`);
        if (triplesLine) hintParts.push(`triples: ${triplesLine}`);
        if (docsLine) hintParts.push(`docs: ${docsLine}`);
        return {
          sourceId: e.hit.source_id,
          kind: "entity",
          title: e.hit.title,
          text: e.hit.text,
          universeId: e.hit.universe_id,
          universeName: e.hit.universeName,
          graphNodeId: e.hit.graph_node_id,
          fileId: e.hit.file_id,
          hint: hintParts.join(" | "),
          meta: {
            type: e.hit.domain,
            aliases: e.aliases,
            centrality: e.centrality,
            triples: e.triples.map((t) => ({
              direction: t.direction,
              predicate: t.predicate,
              otherId: t.otherId,
              otherName: t.otherName,
              otherType: t.otherType,
            })),
            linkedDocuments: e.docs.map((d) => ({ sourceId: d.documentId, title: d.title, mentionCount: d.count })),
          },
        } satisfies GateSubject;
      });

      const compact = await gateAndCache("entitySearch", subjects, subGoal, Math.min(topK, 6));
      // Expose the richer sub-structures (triples / linked docs) alongside the
      // compact ref — they are tiny by construction and essential for further
      // planning (e.g. which triple to follow next).
      const bySubject = new Map(subjects.map((s) => [s.sourceId, s]));
      const results = compact.map((c) => {
        const s = bySubject.get(c.sourceId);
        return {
          ...c,
          type: (s?.meta?.type as string | undefined) ?? "",
          aliases: (s?.meta?.aliases as string[] | undefined) ?? [],
          centrality: (s?.meta?.centrality as number | undefined) ?? 0,
          triples: (s?.meta?.triples as unknown[] | undefined) ?? [],
          linkedDocuments: (s?.meta?.linkedDocuments as unknown[] | undefined) ?? [],
        };
      });

      return {
        goal: (subGoal && subGoal.trim()) || ctx.goalRef.current,
        results,
        note: "Descriptions are intentionally omitted. Call inspect(sourceId) for the full entity description.",
      };
    },
  });

  const findEntityMentions = tool({
    description:
      "Return the chunks that actually mention a given entity, ordered by mention count, and filtered by the relevance sub-LLM. Use right after entitySearch when you need the passages where the entity is discussed.",
    parameters: z.object({
      universeId: universeIdEnum,
      entityId: z.string().describe("The sourceId of an Entity node (e.g. as returned by entitySearch)."),
      subGoal: z.string().optional(),
      topK: z.number().int().min(1).max(20).default(8),
    }),
    execute: async ({ universeId, entityId, subGoal, topK }) => {
      const u = uniById.get(universeId);
      if (!u) return { goal: ctx.goalRef.current, results: [] };
      const rows = await u.graph.chunksMentioningEntity(entityId, topK);
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

      const subjects: GateSubject[] = rows.map((r) => ({
        sourceId: r.chunkId,
        kind: "chunk",
        title: r.documentTitle || `chunk #${r.position}`,
        text: r.text,
        universeId,
        universeName: u.name,
        hint: `mentions=${r.count} in document "${r.documentTitle}"`,
        meta: {
          documentId: r.documentId,
          documentTitle: r.documentTitle,
          position: r.position,
          mentionCount: r.count,
        },
      }));

      const compact = await gateAndCache("findEntityMentions", subjects, subGoal, Math.min(topK, 6));
      return {
        goal: (subGoal && subGoal.trim()) || ctx.goalRef.current,
        results: compact.map((c) => {
          const m = ctx.evidence.get(c.sourceId)?.meta ?? {};
          return {
            ...c,
            documentId: (m as Record<string, unknown>).documentId,
            position: (m as Record<string, unknown>).position,
            mentionCount: (m as Record<string, unknown>).mentionCount,
          };
        }),
      };
    },
  });

  const findRelatedDocs = tool({
    description:
      "Find documents related to a given document through shared entities, topics, explicit references, or a combination. Results are filtered by the relevance sub-LLM.",
    parameters: z.object({
      universeId: universeIdEnum,
      documentId: z.string(),
      subGoal: z.string().optional(),
      via: z.enum(["entities", "topics", "references", "all"]).default("all"),
      topK: z.number().int().min(1).max(30).default(8),
    }),
    execute: async ({ universeId, documentId, subGoal, via, topK }) => {
      const u = uniById.get(universeId);
      if (!u) return { goal: ctx.goalRef.current, results: [] };
      const rows = await u.graph.relatedDocuments(documentId, via, topK);

      const subjects: GateSubject[] = rows.map((r) => ({
        sourceId: r.id,
        kind: "doc_summary",
        title: r.title,
        // No full text here yet — the graph.relatedDocuments result is intentionally lightweight.
        text: `${r.title} — ${r.reason}`,
        universeId,
        universeName: u.name,
        hint: `reason=${r.reason}; score=${r.score.toFixed(3)}`,
        meta: { reason: r.reason, score: Number(r.score.toFixed(3)) },
      }));

      const compact = await gateAndCache("findRelatedDocs", subjects, subGoal, Math.min(topK, 6));
      return {
        goal: (subGoal && subGoal.trim()) || ctx.goalRef.current,
        results: compact.map((c) => {
          const m = (ctx.evidence.get(c.sourceId)?.meta ?? {}) as Record<string, unknown>;
          return { ...c, reason: m.reason, score: m.score };
        }),
      };
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
      "Inspect the semantic neighborhood of a node (document / entity / topic / domain / chunk). Excludes CONTAINS/TAGGED by default. Returns only the neighbors the relevance sub-LLM considers useful for the current goal. Use `navigate(nodeId, goal)` for goal-driven active navigation.",
    parameters: z.object({
      universeId: universeIdEnum,
      nodeId: z.string(),
      subGoal: z.string().optional(),
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
    execute: async ({ universeId, nodeId, subGoal, depth, includeStructural, onlyRelations }) => {
      const u = uniById.get(universeId);
      if (!u) return { goal: ctx.goalRef.current, neighbors: [] };
      const filter = onlyRelations && onlyRelations.length
        ? { includeRels: onlyRelations }
        : includeStructural
          ? undefined
          : { excludeRels: ["CONTAINS", "TAGGED"] };
      const snap = await u.graph.neighborhood(nodeId, depth, filter);
      const ownNodeId = nodeId;

      // Group edges per neighbor id and pick the strongest signal.
      const perNeighbor = new Map<string, { labels: string[]; direction: "out" | "in" | "both"; predicates: string[] }>();
      for (const e of snap.edges) {
        const other = e.source === ownNodeId ? e.target : e.target === ownNodeId ? e.source : null;
        if (!other || other === ownNodeId) continue;
        const entry = perNeighbor.get(other) ?? { labels: [], direction: "out" as const, predicates: [] };
        entry.labels.push(e.label);
        const predicate = typeof (e.properties as Record<string, unknown>)?.["predicate"] === "string"
          ? String((e.properties as Record<string, unknown>)["predicate"])
          : null;
        if (predicate) entry.predicates.push(predicate);
        const isOut = e.source === ownNodeId;
        entry.direction = entry.direction === "both" ? "both" : isOut ? "out" : "in";
        perNeighbor.set(other, entry);
      }

      const nodesById = new Map(snap.nodes.map((n) => [n.id, n]));
      const subjects: GateSubject[] = [];
      for (const [otherId, info] of perNeighbor.entries()) {
        const n = nodesById.get(otherId);
        if (!n) continue;
        const dom = n.properties as Record<string, unknown>;
        const desc =
          typeof dom.summary === "string" ? String(dom.summary)
          : typeof dom.description === "string" ? String(dom.description)
          : typeof dom.text === "string" ? String(dom.text)
          : "";
        const label = n.label || otherId;
        const edgeLabel = info.predicates.length ? info.predicates[0] : info.labels[0];
        const hintParts = [
          `type=${n.type}`,
          `edge=${info.direction === "out" ? "->" : info.direction === "in" ? "<-" : "<->"}${edgeLabel}`,
        ];
        subjects.push({
          sourceId: otherId,
          kind: n.type,
          title: label,
          text: desc || label,
          universeId,
          universeName: u.name,
          graphNodeId: otherId,
          hint: hintParts.join(" | "),
          meta: {
            relations: Array.from(new Set(info.labels)),
            predicates: Array.from(new Set(info.predicates)),
            direction: info.direction,
            nodeType: n.type,
          },
        });
      }

      const compact = await gateAndCache("graphNavigate", subjects, subGoal, 6);
      return {
        goal: (subGoal && subGoal.trim()) || ctx.goalRef.current,
        fromNodeId: nodeId,
        neighbors: compact.map((c) => {
          const m = (ctx.evidence.get(c.sourceId)?.meta ?? {}) as Record<string, unknown>;
          return {
            ...c,
            nodeType: m.nodeType,
            relations: m.relations,
            predicates: m.predicates,
            direction: m.direction,
          };
        }),
        note: "Only neighbors judged relevant to the goal are returned. Use graphNavigate again with a different subGoal or nodeId to walk further.",
      };
    },
  });

  const getDocumentSummary = tool({
    description: "Retrieve the full summary for a Document node by id.",
    parameters: z.object({ universeId: universeIdEnum, documentId: z.string() }),
    execute: async ({ universeId, documentId }) => {
      const u = uniById.get(universeId)!;
      const doc = await u.graph.getDocumentSummary(documentId);
      if (doc) {
        ctx.evidence.set(documentId, {
          sourceId: documentId,
          kind: "doc_summary",
          title: doc.title,
          text: doc.summary,
          universeId,
          universeName: u.name,
          toolName: "getDocumentSummary",
          capturedAt: Date.now(),
          meta: { path: doc.path },
        });
      }
      return doc;
    },
  });

  const getChunk = tool({
    description: "Retrieve the full text of a chunk by id.",
    parameters: z.object({ universeId: universeIdEnum, chunkId: z.string() }),
    execute: async ({ universeId, chunkId }) => {
      const u = uniById.get(universeId)!;
      const chunk = await u.graph.getChunk(chunkId);
      if (chunk) {
        ctx.evidence.set(chunkId, {
          sourceId: chunkId,
          kind: "chunk",
          title: chunk.documentTitle || `chunk #${chunk.position}`,
          text: chunk.text,
          universeId,
          universeName: u.name,
          toolName: "getChunk",
          capturedAt: Date.now(),
          meta: {
            documentId: chunk.documentId,
            position: chunk.position,
            heading: chunk.heading,
          },
        });
      }
      return chunk;
    },
  });

  const sampleKnowledge = tool({
    description: "Sample records from a universe. Results pass through the relevance sub-LLM. Useful for breadth discovery when no precise query is available.",
    parameters: z.object({
      universeId: universeIdEnum,
      subGoal: z.string().optional(),
      kind: z.enum(["doc_summary", "chunk", "entity", "topic", "agent_note"]).default("doc_summary"),
      n: z.number().int().min(1).max(20).default(6),
      strategy: z.enum(["random", "recent", "diverse"]).default("diverse"),
    }),
    execute: async ({ universeId, subGoal, kind, n, strategy }) => {
      const u = uniById.get(universeId)!;
      const rows = await u.vectors.sample(n, strategy, { kind });
      for (const hit of rows) ctx.recordSource({ ...hit, universeName: u.name });

      const subjects: GateSubject[] = rows.map((r) => ({
        sourceId: r.source_id,
        kind: r.kind,
        title: r.title,
        text: r.text,
        universeId: r.universe_id,
        universeName: u.name,
        fileId: r.file_id,
        graphNodeId: r.graph_node_id,
        hint: r.domain ? `domain=${r.domain}` : undefined,
      }));

      const compact = await gateAndCache("sampleKnowledge", subjects, subGoal, Math.min(n, 6));
      return {
        goal: (subGoal && subGoal.trim()) || ctx.goalRef.current,
        results: compact,
      };
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
        // Prefer the evidence cache to avoid an extra SQL round-trip.
        const cached = ctx.evidence.get(sid);
        if (cached?.text) {
          passages.push(`[${sid}] ${cached.title}\n${cached.text}`);
          continue;
        }
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

  const inspect = tool({
    description:
      "Pull the full text of a previously retrieved source (chunk / document summary / entity / topic / agent_note) into your working context. Prefer this over re-running a search tool when you already know the sourceId.",
    parameters: z.object({
      sourceId: z.string(),
      universeId: universeIdEnum.optional(),
    }),
    execute: async ({ sourceId, universeId }) => {
      const cached = ctx.evidence.get(sourceId);
      if (cached) {
        return {
          sourceId: cached.sourceId,
          kind: cached.kind,
          title: cached.title,
          text: cached.text,
          universeId: cached.universeId,
          universeName: cached.universeName,
          fromCache: true,
          meta: cached.meta ?? {},
        };
      }
      const bundles = universeId
        ? [uniById.get(universeId)].filter(Boolean) as UniverseBundle[]
        : ctx.universes;
      for (const u of bundles) {
        if (sourceId.startsWith("chunk:")) {
          const c = await u.graph.getChunk(sourceId);
          if (c) {
            ctx.evidence.set(sourceId, {
              sourceId,
              kind: "chunk",
              title: c.documentTitle || `chunk #${c.position}`,
              text: c.text,
              universeId: u.id,
              universeName: u.name,
              toolName: "inspect",
              capturedAt: Date.now(),
              meta: { documentId: c.documentId, position: c.position, heading: c.heading },
            });
            return {
              sourceId,
              kind: "chunk" as const,
              title: c.documentTitle || `chunk #${c.position}`,
              text: c.text,
              universeId: u.id,
              universeName: u.name,
              fromCache: false,
              meta: { documentId: c.documentId, position: c.position, heading: c.heading },
            };
          }
        } else if (sourceId.startsWith("doc:")) {
          const d = await u.graph.getDocumentSummary(sourceId);
          if (d) {
            ctx.evidence.set(sourceId, {
              sourceId,
              kind: "doc_summary",
              title: d.title,
              text: d.summary,
              universeId: u.id,
              universeName: u.name,
              toolName: "inspect",
              capturedAt: Date.now(),
              meta: { path: d.path },
            });
            return {
              sourceId,
              kind: "doc_summary" as const,
              title: d.title,
              text: d.summary,
              universeId: u.id,
              universeName: u.name,
              fromCache: false,
              meta: { path: d.path },
            };
          }
        }
        const node = await u.graph.getNode(sourceId);
        if (node) {
          const props = node.props as Record<string, unknown>;
          const title = (props.name as string) || (props.title as string) || (props.term as string) || sourceId;
          const text =
            (props.description as string) ||
            (props.summary as string) ||
            (props.text as string) ||
            (props.content as string) ||
            "";
          const kind = node.type.toLowerCase();
          ctx.evidence.set(sourceId, {
            sourceId,
            kind,
            title,
            text,
            universeId: u.id,
            universeName: u.name,
            toolName: "inspect",
            capturedAt: Date.now(),
            meta: props,
          });
          return {
            sourceId,
            kind,
            title,
            text,
            universeId: u.id,
            universeName: u.name,
            fromCache: false,
            meta: props,
          };
        }
      }
      return { sourceId, error: "not_found", message: "No matching evidence or graph node." };
    },
  });

  const quote = tool({
    description:
      "Extract the 1–3 most supporting sentences from a cached source (or fetch the source first). Keeps the main context lean by not dumping the full passage.",
    parameters: z.object({
      sourceId: z.string(),
      question: z.string().describe("What should the quote support?"),
      universeId: universeIdEnum.optional(),
    }),
    execute: async ({ sourceId, question, universeId }) => {
      let record = ctx.evidence.get(sourceId);
      if (!record) {
        // Seed the cache via the same path inspect() uses.
        const bundles = universeId
          ? [uniById.get(universeId)].filter(Boolean) as UniverseBundle[]
          : ctx.universes;
        for (const u of bundles) {
          if (sourceId.startsWith("chunk:")) {
            const c = await u.graph.getChunk(sourceId);
            if (c) {
              record = {
                sourceId,
                kind: "chunk",
                title: c.documentTitle || `chunk #${c.position}`,
                text: c.text,
                universeId: u.id,
                universeName: u.name,
                toolName: "quote",
                capturedAt: Date.now(),
                meta: { documentId: c.documentId, position: c.position },
              };
              ctx.evidence.set(sourceId, record);
              break;
            }
          } else if (sourceId.startsWith("doc:")) {
            const d = await u.graph.getDocumentSummary(sourceId);
            if (d) {
              record = {
                sourceId,
                kind: "doc_summary",
                title: d.title,
                text: d.summary,
                universeId: u.id,
                universeName: u.name,
                toolName: "quote",
                capturedAt: Date.now(),
              };
              ctx.evidence.set(sourceId, record);
              break;
            }
          }
        }
      }
      if (!record || !record.text) {
        return { sourceId, error: "not_found", quote: "" };
      }
      const r = await generateText({
        model: ctx.llm.chatModel,
        system:
          "You extract verbatim supporting quotes from a single passage. Return only 1–3 consecutive sentences copied exactly from the passage. If nothing supports the question, return an empty string.",
        prompt: `Question: ${question}\n\nPassage [${sourceId}]:\n${record.text}\n\nSupporting quote:`,
        temperature: 0,
        maxTokens: 300,
      });
      return {
        sourceId,
        universeId: record.universeId,
        title: record.title,
        kind: record.kind,
        quote: r.text.trim(),
      };
    },
  });

  const navigate = tool({
    description:
      "Active graph navigation: pick the single best next hop from a node toward a goal. Inspects the neighborhood (semantic edges only), runs the relevance sub-LLM against the goal, and returns the 3 most promising next nodes with reasons. Use iteratively to walk the graph one hop at a time.",
    parameters: z.object({
      universeId: universeIdEnum,
      nodeId: z.string(),
      goal: z.string().describe("What are you navigating toward? E.g. 'find companies founded by Marie Curie'."),
      depth: z.number().int().min(1).max(2).default(1),
    }),
    execute: async ({ universeId, nodeId, goal, depth }) => {
      const u = uniById.get(universeId);
      if (!u) return { goal, from: nodeId, candidates: [] };
      const snap = await u.graph.neighborhood(nodeId, depth, { excludeRels: ["CONTAINS", "TAGGED"] });

      const perNeighbor = new Map<string, { labels: string[]; predicates: string[]; direction: "out" | "in" | "both" }>();
      for (const e of snap.edges) {
        const other = e.source === nodeId ? e.target : e.target === nodeId ? e.source : null;
        if (!other || other === nodeId) continue;
        const entry = perNeighbor.get(other) ?? { labels: [], predicates: [], direction: "out" as const };
        entry.labels.push(e.label);
        const pred = typeof (e.properties as Record<string, unknown>)?.["predicate"] === "string"
          ? String((e.properties as Record<string, unknown>)["predicate"])
          : null;
        if (pred) entry.predicates.push(pred);
        const isOut = e.source === nodeId;
        entry.direction = entry.direction === "both" ? "both" : isOut ? "out" : "in";
        perNeighbor.set(other, entry);
      }

      const nodesById = new Map(snap.nodes.map((n) => [n.id, n]));
      const subjects: GateSubject[] = [];
      for (const [otherId, info] of perNeighbor.entries()) {
        const n = nodesById.get(otherId);
        if (!n) continue;
        const dom = n.properties as Record<string, unknown>;
        const desc =
          typeof dom.summary === "string" ? String(dom.summary)
          : typeof dom.description === "string" ? String(dom.description)
          : typeof dom.text === "string" ? String(dom.text)
          : "";
        const edgeLabel = info.predicates.length ? info.predicates[0] : info.labels[0];
        subjects.push({
          sourceId: otherId,
          kind: n.type,
          title: n.label || otherId,
          text: desc || n.label || otherId,
          universeId,
          universeName: u.name,
          graphNodeId: otherId,
          hint: `type=${n.type} | edge=${info.direction === "out" ? "->" : info.direction === "in" ? "<-" : "<->"}${edgeLabel}`,
          meta: {
            relations: Array.from(new Set(info.labels)),
            predicates: Array.from(new Set(info.predicates)),
            direction: info.direction,
            nodeType: n.type,
          },
        });
      }

      // Explicit goal override — `navigate` is goal-driven by design.
      const compact = await gateAndCache("navigate", subjects, goal, 3);
      const candidates = compact.map((c) => {
        const m = (ctx.evidence.get(c.sourceId)?.meta ?? {}) as Record<string, unknown>;
        return {
          nextNodeId: c.sourceId,
          nodeType: m.nodeType,
          title: c.title,
          relevance: c.relevance,
          why: c.why,
          relations: m.relations,
          predicates: m.predicates,
          direction: m.direction,
        };
      });
      return { goal, from: nodeId, candidates };
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
    inspect,
    quote,
    navigate,
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
