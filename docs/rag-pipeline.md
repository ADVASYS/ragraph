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

## Sub-context relevance gate

The main agent never sees raw tool results for the heavy retrieval / navigation tools. Every such call is routed through a two-layer pattern implemented in [`electron/main/core/rag/RelevanceGate.ts`](../electron/main/core/rag/RelevanceGate.ts) and [`electron/main/core/rag/Tools.ts`](../electron/main/core/rag/Tools.ts):

1. **Evidence cache.** Every hit is written into a per-turn `Map<sourceId, EvidenceRecord>` that lives in `runAgent` scope. The record keeps the full text, metadata, originating tool and capture timestamp.
2. **Relevance gate.** A small `generateText` call (`temperature: 0`, `maxTokens: 400`) runs on the hidden chat model. It receives the current goal (last user message or an explicit `subGoal`) plus every candidate and returns strict JSON: `{ kept: [{ sourceId, relevance, why }], droppedIds: [] }`. Parse errors fall back to keeping every candidate at `medium` so the loop cannot stall on a flaky response.
3. **Compact output.** The tool returns only `{ sourceId, kind, title, relevance, why, universeId, universeName }` to the main model — no snippets. To read the actual passage the agent must explicitly call one of the drill tools below.

Tools routed through the gate: `vectorSearch`, `entitySearch`, `findEntityMentions`, `findRelatedDocs`, `graphNavigate`, `sampleKnowledge`, `navigate`. Each accepts an optional `subGoal` argument so the agent can refine the filter per call (e.g. `"find companies co-founded by Marie Curie, not mere mentions"`).

### Drill tools

- **`inspect(sourceId, universeId?)`** — return the full cached text for a sourceId. Falls back to `graph.getChunk` / `graph.getDocumentSummary` / `graph.getNode` when the id is not (yet) in the cache.
- **`quote(sourceId, question)`** — run a focused sub-LLM over the cached text and return 1–3 verbatim supporting sentences. Cheaper than `inspect` when only one citation is needed.
- **`navigate(nodeId, goal, depth?)`** — active graph navigation. Reads the semantic neighborhood (excluding `CONTAINS`/`TAGGED`), hydrates each neighbor with its title + one-line description, runs the gate against `goal`, and returns at most three `{ nextNodeId, relevance, why, relations, predicates, direction }` candidates. Iterate to walk the graph one hop at a time.

## Tool catalogue (Zod-typed)

All tools are defined in `electron/main/core/rag/Tools.ts` and validated with Zod. Tool results are structured JSON, never prose. The ✶ marker flags tools that route through the relevance gate.

| Tool | What it does | When to pick it |
| --- | --- | --- |
| `vectorSearch` ✶ | Hybrid BM25 + vector search with optional graph expansion, across one or more universes. | Default entry point for open-ended factual questions. |
| `entitySearch` ✶ | Semantic search restricted to `Entity` nodes; returns aliases, linked documents and outgoing `RELATED` triples. | "Who/what is X?", "tell me about X". |
| `findEntityMentions` ✶ | Exact chunk-level passages mentioning an entity id. | Turning an entity result into citable passages. |
| `findRelatedDocs` ✶ | Documents related to a given document via shared entities / topics / explicit references (weighted mix). | "What else discusses Z?". |
| `findPath` | BFS shortest path between two known node ids; returns a narrative summary of the chain. | "How are X and Y connected?". |
| `topicHierarchy` | Parent/child tree built from `PART_OF` edges, optionally rooted. | Exploring how topics nest. |
| `graphNavigate` ✶ | Semantic neighborhood of a node (excludes `CONTAINS`/`TAGGED` by default). | Inspecting a specific node after you have its id. |
| `navigate` ✶ | Goal-directed one-hop walk; returns the three most relevant next nodes with reasons. | Active traversal of the graph toward an answer. |
| `sampleKnowledge` ✶ | Random, recent or MMR-diverse sample of chunks / summaries. | Producing overviews when no query is available. |
| `getDocumentSummary` | Fetch the Analyzer-produced summary of a document (also populates the evidence cache). | After `vectorSearch` returns a `doc_summary` seed. |
| `getChunk` | Read a specific chunk id verbatim (also populates the evidence cache). | Quoting or double-checking a passage. |
| `inspect` | Pull the full text of a cached (or fetched) source into the main context. | Drilling after the compact relevance output. |
| `quote` | Extract 1–3 verbatim supporting sentences from a cached source. | Single-sentence citations without bulk. |
| `summarizeSubthread` | Runs a focused sub-generation over selected source ids and returns only the synthetic answer. | Synthesizing many retrieved passages without blowing up the main context. |
| `saveAgentNote` | Persist an insight (graph + vector). Links to the supporting documents with `DERIVED_FROM_DOC`. | Useful facts worth remembering across turns. |
| `recallAgentMemory` | Vector search over previously saved notes. | At the start of a turn when prior reasoning might apply. |
| `listTopics` / `listDomains` / `listEntities` | Enumerate universe topology. | Orienting in an unfamiliar universe. |

## System prompt

The system prompt (see `Agent.ts`) contains:

- The active universe list (id + name).
- A concise graph-schema reminder (node types, edge types).
- The **language directive**: the agent answers in the user's language unless the user writes in another language.
- The **scan → filter → drill → synthesize** loop that mandates compact refs first, `inspect` / `quote` / `summarizeSubthread` for drilling, and active navigation via `navigate`.
- A **tool-selection rubric** with concrete example chains (e.g. "`Marie Curie`" → `entitySearch` → `navigate` → `findEntityMentions`).
- **Hard rules**: no fabrication, no identical tool calls (loop detection), never restate full tool results, prefer summaries first, save notable insights, and the exact citation format (`[^source:<id>]`).
- Preference order for citation ids: `chunk:<fileId>:<idx>` > `ent:<type>:<slug>` > `doc:<fileId>`.

## Safety shell

Every tool is wrapped in `Agent.wrapTools`:

1. **Loop detection.** A stable fingerprint (`tool:${stableStringify(argsWithoutSubGoal)}`) is counted; identical calls beyond `LOOP_LIMIT` (default `3`) return a structured `{ error: "loop_detected", message }` and abort the turn via a shared `AbortController`. The `subGoal` field is stripped from the fingerprint so refinement of the relevance gate does not count as a loop.
2. **Per-tool timeout.** The tool promise is raced against a `setTimeout` of `budget.toolTimeoutMs`. On timeout the tool resolves with `{ error: "tool_timeout", message }` instead of hanging the agent loop.
3. **Abort propagation.** An external `AbortSignal` (e.g. user clicks "stop generating") aborts the controller; the SDK unwinds the stream cleanly and the agent still emits a final `onFinish` with the sources it has collected so far.

## Source tracking

`Agent.runAgent` installs a `recordSource` callback on the tool context. Every retrieval tool that returns a ranked hit calls `recordSource(hit)` with the normalized `source_id`. The callback:

- Deduplicates by `source_id` (stronger score wins).
- Enforces `maxSources`: when the budget is exceeded, the weakest tracked source is evicted **only if** the incoming hit has a higher score.
- Produces the final `sources: SourceRef[]` array passed to `onFinish`, which the UI renders as clickable chips tied to inline `[^source:<id>]` markers.

## Context budgeting

1. **Snippets never enter the main context automatically.** Heavy tools return compact refs only; full text flows through `inspect` / `quote` / `summarizeSubthread` on demand.
2. **Summary-first retrieval.** Seeds prefer `doc_summary`; chunks are opened only when required.
3. **Graph before chunk.** When the user asks about relationships, `entitySearch` + `findPath` or iterative `navigate` tend to produce shorter, more targeted evidence than `vectorSearch`.
4. **Sub-thread summarization.** Long evidence stacks are collapsed via `summarizeSubthread` before they enter the main context. Inputs are read from the evidence cache when available to avoid redundant SQL round-trips.
5. **Memory recall.** `recallAgentMemory` is the cheapest grounding step — the agent uses it when the question matches prior reasoning.

## Tuning the budget

All values live in `AppSettings.agent` and are editable in Settings → Agent:

| Key | Default | Effect |
| --- | --- | --- |
| `maxSteps` | `12` | Maximum reasoning/tool steps per turn. |
| `toolTimeoutMs` | `30000` | Per-tool timeout (0 disables). |
| `maxSources` | `40` | Upper bound on the citation list for the final message. |
| `loopDetection` | `true` | Abort on repeated identical tool calls. |

Lower `maxSteps` for faster, cheaper answers; raise it for deep research. Disable `loopDetection` only when investigating an agent regression — it is almost always a symptom of a poor system prompt or a flaky tool.
