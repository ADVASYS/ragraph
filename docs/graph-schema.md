# Graph schema

Each universe owns an independent SQLite database at `graph/<universeId>.sqlite`, managed by `GraphStore` (`electron/main/core/storage/GraphStore.ts`). The schema is deliberately small: a generic property graph with a contentless FTS5 virtual table layered on top. All type-specific knowledge lives in `props_json` blobs and in the conventions described below.

## Tables

```sql
CREATE TABLE nodes (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL,          -- Document | Entity | Topic | Domain | Keyword | Chunk | AgentNote
  props_json TEXT NOT NULL           -- free-form JSON payload, see "Node types" below
);

CREATE TABLE edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rel        TEXT NOT NULL,          -- see "Edge types" below
  src        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  props_json TEXT NOT NULL,
  UNIQUE (rel, src, dst)
);

CREATE INDEX idx_nodes_type ON nodes(type);
CREATE INDEX idx_edges_src  ON edges(src, rel);
CREATE INDEX idx_edges_dst  ON edges(dst, rel);
CREATE INDEX idx_edges_rel  ON edges(rel);

-- Full-text index (contentless, BM25)
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  title, body, kind UNINDEXED, content=''
);

CREATE TABLE fts_refs (
  rowid     INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,           -- logical id (node id or chunk source-id)
  kind      TEXT NOT NULL            -- doc_summary | chunk | entity | topic | agent_note
);
CREATE UNIQUE INDEX idx_fts_refs_source ON fts_refs(source_id, kind);
```

The `fts_refs` shadow table maps FTS5 rowids back to logical source ids so that merges and deletes can keep the index consistent without rebuilding it.

## Node types

| Type | `props_json` keys |
| --- | --- |
| `Document` | `file_id`, `title`, `path`, `mime`, `summary`, `created_at`, `centrality` |
| `Chunk` | `text`, `position` (ordinal), `vector_id`, `heading_path[]`, `start_offset`, `end_offset`, `page_start`, `page_end` |
| `Topic` | `name`, `description`, `centrality` |
| `Domain` | `name` |
| `Keyword` | `term` |
| `Entity` | `name`, `type` (`PERSON` / `ORGANIZATION` / `PRODUCT` / `CONCEPT` / `LOCATION` / `EVENT` / …), `description`, `aliases[]`, `centrality` |
| `AgentNote` | `content`, `reason`, `created_at` |

### Conventions

- **Namespaced ids.** `doc:<fileId>`, `chunk:<fileId>:<idx>`, `top:<slug>`, `kw:<slug>`, `ent:<type>:<slug>`, `dom:<slug>`, `note:<nanoid>`. Stable ids make citations (`[^source:<id>]`) resolvable forever.
- **Unicode normalization.** Names and text are NFKC-normalized before slug generation. This prevents `"café"` and `"café"` from producing two separate entities.
- **Aliases.** Maintained by the `EntityResolver` on ingest and by the `GraphConsolidator` during background consolidation. An entity's aliases always include its canonical name.
- **Centrality.** Normalized degree centrality, written to every node by `GraphStore.recomputeCentrality` during consolidation. Used by retrieval to prefer well-connected nodes during graph expansion.

## Edge types

| Edge `rel` | Semantic (`src → dst`) | Written by |
| --- | --- | --- |
| `CONTAINS` | `Document → Chunk`, ordered via `props_json.position` | Ingestion |
| `ABOUT` | `Document → Topic` with `props_json.weight` | Ingestion (from analysis) |
| `IN_DOMAIN` | `Document → Domain` | Ingestion |
| `TAGGED` | `Document → Keyword` | Ingestion |
| `MENTIONS` | `Document → Entity` (and `Chunk → Entity`) with `count` and `weight` | Ingestion |
| `RELATED` | `Entity → Entity` with optional `predicate` (`works_at`, `founded_by`, `located_in`, `causes`, `uses`, `part_of_org`, …) | Analyzer relation extraction |
| `PART_OF` | `Topic → Topic` — B is `PART_OF` A when B is a subtopic of A | Analyzer relations, heuristic super-phrase fallback, consolidator cluster centroids |
| `REFERENCES_DOC` | `Document → Document` — explicit cross-document citation | Reference matcher after ingest |
| `SIMILAR_TO` | `Document → Document` with `props_json.overlap` | Background `GraphConsolidator` |
| `DERIVED_FROM_DOC` | `AgentNote → Document` — provenance for a saved note | Agent (`saveAgentNote`) |

All edges are unique on `(rel, src, dst)` — re-writing is idempotent.

## Full-text search

`nodes_fts` is a contentless FTS5 virtual table. Writers are:

- `GraphStore.upsertFtsRow` — generic "one row for one logical source" helper.
- `GraphStore.upsertNodeFts` — called by analysis writes to sync a Document summary, Chunk text, or Entity/Topic identity row.
- `GraphStore.saveAgentNote` — persists `AgentNote` content to the index.
- `GraphStore.writeAnalysis` — umbrella transaction used by the ingestion pipeline.

Queries go through `ftsSearch(query, limit, kinds)`, which calls `sanitizeFtsQuery` first. The sanitizer:

- Splits the input on whitespace.
- Strips FTS5 operators (`AND`, `OR`, `NOT`, `NEAR`, `MATCH`, parentheses, column prefixes, trailing `*` at token boundaries that would otherwise make prefix matches unbounded).
- Double-quotes each remaining token so spaces and special characters are treated literally.

The result is a BM25-ranked list of `{ source_id, kind, title, body, rank }` entries that feed into the RRF fusion in [retrieval.md](./retrieval.md).

## Cascade & consistency

- Deleting a `Document` cascades to its `Chunk`s via `ON DELETE CASCADE`. `fts_refs` rows for those chunks and for the document summary are cleaned up explicitly inside the same transaction.
- `GraphStore.mergeNode(loserId, winnerId)` migrates every edge from loser to winner, re-unions them on the uniqueness constraint, copies aliases, and deletes the loser. The companion `VectorStore.rewriteSourceId(loserId, winnerId)` keeps the vector collection in sync.
- Orphan `Chunk`s (no inbound `CONTAINS`) are swept by the background consolidator after a merge campaign.

## Why two tables?

The two-table model trades type-system expressiveness for flexibility:

- Adding a new node or edge type never requires a migration.
- Property schemas evolve freely — older rows keep their older shape.
- The FTS layer is decoupled via `fts_refs`, so the index schema and the graph schema can evolve independently.

The cost is that callers must know the `props_json` shape per node type. That shape is documented in this file and enforced at the write sites in `GraphStore` (not at the SQL layer).
