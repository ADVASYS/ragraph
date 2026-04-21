# Self-organizing knowledge graph

A RAGraph universe is tended by two collaborators: the **ingestion pipeline** (synchronous, per document) and the **background `GraphConsolidator`** (asynchronous, per universe). Together they keep entities merged under canonical identities, topics structured via `PART_OF`, and documents linked when they talk about similar things — even when no human ever drew the connection.

## Why self-organization?

Naïve RAG over user-uploaded documents rapidly accumulates noise: the same person appears as `"Marie Curie"`, `"Curie, Marie"` and `"M. Curie"`; the same topic is tagged `"machine learning"` in one paper and `"ML"` in another; two papers cite each other but never mention each other by title. Without an active maintenance loop the graph calcifies into thousands of near-duplicates.

RAGraph fights this at two layers:

1. **On the hot path**, during ingestion, so a new document merges into the existing graph instead of splintering it.
2. **In the background**, occasionally, so drift between different ingestion batches gets repaired without blocking the user.

## Ingest-time self-organization

Inside a single-document ingestion:

1. **Structured extraction.** `Analyzer` returns entities, topics, keywords, references, a summary *and* explicit `relations[]` — both `related` (entity ↔ entity, optionally with a `predicate` such as `founded_by`) and `part_of` (topic ↔ super-topic).
2. **Entity resolution.** For every extracted entity, `EntityResolver`:
   - Embeds `"{name}: {type} — {description}"`.
   - Runs a vector search restricted to `kind = "entity"` and the same `entityType`.
   - If the best candidate's cosine exceeds `entityMergeThreshold` (default 0.88), the input is merged: the incoming surface form is added to `props.aliases[]`, the stored vector becomes a running mean weighted by the previous merge count, and the canonical id is returned.
   - Otherwise a fresh canonical id (`ent:<type>:<slug>`) is generated and a new vector record is queued for insertion.
3. **Topic resolution.** Identical flow with `topicMergeThreshold` (default 0.82) and `top:<slug>` ids.
4. **Graph write.** `GraphStore.writeAnalysis` persists the canonical ids with merged aliases and adds:
   - `MENTIONS`, `ABOUT`, `IN_DOMAIN`, `TAGGED`, `CONTAINS` edges for the document.
   - `RELATED` edges from `relations[kind=related]`, resolved against the analyzer's local name map and re-pointed to canonical ids.
   - `PART_OF` edges from `relations[kind=part_of]`.
   - A **heuristic `PART_OF` fallback**: when topic A's words form a strict super-phrase of topic B (`"machine learning"` ⊃ `"learning"`), `B` is declared `PART_OF` `A`. This is conservative and reversible — cluster centroids from the consolidator always win on conflicts.
5. **FTS sync.** `EntityResolver.syncFts` and `GraphStore.upsertFtsRow` keep `nodes_fts` in lockstep with canonical rows.
6. **Cross-document references.** For each free-text reference in the analyzer output, the pipeline hybrid-searches existing documents (FTS + vector, fused with RRF). Candidates above `referenceMatchThreshold` (default 0.72) receive a `REFERENCES_DOC` edge.

The invariant is simple: a document's ingestion never destroys existing knowledge. Every change is additive except when a surface form is recognized as an alias of something that already exists — in which case we collapse, not split.

## Background consolidation

`GraphConsolidator` (`electron/main/core/knowledge/GraphConsolidator.ts`) runs per universe when `consolidation_state.docs_since_last_run >= CONSOLIDATION_DOC_THRESHOLD` (default `10`) or when the user hits **"Consolidate now"** in Settings.

`AppContext` coalesces concurrent schedule requests, keeps at most one run per universe in flight, exposes an `AbortController` so the user can cancel, and emits `events:graph-consolidation` progress with a `phase` name and `percent`.

### Phases

1. **Entity merging.** Entities are grouped by `props.type` so `PERSON` never merges with `CONCEPT`. Each group is agglomeratively clustered with single-link cosine similarity and threshold = `entityMergeThreshold`. Every cluster picks a canonical node (highest centrality; lexicographic tie-break for stability), and every other node is merged into it via `GraphStore.mergeNode` + `VectorStore.rewriteSourceId`. Aliases accumulate on the survivor.
2. **Topic clustering.** Same clustering runs over topics with `topicMergeThreshold`. Instead of merging topics (which would destroy intended user-facing granularity), clusters become `PART_OF` relationships: non-canonical cluster members get a `PART_OF` edge pointing to the canonical topic.
3. **Similar documents.** For every pair of documents that share at least `similarDocMinEntityOverlap` `MENTIONS` targets (default 3) **and** are not already connected by a `REFERENCES_DOC` edge in either direction, a `SIMILAR_TO` edge is written with the overlap count in its props.
4. **Centrality recompute.** `GraphStore.recomputeCentrality` writes normalized degree centrality to `props.centrality` for every node. Graph expansion in `vectorSearch` reads this value.
5. **Housekeeping.** Any `Chunk` left without an inbound `CONTAINS` (usually a leftover from a cascade that interleaved with a write) is deleted.

Each phase emits progress events so the Settings panel can show the current phase and cancel the run. The whole cycle is idempotent — running it twice in a row is a no-op after the first pass.

## Tuning

All thresholds live in `AppSettings.graph` and are editable from the UI:

| Key | Default | Purpose |
| --- | --- | --- |
| `entityMergeThreshold` | `0.88` | Ingest-time resolution **and** consolidator clustering. |
| `topicMergeThreshold` | `0.82` | Ingest-time resolution **and** consolidator `PART_OF`. |
| `referenceMatchThreshold` | `0.72` | Cross-document `REFERENCES_DOC` matcher. |
| `hybridEnabled` | `true` | BM25 + vector fusion in `vectorSearch`. |
| `graphExpansionEnabled` | `true` | Neighborhood-based re-ranking in `vectorSearch`. |
| `graphExpansionDepth` | `1` | Hops to walk from each seed. |
| `graphExpansionWeight` | `0.4` | Global multiplier for the expansion boost. |

### When to tune what

- **Over-merging entities** (`"Michael Jordan"` the basketball player collapses with `"Michael Jordan"` the ML researcher): raise `entityMergeThreshold` by 0.02–0.04 or switch to an embedder that separates proper nouns better.
- **Under-merging entities** (the same person persists as three near-duplicates): lower the threshold, or run a consolidation manually after you have more documents for the embedding space to stabilize.
- **Topic sprawl** (thousands of near-duplicate topics): lower `topicMergeThreshold` slightly; the cluster centroids will absorb the long tail via `PART_OF`.
- **Noisy `SIMILAR_TO` edges**: raise the `similarDocMinEntityOverlap` constant in the consolidator.

## Data flow (ingest cycle)

```text
File → Parser → Chunker → Analyzer
                              ↓
                       EntityResolver
                         ↓        ↓
                    GraphStore   VectorStore
                         ↓
                   linkReferences
                         ↓
                onDocumentIngested
                         ↓
                  (≥ threshold?)
                         ↓
                GraphConsolidator
                         ↓
  cluster entities → cluster topics → SIMILAR_TO → centrality → housekeeping
```

## Data flow (retrieval cycle)

See [`retrieval.md`](./retrieval.md) for the full hybrid + graph-expanded retrieval path, including cross-universe fusion.
