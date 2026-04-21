# RAG pipeline

The RAG layer in RAGraph is not a single function — it is an **autonomous agent** that decides what to read, when to read it, and when it has enough evidence to answer. This document describes the tool catalogue, the execution loop and the guardrails that keep the agent productive.

## Execution overview

`electron/main/core/rag/Agent.ts` exposes `runAgent(input)`. Given a `CoreMessage[]` history, the active universes, an embedder, an LLM handle, memory callbacks and a budget, it calls the Vercel AI SDK:

```ts
streamText({
  model: llm.chatModel,
  system: SYSTEM_PROMPT(universes, language),
  messages,
  tools,                 // wrapped tools (timeout + loop detection)
  maxSteps: budget.maxSteps,
  temperature: 0.3,
  onStepFinish: forwardToolCallEvents,
});
```

The text stream is forwarded to the renderer as `events:chat-chunk`, tool calls and results as `events:chat-tool-call`, the final message as `events:chat-done`, and errors as `events:chat-error`.

## Tool catalogue (Zod-typed)

All tools are defined in `electron/main/core/rag/Tools.ts` and validated with Zod. Tool results are structured JSON, never prose.

| Tool | What it does | When to pick it |
| --- | --- | --- |
| `vectorSearch` | Hybrid BM25 + vector search with optional graph expansion, across one or more universes. | Default entry point for open-ended factual questions. |
| `entitySearch` | Semantic search restricted to `Entity` nodes; returns aliases, linked documents and outgoing `RELATED` triples. | "Who/what is X?", "tell me about X". |
| `findEntityMentions` | Exact chunk-level passages mentioning an entity id. | Turning an entity result into citable passages. |
| `findRelatedDocs` | Documents related to a given document via shared entities / topics / explicit references (weighted mix). | "What else discusses Z?". |
| `findPath` | BFS shortest path between two known node ids; returns a narrative summary of the chain. | "How are X and Y connected?". |
| `topicHierarchy` | Parent/child tree built from `PART_OF` edges, optionally rooted. | Exploring how topics nest. |
| `graphNavigate` | Semantic neighborhood of a node (excludes `CONTAINS`/`TAGGED` by default). | Inspecting a specific node after you have its id. |
| `sampleKnowledge` | Random, recent or MMR-diverse sample of chunks / summaries. | Producing overviews when no query is available. |
| `getDocumentSummary` | Fetch the Analyzer-produced summary of a document. | After `vectorSearch` returns a `doc_summary` seed. |
| `getChunk` | Read a specific chunk id verbatim. | Quoting or double-checking a passage. |
| `summarizeSubthread` | Runs a focused sub-generation over selected source ids and returns only the synthetic answer. | Synthesizing many retrieved passages without blowing up the main context. |
| `saveAgentNote` | Persist an insight (graph + vector). Links to the supporting documents with `DERIVED_FROM_DOC`. | Useful facts worth remembering across turns. |
| `recallAgentMemory` | Vector search over previously saved notes. | At the start of a turn when prior reasoning might apply. |
| `listTopics` / `listDomains` | Enumerate universe topology. | Orienting in an unfamiliar universe. |

## System prompt

The system prompt (see `Agent.ts`) contains:

- The active universe list (id + name).
- A concise graph-schema reminder (node types, edge types).
- The **language directive**: the agent answers in the user's language unless the user writes in another language.
- A **tool-selection rubric** with concrete example chains (e.g. "`Marie Curie`" → `entitySearch` → read `founded`-predicated triples → `findEntityMentions`).
- **Hard rules**: no fabrication, no identical tool calls (loop detection), prefer summaries first, save notable insights, and the exact citation format (`[^source:<id>]`).
- Preference order for citation ids: `chunk:<fileId>:<idx>` > `ent:<type>:<slug>` > `doc:<fileId>`.

## Safety shell

Every tool is wrapped in `Agent.wrapTools`:

1. **Loop detection.** A stable fingerprint (`tool:${stableStringify(args)}`) is counted; identical calls beyond `LOOP_LIMIT` (default `2`) return a structured `{ error: "loop_detected", message }` and abort the turn via a shared `AbortController`.
2. **Per-tool timeout.** The tool promise is raced against a `setTimeout` of `budget.toolTimeoutMs`. On timeout the tool resolves with `{ error: "tool_timeout", message }` instead of hanging the agent loop.
3. **Abort propagation.** An external `AbortSignal` (e.g. user clicks "stop generating") aborts the controller; the SDK unwinds the stream cleanly and the agent still emits a final `onFinish` with the sources it has collected so far.

## Source tracking

`Agent.runAgent` installs a `recordSource` callback on the tool context. Every retrieval tool that returns a ranked hit calls `recordSource(hit)` with the normalized `source_id`. The callback:

- Deduplicates by `source_id` (stronger score wins).
- Enforces `maxSources`: when the budget is exceeded, the weakest tracked source is evicted **only if** the incoming hit has a higher score.
- Produces the final `sources: SourceRef[]` array passed to `onFinish`, which the UI renders as clickable chips tied to inline `[^source:<id>]` markers.

## Context budgeting

1. **Summary-first retrieval.** Seeds prefer `doc_summary`; chunks are opened only when required.
2. **Graph before chunk.** When the user asks about relationships, `entitySearch` + `findPath` tend to produce shorter, more targeted evidence than `vectorSearch`.
3. **Sub-thread summarization.** Long evidence stacks are collapsed via `summarizeSubthread` before they enter the main context.
4. **Memory recall.** `recallAgentMemory` is the cheapest grounding step — the agent uses it when the question matches prior reasoning.

## Tuning the budget

All values live in `AppSettings.agent` and are editable in Settings → Agent:

| Key | Default | Effect |
| --- | --- | --- |
| `maxSteps` | `12` | Maximum reasoning/tool steps per turn. |
| `toolTimeoutMs` | `30000` | Per-tool timeout (0 disables). |
| `maxSources` | `40` | Upper bound on the citation list for the final message. |
| `loopDetection` | `true` | Abort on repeated identical tool calls. |

Lower `maxSteps` for faster, cheaper answers; raise it for deep research. Disable `loopDetection` only when investigating an agent regression — it is almost always a symptom of a poor system prompt or a flaky tool.
