# Ingestion

Ingestion is how raw files on disk become first-class citizens of a RAGraph universe: structured graph nodes, retrievable chunks, and embeddings that the agent can navigate. This document walks through the lifecycle.

## Inputs

A universe owns zero or more **folder mounts**. Each mount is a directory on disk, optional include/exclude globs, and an enabled flag. Watchers are per mount and live in `AppContext`.

## Watcher

`electron/main/core/ingestion/Watcher.ts` wraps `chokidar` with:

- Debounced events (`awaitWriteFinish`) so a file that is still being written does not trigger premature ingestion.
- Normalized `add | change | unlink` events with absolute + relative paths.
- Glob filtering before emission; hidden directories, common VCS folders and `node_modules` are ignored by default.

Watcher events feed `AppContext.handleWatcherEvent`, which records the file in the SQLite `files` table and enqueues it with `IngestionPipeline.enqueue`.

## Pipeline

`electron/main/core/ingestion/IngestionPipeline.ts` is a `p-queue`-backed worker (concurrency from `AppSettings.concurrency`) that processes one file at a time per universe. Every file follows the same nine-step lifecycle:

### 1. Hash & skip

Compute a SHA-256 of the file contents and compare it to the stored hash + mtime. If both match, the file is up-to-date; the pipeline emits a `done` progress event and exits. This keeps re-ingestion cheap on large folders.

### 2. Parse

`Parser.parseFile` dispatches on extension:

| Extension | Parser |
| --- | --- |
| `.pdf` | `pdf-parse` with per-page char offsets preserved. |
| `.docx` | `mammoth` (HTML to plain text). |
| `.md / .mdx / .markdown` | `marked` AST + `gray-matter` front-matter. |
| `.html / .htm` | `node-html-parser`, with `<script>`/`<style>` stripped. |
| `.ts, .js, .py, .rs, .go, …` | Raw read tagged as source code (language guessed from extension). |
| `.txt, .log, .csv, …` | Raw read as plain text. |

Output is a `ParsedDocument` with a canonical LF-normalized `text`, a `title`, `mime`, free-form `metadata`, and `pageOffsets[]` for paged formats. All downstream offsets reference this canonical text.

### 3. Chunk

`Chunker.chunk(parsedDoc)` produces `Chunk`s with:

- A heading-aware split that respects Markdown/HTML heading levels.
- A soft character budget (≈1500) with a consistent overlap (≈150) so BM25 and the vector search both stay grounded in context.
- A `headingPath[]` carried on every chunk, used for FTS titling and the Source Viewer's breadcrumb.
- `startOffset` / `endOffset` pointing into the canonical text; these propagate into `DocumentExcerpt` when a citation is rendered.

### 4. Analyze

`Analyzer.analyze(parsedDoc, chunks)` calls the LLM through the Vercel AI SDK with `streamObject` and a Zod schema. The output is a structured analysis containing:

- `title`, `domain`, `language`, `summary`
- `topics[]` — canonical topic names with optional description
- `keywords[]` — free-form tags
- `entities[]` — `{ name, type, description, aliases }` where `type ∈ { PERSON, ORGANIZATION, PRODUCT, CONCEPT, LOCATION, EVENT, … }`
- `references[]` — free-text pointers to other documents (titles, citations, "as discussed in X")
- `relations[]` — **explicit** `{ kind: "related", a, b, predicate }` and `{ kind: "part_of", child, parent }` pairs

For long documents the analyzer map-reduces: each chunk is analyzed to produce partials, which are merged into a single global analysis. This keeps context size bounded regardless of document length.

### 5. Resolve entities & topics

`EntityResolver` runs before any graph write:

1. For every extracted entity it embeds `"{name}: {type} — {description}"`, runs a vector search restricted to `kind = "entity"` with a same-type filter, and compares the best cosine score to `entityMergeThreshold` (default 0.88).
2. Above threshold: merge. The existing node's alias set is extended with the incoming surface form, its stored vector is updated with a running mean weighted by the previous merge count, and the canonical id is returned.
3. Below threshold: a fresh canonical id (`ent:<type>:<slug>`) is created and a new vector record is queued.
4. Topics follow the same flow with `topicMergeThreshold` (default 0.82) and `top:<slug>` ids.

This means surface forms like `"Curie, Marie"` and `"Marie Curie"` collapse to one node — even across documents, even across languages if the embeddings cluster them.

### 6. Embed

The document summary and each chunk are embedded with the configured embedder. The embedder is always invoked with `task: "passage"` so the E5 `passage:` prefix is applied once (and only once). The local embedder runs `multilingual-e5-small` through `@huggingface/transformers` on WASM/WebGPU; the remote embedder calls any OpenAI-compatible `/v1/embeddings` endpoint.

### 7. Persist atomically

A single `GraphStore.writeAnalysis` transaction:

- Upserts `Document`, `Topic`, `Keyword`, `Entity`, `Domain`, `Chunk` nodes (using canonical ids from step 5).
- Creates `ABOUT`, `MENTIONS` (with `count` and `weight`), `CONTAINS` (ordered via `position`), `IN_DOMAIN`, `TAGGED` edges.
- Writes explicit `RELATED` / `PART_OF` edges from `analysis.relations[]`, resolved against the local name map.
- Writes a heuristic `PART_OF` fallback when topic A's words form a strict super-phrase of topic B (`"machine learning"` ⊃ `"learning"`).
- Syncs `nodes_fts` rows for every Document summary, Chunk, Entity and Topic (via `fts_refs` shadow table).

In parallel, the `VectorStore` upserts chunk / summary / entity / topic records in batches after ID validation.

Finally `files.status = 'indexed'` and `consolidation_state.docs_since_last_run` is incremented.

### 8. Link cross-document references

For every string in `analysis.references[]` the pipeline runs a hybrid FTS+vector search over existing `Document` nodes in the universe, fuses via RRF, and writes a `REFERENCES_DOC` edge to candidates above `referenceMatchThreshold` (default 0.72). This is how documents that quote each other end up connected even when the analyzer could not identify a specific target by itself.

### 9. Progress & hook

Every phase emits an `IngestionProgress` event (`events:ingestion`) with `phase`, `percent`, optional `step/total`, `pages`, `chars` and `message`. When the file is successfully ingested, `onDocumentIngested(info)` runs in `AppContext`, which may schedule the background `GraphConsolidator` (see [self-organization.md](./self-organization.md)) if `docs_since_last_run >= CONSOLIDATION_DOC_THRESHOLD` (default 10).

## Deletions

When the watcher emits `unlink`, the pipeline calls `GraphStore.removeDocument(fileId)` which cascades `Chunk` deletions via `ON DELETE CASCADE`, cleans matching `fts_refs` rows, and removes all edges whose endpoints no longer exist. Then `VectorStore.deleteByFileId(fileId)` removes all vector records tied to that file. Entity and topic nodes survive — they represent cross-document concepts and may still be referenced elsewhere.

## Rescans

`mount:rescan` walks the mount, re-emits `add` events for every file and lets the hash-skip in step 1 filter out unchanged files. Use it after changing a mount's globs.

## Failure handling

Individual file failures are isolated:

- The error message is persisted to `files.error`, `files.status` flips to `'failed'`.
- The pipeline emits a `phase: "error"` progress event and continues with the next file.
- The UI surfaces failed files in the Documents screen with a "Re-ingest" action that re-enqueues the file.

A broken PDF never blocks the queue. A transient LLM error can be retried from the UI without touching the filesystem.

## Performance notes

- Parsing is CPU-bound and runs inline in the worker. PDFs dominate; consider pre-splitting huge PDFs.
- Embedding dominates for many small files; a local embedder amortizes the cost by batching.
- Graph writes are transactional and fast — the bottleneck is rarely SQLite.
- Concurrency is global (`AppSettings.concurrency`). Raise it for local models, lower it for rate-limited remote APIs.
