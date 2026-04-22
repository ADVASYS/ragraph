# Architecture

RAGraph is an Electron desktop application that builds, maintains and reasons over a per-universe knowledge base. Each universe stores its knowledge twice — as a **property graph** (SQLite + FTS5) for structure and full-text search, and as a **vector collection** (LanceDB) for semantic retrieval — and is navigated by an **autonomous LLM agent** through a curated set of typed tools.

## Process model

```text
┌────────────────────────────┐         IPC (typed, request/response)         ┌──────────────────────────┐
│         Main process       │◀──────────────────────────────────────────────▶│        Renderer (React) │
│ electron/main/             │                                                │ src/                     │
│                            │         Events (main → renderer)               │                          │
│  • Persistence (SQLite,    │──────────────────────────────────────────────▶│  • window.api surface    │
│    LanceDB)                │                                                │  • React + Tailwind +    │
│  • Ingestion pipeline      │                                                │    Radix primitives      │
│  • LLM + Embedder          │                                                │  • Zustand (UI state)    │
│  • RAG agent               │                                                │  • TanStack Query (data) │
│  • File watchers           │                                                │                          │
│  • Background consolidator │                                                │                          │
└────────────────────────────┘                                                └──────────────────────────┘
                ▲
                │ contextBridge
                ▼
     ┌──────────────────────┐
     │       Preload         │
     │  electron/preload/   │
     │  exposes window.api   │
     └──────────────────────┘
```

### Main process (`electron/main`)

Owns every persistent resource and every third-party integration:

- The SQLite meta DB (`MetaDatabase`) — universes, folder mounts, file records, chats, messages, attachments, settings, agent memory, consolidation state.
- One SQLite graph DB per universe (`GraphStore`) with an FTS5 virtual table for BM25 search.
- One LanceDB collection per universe (`VectorStore`).
- The `LLMProvider` and `Embedder` (local transformers.js or remote OpenAI-compatible `/v1/embeddings`).
- The `IngestionPipeline` (p-queue-backed) and chokidar-based `MountWatcher`s.
- The autonomous `Agent` with its typed `Tools`.
- The background `GraphConsolidator`.

The main process exposes **only** typed IPC handlers registered in `electron/main/ipc/**`.

### Preload (`electron/preload`)

A `contextBridge`-exposed API with a narrow surface that forwards calls to IPC channels and subscribes to main-process events. The renderer never imports Node modules directly.

### Renderer (`src`)

- React 18 + TypeScript, Tailwind CSS, shadcn-style Radix primitives, Lucide icons.
- Global UI state via **Zustand** (`src/app/store.ts`); async/server state via **TanStack Query** (caches, optimistic updates, invalidation on IPC events).
- Routed screens live in `src/features/<feature>/*Screen.tsx`; every user-visible string passes through `i18next`.
- No direct Node or Electron access — everything goes through `window.api`.

## Security model

- `contextIsolation: true`, `nodeIntegration: false`; sandbox enabled where the build chain permits.
- A strict Content Security Policy in `src/index.html` restricts scripts to `self` and forbids inline event handlers.
- API keys are encrypted at rest via Electron's `safeStorage` (Keychain / DPAPI / libsecret depending on platform) and are never persisted in plain text.
- Every SQL statement touching the graph goes through prepared statements in `GraphStore`; no LLM-produced string is interpolated into SQL.
- `VectorStore.escapeSqlLiteral` escapes every literal fed to LanceDB's SQL-like filter expressions; IDs are validated before use.
- FTS queries go through `sanitizeFtsQuery`, which strips FTS5 operators (`NEAR`, `MATCH`, quotes, parentheses, column specifiers) and quotes each remaining token to defeat injection from user input or LLM output.

## Core domain layer (`electron/main/core`)

The core is **framework-independent** (see [modules.md](./modules.md) §1): no imports of `electron`, IPC, or renderer code. It can be unit-tested with Vitest and, in principle, reused in a different shell (CLI, server).

### `storage/`

- **`MetaDatabase`** — schema + migrations for the cross-universe metadata (SQLite via `better-sqlite3`).
- **`GraphStore`** — one property graph per universe. Nodes and edges are stored in two generic tables with JSON property blobs, plus a contentless `nodes_fts` FTS5 virtual table for BM25 search. Public surface includes CRUD, `ftsSearch`, `findDocumentByTitle`, `relatedDocuments`, `findPath`, `topicHierarchy`, `mergeNode`, `recomputeCentrality`, `neighborhood`, `upsertNodeFts`, `writeAnalysis`, `saveAgentNote`.
- **`VectorStore`** — a single LanceDB table per universe with `search` (ANN), `sample` (random / recent / MMR-diverse), `getBySourceIds`, `rewriteSourceId`, `deleteByFileId`, and safe SQL-literal escaping.

### `providers/`

- **`Embedder`** — unified interface implemented by `LocalEmbedder` (`@huggingface/transformers`, `multilingual-e5-small`) and `RemoteEmbedder` (OpenAI-compatible `/v1/embeddings`). Both accept an explicit `task: "query" | "passage"` parameter so E5's required prefix is applied exactly once.
- **`LLMProvider`** — Vercel AI SDK `createOpenAICompatible`, wrapped to expose a single `LLMProviderHandle` with `chatModel` and a `generate/stream` pair.

### `ingestion/`

- **`Parser`** — PDF (`pdf-parse`), DOCX (`mammoth`), Markdown (`marked` + `gray-matter`), HTML (`node-html-parser`), plain text and source code. Produces `ParsedDocument` with per-page char offsets for PDFs.
- **`Chunker`** — heading- and paragraph-aware splitter with a ~1500-char soft budget and ~150-char overlap. Preserves the heading path on each chunk for downstream FTS titling and source-viewer navigation.
- **`Analyzer`** — Vercel AI SDK `streamObject` with a Zod schema that returns `title`, `domain`, `summary`, `topics[]`, `keywords[]`, `entities[]` **and** `relations[]` (explicit `related` and `part_of` pairs). For long documents it runs map-reduce over chunks before producing the global summary.
- **`Watcher`** — chokidar with debouncing, mapping filesystem events into `WatcherEvent`s.
- **`IngestionPipeline`** — p-queue orchestration per universe. Steps: hash → parse → chunk → analyze → entity/topic resolution → embed → graph write → cross-document reference linking → metadata update → progress event.
- **`web/`** — autonomous web-source crawler. `HtmlExtractor` converts fetched HTML to clean Markdown using `linkedom` + `@mozilla/readability` + `turndown`; `RobotsParser` honors `robots.txt` and crawl-delay; `WebCrawler` drives a BFS queue with sitemap seeding, ETag/Last-Modified conditional refresh, and per-page content-hash dedupe; `WebScheduler` wakes idle sources on their refresh interval. Output is a Markdown file in `paths.webCacheDir(...)` that re-enters the same `IngestionPipeline` as any other document. See [web-sources.md](./web-sources.md).

### `knowledge/`

- **`EntityResolver`** — embedding-based alias merging for both `Entity` and `Topic` nodes. Produces canonical ids, running-mean embeddings and alias sets; keeps FTS and vector records in sync with the graph.
- **`GraphConsolidator`** — background job that runs per universe: agglomerative entity clustering, topic clustering via `PART_OF`, `SIMILAR_TO` edges between documents with enough shared `MENTIONS`, centrality recomputation, orphan-chunk cleanup. Scheduled by `AppContext` after N ingested documents or manually from Settings.

### `rag/`

- **`Tools`** — Zod-typed tools exposed to the agent: `vectorSearch`, `entitySearch`, `findEntityMentions`, `findRelatedDocs`, `findPath`, `topicHierarchy`, `graphNavigate`, `sampleKnowledge`, `getDocumentSummary`, `getChunk`, `summarizeSubthread`, `saveAgentNote`, `recallAgentMemory`, plus enumerations (`listTopics`, `listDomains`).
- **`Agent`** — Vercel AI SDK `streamText` with a navigation-strategy system prompt. Each tool is wrapped in a safety shell that enforces a per-tool timeout and aborts the turn on repeated identical calls (loop detection).

## Service / IPC layer

`AppContext` (`electron/main/services/AppContext.ts`) is the singleton owned by `electron/main/index.ts`. It caches per-universe stores, manages watchers and consolidation schedules, loads and persists settings through `safeStorage`, and emits typed events to the renderer via `emit(channel, payload)`.

IPC handlers live in `electron/main/ipc/*.ts`, one file per domain. Every handler uses `ipcMain.handle` (request/response); one-way channels exist only as events flowing **from** the main process:

| Event channel | Payload |
| --- | --- |
| `events:ingestion` | `IngestionProgress` (phase, percent, step/total, message) |
| `events:web-crawl` | `WebCrawlProgress` (phase, pagesDiscovered/Fetched/Skipped/Failed, currentUrl) |
| `events:chat-chunk` | Streaming text delta per token group |
| `events:chat-tool-call` | `ToolInvocation` (start + result) |
| `events:chat-done` | Final `ChatMessage` with sources |
| `events:chat-error` | Serialized error |
| `events:universe-changed` | `{ universeId, kind }` — invalidates renderer caches |
| `events:graph-consolidation` | Phase name + percent for the background consolidator |

## Cross-universe retrieval

Global chat runs the `vectorSearch` pipeline over every universe in parallel. Each universe does its own hybrid fusion and (optional) graph expansion; the ranked lists are then fused a second time with a keyed-by `universe_id:source_id` RRF to produce the global ranking. Details in [retrieval.md](./retrieval.md).

## Context optimization

- **Summary-first retrieval.** `vectorSearch` biases toward `doc_summary` hits; the agent only opens `chunk`s when a summary cannot answer the question.
- **Sub-thread summarization.** `summarizeSubthread` runs a focused sub-generation over selected source ids to produce a synthetic answer that enters the main context instead of the raw passages.
- **Persistent agent memory.** `saveAgentNote` persists insights as `AgentNote` nodes with embeddings; `recallAgentMemory` runs vector search over them at the start of a turn when useful.
- **Loop protection.** Identical tool calls are deduplicated and, on repeated offenses, abort the turn gracefully with a structured message.
