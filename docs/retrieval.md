# Retrieval

`vectorSearch` is the workhorse of the RAG pipeline. It combines three ideas — lexical search, semantic search and graph structure — into a single ranked list that the agent can cite. This document describes the three stages and the knobs that control them.

## Why three stages?

Any single retrieval strategy fails some questions:

- **Pure vector search** misses rare terms (proper names, identifiers, code symbols) because the embedding space averages them out.
- **Pure BM25** misses paraphrases and translations.
- **Neither** knows that two documents cite each other, that an entity was merged from three surface forms, or that a topic is a child of another.

Fusing all three with RRF plus a graph-aware re-ranker fixes most common failure modes without sacrificing determinism or explainability.

## Stage 1 — Hybrid fusion (BM25 + Vector)

For every target universe the tool runs two searches in parallel:

- **Vector** — `VectorStore.search(queryEmbedding, topK * 2)` with optional `kind` (doc_summary / chunk / entity / topic / agent_note) and `domain` filters.
- **Lexical** — `GraphStore.ftsSearch(query, topK * 2, kinds)` against the contentless `nodes_fts` FTS5 table.

Both lists are keyed by `source_id` and fused via **Reciprocal Rank Fusion (RRF)** with `k = 60`. RRF is rank-based, so magnitudes (negated BM25 score vs. cosine distance) are never compared directly — only ranks matter. The helper is `rrfMerge(lists, k)`.

The embedder is always invoked with `task: "query"` so the E5 `query:` prefix is applied once. FTS queries pass through `sanitizeFtsQuery` which strips FTS5 operators and quotes every remaining token.

## Stage 2 — Graph expansion

When `graph.graphExpansionEnabled` is on, the top ~6 fused hits become **seeds** for a local graph walk:

1. `GraphStore.neighborhood(seed.graph_node_id, depth)` with `depth ∈ {0, 1, 2}`.
2. For every neighbor the best relation on the shortest path is recorded. Relations have fixed empirical weights:
   ```ts
   CONTAINS: 0.3  ABOUT: 0.6  MENTIONS: 0.5  RELATED: 0.7
   PART_OF: 0.5   REFERENCES_DOC: 0.6  SIMILAR_TO: 0.5
   IN_DOMAIN: 0.2 TAGGED: 0.2  DERIVED_FROM_DOC: 0.3
   ```
   Explicit `RELATED` / `REFERENCES_DOC` edges beat structural ones like `CONTAINS` / `TAGGED`.
3. Neighbors are hydrated from the vector store (`getBySourceIds`) so the fused list has the snippet and embedding needed for display and scoring.
4. Each hydrated neighbor is scored by:
   ```text
   boost = expansionWeight
         × relationWeight
         × max(0.1, centrality)
         × max(0.1, (cosine(q, neighbor) + 1) / 2)
   ```
   Seeds themselves receive a proportional bonus so they remain dominant when their neighbors are merely tangentially relevant.
5. The combined list is re-sorted by the updated score.

Centrality is maintained on every node (`props.centrality`, normalized degree centrality) by the background `GraphConsolidator`. A `0.1` floor keeps freshly ingested nodes from collapsing to zero before their first consolidation pass.

## Stage 3 — Cross-universe fusion

Global chat runs Stage 1 + Stage 2 independently per universe. Their ranked lists are then fused a second time via `rrfMergeRanked`, keyed by `universe_id:source_id`, so universes with more total hits do not drown out smaller ones. The final top-K is returned to the agent and registered with `recordSource`.

## Deduplication and budget

- `Agent.recordSource` dedupes by `source_id` (not the transient hit `id`). A stronger-scored hit replaces the weaker duplicate.
- `AgentSettings.maxSources` caps the citation list. When exceeded, the weakest tracked source is evicted — but only if the incoming hit is strictly stronger.
- Different surface forms of the same citation (e.g. same chunk retrieved twice via different tools) collapse to one chip in the UI.

## Navigation tools that bypass `vectorSearch`

When the question is structural rather than semantic, other tools are cheaper and more accurate:

- **`entitySearch`** — semantic search restricted to `kind = "entity"`, optionally filtered by canonical type. Returns aliases, top linked documents and outgoing `RELATED` triples in one call.
- **`findEntityMentions`** — exact chunk-level passages mentioning an entity id (for citations).
- **`findRelatedDocs`** — shared entities, topics, explicit references, or a weighted combination.
- **`findPath`** — BFS shortest path between two known node ids; returns a narrative chain summary.
- **`topicHierarchy`** — `PART_OF` parent/child tree, optionally rooted at a node id.

The system prompt tells the agent when to pick which. The loop-detection guard prevents it from re-running the same tool with identical arguments.

## Configuration

All knobs live in `AppSettings.graph` (editable in Settings → Knowledge graph):

| Key | Default | Role |
| --- | --- | --- |
| `hybridEnabled` | `true` | Turn off to fall back to pure vector search. |
| `graphExpansionEnabled` | `true` | Stage 2 toggle. |
| `graphExpansionDepth` | `1` | Hops to walk from each seed (0..2). |
| `graphExpansionWeight` | `0.4` | Global multiplier on the expansion boost. |
| `entityMergeThreshold` | `0.88` | Cosine for entity merging (ingest + consolidator). |
| `topicMergeThreshold` | `0.82` | Cosine for topic clustering. |
| `referenceMatchThreshold` | `0.72` | Cosine for cross-document `REFERENCES_DOC` edges. |

Defaults are tuned for `multilingual-e5-small`. With a stronger encoder (`bge-m3`, `nomic-embed-text-v1.5`, OpenAI `text-embedding-3-large`) raise `entityMergeThreshold` to avoid over-merging; lower `referenceMatchThreshold` only when you trust the analyzer's reference extraction.

## Operational notes

- **Latency.** FTS and vector searches run in parallel. Graph expansion adds a single round-trip to SQLite for neighborhood queries and one batched `getBySourceIds` to LanceDB.
- **Determinism.** Ranks are stable for a given query / database / settings tuple. The only nondeterminism is LLM streaming, which never enters retrieval.
- **Observability.** Every tool call is streamed to the renderer as `events:chat-tool-call`; the UI renders a timeline of inputs and outputs so you can see which stage produced which citation.
