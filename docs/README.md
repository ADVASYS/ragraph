# RAGraph documentation

Welcome to the RAGraph technical documentation. Everything here describes the system as it actually ships — if you find a discrepancy between the code and a doc, the doc is wrong. Please file an issue.

## Reading order

If you are new to the project, read in this order:

1. [Architecture](./architecture.md) — the big picture. Processes, layers, security model and the event stream.
2. [Graph schema](./graph-schema.md) — how the knowledge is actually stored in SQLite.
3. [Ingestion](./ingestion.md) — the lifecycle of a file, from a chokidar event to a row in the graph.
4. [Self-organization](./self-organization.md) — how entities get merged, topics cluster, and similar documents find each other.
5. [Retrieval](./retrieval.md) — the hybrid BM25 + vector + graph-expansion pipeline, including cross-universe fusion.
6. [RAG pipeline](./rag-pipeline.md) — the autonomous agent, its tools, its safety shell and context budgeting.
7. [IPC contract](./ipc.md) — the API surface between main and renderer.
8. [Module conventions](./modules.md) — the rules every contribution follows.
9. [Internationalization](./i18n.md) — how strings are organized across the four shipping locales.
10. [Packaging](./packaging.md) — electron-builder targets, code signing, auto-update.

## Conventions used in these docs

- All prose is in **English**. UI strings are translated; docs are not.
- Code references use full paths relative to the repository root, e.g. `electron/main/core/storage/GraphStore.ts`.
- SQL snippets reflect the real schema. If you change a schema, update the corresponding doc in the same PR.
- Mermaid / ASCII diagrams are intentionally simple — they should match the code, not the future plan.

## Cross-links

The code itself links back: type definitions in `shared/types.ts` mirror the DTOs listed in [IPC](./ipc.md), and inline comments in `electron/main/core/**` reference the relevant doc by name. When in doubt, trust the code and open a PR to reconcile the docs.
