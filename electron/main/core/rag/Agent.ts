import { streamText, type CoreMessage, type Tool } from "ai";
import log from "electron-log/main.js";
import type { LLMProviderHandle } from "../providers/LLMProvider";
import type { UniverseBundle, AgentRetrievalConfig, EvidenceRecord } from "./Tools";
import { createTools, type ToolsContext } from "./Tools";
import { stableStringify } from "./agent-utils";
import type { Embedder } from "../providers/Embedder";
import type { SourceRef } from "../../../../shared/types";

export interface AgentBudget {
  maxSteps: number;
  toolTimeoutMs: number;
  maxSources: number;
  loopDetection: boolean;
}

export interface AgentInput {
  messages: CoreMessage[];
  universes: UniverseBundle[];
  embedder: Embedder;
  llm: LLMProviderHandle;
  saveAgentMemory: ToolsContext["saveAgentMemory"];
  recallAgentMemory: ToolsContext["recallAgentMemory"];
  language: string;
  budget: AgentBudget;
  retrieval: AgentRetrievalConfig;
  signal?: AbortSignal;
  onTextDelta: (delta: string) => void;
  onToolCall: (invocation: { id: string; name: string; input: unknown; output?: unknown; error?: string; startedAt: number; completedAt?: number }) => void;
  onFinish: (result: { text: string; sources: SourceRef[] }) => void;
  onError: (err: Error) => void;
}

const SYSTEM_PROMPT = (universes: UniverseBundle[], language: string) => `You are the autonomous knowledge-graph agent of RAGraph.

You have access to ${universes.length} knowledge universe(s): ${universes.map((u) => `"${u.name}" (id=${u.id})`).join(", ")}.

The backing store is a real property graph:
- Nodes: Document, Chunk, Entity (person/organization/product/concept/location/event), Topic, Domain, Keyword, AgentNote.
- Edges: CONTAINS (doc→chunk), ABOUT (doc→topic), MENTIONS (doc→entity, chunk→entity, with count), IN_DOMAIN, TAGGED (doc→keyword), RELATED (entity→entity, carries a typed \`predicate\` such as works_at / founded_by / located_in / causes / uses / part_of_org), PART_OF (topic hierarchy), REFERENCES_DOC (cross-document citation), SIMILAR_TO (consolidator-inferred), DERIVED_FROM_DOC (agent notes).

Answer in ${language === "de" ? "German" : language === "fr" ? "French" : language === "es" ? "Spanish" : "English"} unless the user writes in another language.

# How you work: MANDATORY retrieval workflow (query -> vector -> graph -> drill -> synthesize)

Every turn that is not purely conversational MUST follow these phases in order. Do NOT answer from parametric memory and do NOT skip phases 1-3.

## Phase 1 - Formulate a retrieval query (no tool call)

Before any tool call, write (internally) ONE precise retrieval query that captures what needs to be grounded:
- Drop filler words ("please tell me about ...").
- Keep proper nouns, technical terms and the key relation the question is really about.
- If the question has several parts, pick the primary sub-question for the first retrieval; handle the others in later iterations.
This query is what you will pass to \`vectorSearch\` in phase 2 and re-use as \`subGoal\` for the graph tools in phase 3.

## Phase 2 - Vector search FIRST (always)

Your very first tool call in a turn MUST be \`vectorSearch(query, subGoal)\` against the vector DB, unless the user message is clearly pure chit-chat with no retrievable claim (greetings, meta-questions about the app).
- Use the query from phase 1.
- Start with \`topK=8\` and \`expandViaGraph=true\` (default) — this already seeds a small graph neighborhood around the best hits.
- Optionally narrow via \`kinds\` (e.g. \`["doc_summary"]\` for a landscape view, \`["chunk"]\` for passage-level evidence).

Read the compact refs and pick 1-3 promising \`sourceId\`s (high/medium relevance). These seeds drive phase 3.

## Phase 3 - Gather context through the graph

Vector hits alone are rarely enough — walk the graph to pull in the real answer:
- For entities mentioned in the seeds or the question -> \`entitySearch(name, subGoal)\` to get aliases, top documents and outgoing RELATED triples.
- For a seed document or entity -> \`navigate(nodeId, goal)\` iteratively; pick the next \`nextNodeId\` from the returned candidates and repeat until you have what you need.
- "How are X and Y connected?" -> \`findPath(fromId, toId)\` after locating both ids via \`entitySearch\`.
- "What else discusses this?" -> \`findRelatedDocs(documentId, via="all", subGoal)\`.
- "Where exactly is entity E mentioned?" -> \`findEntityMentions(entityId, subGoal)\`.
- Wider neighborhood survey -> \`graphNavigate(nodeId, subGoal)\`.
- Unfamiliar universe with no obvious seed -> \`listDomains\` -> \`listTopics\` / \`topicHierarchy\` -> back to \`vectorSearch\` on the most promising topic.

Keep walking the graph until every claim you intend to make has at least one concrete \`sourceId\` behind it. Stop as soon as the evidence is sufficient; don't explore for exploration's sake.

## Phase 4 - Drill for exact text

For every claim you will actually write in the answer, load the supporting passage:
- \`inspect(sourceId)\` — pulls the full passage into context.
- \`quote(sourceId, question)\` — returns 1-3 verbatim supporting sentences (cheaper than inspect).
- \`summarizeSubthread(sourceIds, subQuestion)\` — synthesize many passages in a sub-thread without bloating the main context.

## Phase 5 - Synthesize

Write the final answer with inline \`[^source:<id>]\` citations. Be concise and structured (markdown lists, headings, tables).

# How retrieval results look

Retrieval tools run in TWO layers. You only see the outer (compact) layer:
- Heavy tools (\`vectorSearch\`, \`entitySearch\`, \`findEntityMentions\`, \`findRelatedDocs\`, \`graphNavigate\`, \`sampleKnowledge\`, \`navigate\`) feed their full output into an internal relevance sub-LLM that keeps only what actually supports the current goal.
- Each tool result therefore contains: \`{ sourceId, kind, title, relevance: "high"|"medium"|"low", why }\`. Snippets are deliberately omitted — use \`inspect\` / \`quote\` when you need the text.
- Prefer "high" relevance entries. Fall back to "medium" when no "high" hit answers the claim. Ignore "low".

Every heavy tool accepts an optional \`subGoal\` argument — use it to tell the gate what you are actually looking for on THIS call (e.g. "find companies that Marie Curie co-founded, not just mentions of her name"). The default is the user's original question.

# Example chains (all follow phase 1 -> 2 -> 3 -> 4 -> 5)

- "Welche Firmen wurden von Marie Curie gegründet?"
  1. Query: \`Marie Curie founded companies\`.
  2. \`vectorSearch("Marie Curie founded companies", subGoal="gegründete Firmen")\`.
  3. \`entitySearch("Marie Curie", subGoal="gegründete Firmen")\` -> \`navigate(marieCurieId, goal="gegründete Firmen")\` -> for each candidate company: \`findEntityMentions(companyId, subGoal=...)\`.
  4. \`quote(chunkId, "gründete ...")\` for verbatim evidence.
  5. Answer with chunk-level citations.
- "Wie hängen LangChain und LlamaIndex zusammen?"
  1. Query: \`relationship between LangChain and LlamaIndex\`.
  2. \`vectorSearch(...)\` to seed.
  3. \`entitySearch("LangChain")\`, \`entitySearch("LlamaIndex")\` -> \`findPath(aId, bId)\`.
  4. \`quote\` the narrative edges.
  5. Synthesize and cite.
- "Zusammenfassung aller Dokumente über 'climate policy'?"
  1. Query: \`climate policy overview\`.
  2. \`vectorSearch("climate policy", kinds=["doc_summary"], subGoal="overview")\`.
  3. For each top doc: \`findRelatedDocs(docId, via="all")\` to widen the set.
  4. \`summarizeSubthread([docIds], "summary of climate policy docs")\`.
  5. Structured summary with citations.

# Hard rules

- NEVER fabricate facts. Every non-trivial claim must be grounded in a retrieved source.
- ALWAYS start with \`vectorSearch\` (phase 2). Do NOT call \`entitySearch\`, \`findPath\`, \`navigate\`, \`graphNavigate\`, \`findRelatedDocs\` or \`findEntityMentions\` as the FIRST tool of a turn — they need seed ids from the vector pass. The only exceptions are \`listDomains\` / \`listTopics\` / \`topicHierarchy\` for a truly unfamiliar universe, which must still be followed by \`vectorSearch\` before any graph walk.
- After \`vectorSearch\` returns seeds, ALWAYS continue into the graph (phase 3) before answering, unless the vector hits alone already contain the exact, citable evidence and the question is strictly about a single passage.
- NEVER restate full tool results in your reasoning. Reference them only by sourceId and only inspect/quote them when the compact reason is insufficient.
- Do NOT call the same tool with the exact same arguments (including \`subGoal\`) more than twice. The loop guard will reply with \`{ error: "loop_detected" }\`; when you see that, STOP retrying that call — switch to a different tool, vary the query / topK / kinds / universe, or synthesize the final answer from what you already have.
- Do NOT paraphrase \`subGoal\` / \`query\` / \`topK\` merely to keep calling the same tool. Each tool has a strict per-turn budget (roughly: \`vectorSearch\` ≤ 6, \`entitySearch\` / \`findEntityMentions\` / \`findRelatedDocs\` / \`graphNavigate\` ≤ 4, \`navigate\` ≤ 6, \`quote\` / \`inspect\` ≤ 10). Over the limit the tool returns \`{ error: "per_tool_budget_exceeded" }\` — when you see that, STOP retrying that tool and either switch tool or answer now.
- The whole turn has a soft total-call budget of ~${SOFT_TOTAL_BUDGET} tool calls. Past that, heavy retrieval tools return \`{ error: "soft_total_budget_exceeded" }\` and only \`quote\` / \`inspect\` / \`summarizeSubthread\` / \`saveAgentNote\` remain usable. When you see that error, produce the final grounded answer immediately — do NOT keep exploring.
- If a tool returns \`{ error: "tool_timeout" }\`, try ONCE more with a narrower query or fewer results; otherwise pivot to a different tool or answer with the evidence collected so far.
- As soon as you have citable evidence for every claim you intend to make, STOP retrieving and write the final answer. A good answer with 3 solid citations is infinitely better than 20 tool calls without one.
- Prefer summaries first; drill into chunks only when the summary does not answer the question.
- Save notable insights with saveAgentNote when they will matter for future turns.

# Citation requirements (critical — the UI renders the exact passage)

- Each factual claim MUST be followed by [^source:<id>] with a sourceId returned by a tool.
- ALWAYS prefer the most specific sourceId available. In order of preference:
  1. chunk:<fileId>:<idx>   — the UI scrolls the PDF / document to that exact passage and highlights it.
  2. ent:<type>:<slug>      — when citing an entity definition / relation.
  3. doc:<fileId>            — ONLY when no chunk-level source is available.
- Never cite doc:<fileId> alone when you have a chunk-level id for the same claim.
- Finish with a "Sources" section listing every cited id. Be concise, structured, and use markdown (lists, headings, tables, code blocks).`;

const LOOP_LIMIT = 3;

/**
 * Per-tool call-count budget for a single agent turn. Independent of arguments
 * — this is the coarse guard that prevents the model from paraphrasing the
 * `subGoal` or nudging `topK` / `query` just enough to bypass the exact-args
 * loop detector and hammer the same tool twenty times in a row (observed in
 * production: 17 × vectorSearch on the same document with slightly different
 * `subGoal` each call, never producing a final answer).
 *
 * Numbers are deliberately generous: well-behaved chains rarely approach
 * them, but truly abusive repetition hits the wall and receives a structured
 * "stop exploring, synthesize now" error that the model can act on.
 */
const PER_TOOL_LIMITS: Record<string, number> = {
  vectorSearch: 6,
  entitySearch: 4,
  findEntityMentions: 4,
  findRelatedDocs: 4,
  graphNavigate: 4,
  navigate: 6,
  sampleKnowledge: 2,
  findPath: 3,
  quote: 10,
  inspect: 10,
  summarizeSubthread: 3,
  getDocumentSummary: 6,
  getChunk: 10,
  listTopics: 2,
  listDomains: 2,
  listEntities: 2,
  topicHierarchy: 2,
};
const DEFAULT_PER_TOOL_LIMIT = 6;

/**
 * Soft limit on the total number of tool calls in a single turn. Once crossed
 * we stop accepting further HEAVY retrieval calls and ask the model to
 * synthesize from what it already has. Drill tools (`quote`, `inspect`) and
 * memory writes (`saveAgentNote`) are still allowed so the model can pull in
 * citations for the final answer.
 */
const SOFT_TOTAL_BUDGET = 18;
const HEAVY_TOOLS = new Set([
  "vectorSearch",
  "entitySearch",
  "findEntityMentions",
  "findRelatedDocs",
  "graphNavigate",
  "navigate",
  "sampleKnowledge",
  "findPath",
  "listTopics",
  "listDomains",
  "listEntities",
  "topicHierarchy",
]);

/**
 * Extract a compact goal string from the conversation history. We prefer the
 * last user message (text parts only) — that is what drives the relevance
 * gate for every tool call in this turn.
 */
function extractGoal(messages: CoreMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content.trim();
    if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const c of m.content) {
        if (c && typeof c === "object" && "type" in c && c.type === "text" && typeof (c as { text?: unknown }).text === "string") {
          parts.push(String((c as { text: string }).text));
        }
      }
      if (parts.length) return parts.join("\n").trim();
    }
  }
  return "";
}

export async function runAgent(input: AgentInput): Promise<void> {
  const sourcesBySourceId = new Map<string, SourceRef & { score: number }>();
  const budget = input.budget;
  const evidence = new Map<string, EvidenceRecord>();
  const goalRef = { current: extractGoal(input.messages) };

  const toolCtx: ToolsContext = {
    universes: input.universes,
    embedder: input.embedder,
    llm: input.llm,
    saveAgentMemory: input.saveAgentMemory,
    recallAgentMemory: input.recallAgentMemory,
    retrieval: input.retrieval,
    evidence,
    goalRef,
    recordSource: (hit) => {
      const key = hit.source_id;
      const existing = sourcesBySourceId.get(key);
      const score = hit.score ?? 0;
      if (existing && existing.score >= score) return;
      if (!existing && sourcesBySourceId.size >= budget.maxSources) {
        let weakest: [string, number] | null = null;
        for (const [k, v] of sourcesBySourceId.entries()) {
          if (!weakest || v.score < weakest[1]) weakest = [k, v.score];
        }
        if (weakest && weakest[1] >= score) return;
        if (weakest) sourcesBySourceId.delete(weakest[0]);
      }
      sourcesBySourceId.set(key, {
        id: hit.source_id,
        kind: hit.kind,
        title: hit.title,
        universeId: hit.universe_id,
        universeName: hit.universeName,
        fileId: hit.file_id || null,
        graphNodeId: hit.graph_node_id || null,
        snippet: hit.text.slice(0, 400),
        score,
      });
    },
  };

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", forwardAbort, { once: true });
  }

  const baseTools = createTools(toolCtx);
  const callFingerprints = new Map<string, number>();
  const perToolCounts = new Map<string, number>();
  const totalCounter = { total: 0 };
  const tools = wrapTools(baseTools, {
    toolTimeoutMs: budget.toolTimeoutMs,
    loopDetection: budget.loopDetection,
    callFingerprints,
    perToolCounts,
    totalCounter,
  });

  const invocationsById = new Map<string, { startedAt: number }>();

  try {
    const result = streamText({
      model: input.llm.chatModel,
      system: SYSTEM_PROMPT(input.universes, input.language),
      messages: input.messages,
      tools,
      maxSteps: Math.max(1, budget.maxSteps),
      abortSignal: controller.signal,
      temperature: 0.3,
      onStepFinish: (step) => {
        for (const tc of step.toolCalls ?? []) {
          invocationsById.set(tc.toolCallId, { startedAt: Date.now() });
          input.onToolCall({
            id: tc.toolCallId,
            name: tc.toolName,
            input: tc.args,
            startedAt: Date.now(),
          });
        }
        for (const tr of (step.toolResults ?? []) as Array<{
          toolCallId: string;
          toolName: string;
          args: unknown;
          result: unknown;
        }>) {
          const started = invocationsById.get(tr.toolCallId)?.startedAt ?? Date.now();
          input.onToolCall({
            id: tr.toolCallId,
            name: tr.toolName,
            input: tr.args,
            output: tr.result,
            startedAt: started,
            completedAt: Date.now(),
          });
        }
      },
    });

    let full = "";
    for await (const delta of result.textStream) {
      full += delta;
      input.onTextDelta(delta);
    }
    input.onFinish({ text: full, sources: Array.from(sourcesBySourceId.values()) });
  } catch (err) {
    if (controller.signal.aborted && !input.signal?.aborted) {
      input.onFinish({
        text: "",
        sources: Array.from(sourcesBySourceId.values()),
      });
      return;
    }
    input.onError(err as Error);
  } finally {
    input.signal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Options accepted by `wrapTools`. Exported for unit tests that want to
 * exercise the safety shell without spinning up a real LLM / streamText loop.
 */
export interface WrapOptions {
  toolTimeoutMs: number;
  loopDetection: boolean;
  callFingerprints: Map<string, number>;
  /** Per-tool call count for this turn. Independent of args. */
  perToolCounts: Map<string, number>;
  /** Shared counter for the total number of tool calls this turn. */
  totalCounter: { total: number };
}

export const __internals = {
  PER_TOOL_LIMITS,
  DEFAULT_PER_TOOL_LIMIT,
  SOFT_TOTAL_BUDGET,
  HEAVY_TOOLS,
  LOOP_LIMIT,
} as const;

/**
 * Wrap every tool in a safety shell:
 *   1. **Per-tool budget** (coarse). Each tool has a hard cap per turn
 *      (`PER_TOOL_LIMITS`) that is independent of arguments. This stops the
 *      model from paraphrasing `subGoal` / `query` / `topK` to bypass the
 *      fingerprint loop guard and call the same tool 15+ times.
 *   2. **Soft total budget.** After `SOFT_TOTAL_BUDGET` tool calls we start
 *      rejecting further HEAVY exploration calls with a "synthesize now"
 *      error. Drill tools (`quote`, `inspect`, `summarizeSubthread`) and
 *      `saveAgentNote` are still allowed so the model can finish citations.
 *   3. **Loop detection (fingerprint).** Identical calls with identical args
 *      beyond `LOOP_LIMIT` return a structured error. `subGoal` is part of
 *      the fingerprint so a genuine goal refinement does not trip the guard.
 *      The outer stream is **not** aborted — aborting was the root cause of
 *      empty assistant messages when the model retried a slow tool a few
 *      times in a row.
 *   4. **Per-tool timeout** via `raceWithTimeout`, so a hung provider call
 *      resolves with a structured error instead of blocking the agent loop.
 * The wrapper keeps Zod parameter schemas intact so the AI SDK still validates.
 */
export function wrapTools<T extends Record<string, Tool>>(
  base: T,
  opts: WrapOptions,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(base)) {
    const perToolLimit = PER_TOOL_LIMITS[name] ?? DEFAULT_PER_TOOL_LIMIT;
    wrapped[name] = {
      ...t,
      execute: async (args: unknown, ctx: { toolCallId?: string; messages?: unknown; abortSignal?: AbortSignal }) => {
        const toolCount = (opts.perToolCounts.get(name) ?? 0) + 1;
        opts.perToolCounts.set(name, toolCount);
        opts.totalCounter.total += 1;

        if (toolCount > perToolLimit) {
          log.warn("agent.per_tool_budget_exceeded", { tool: name, count: toolCount, limit: perToolLimit });
          return {
            error: "per_tool_budget_exceeded",
            message:
              `You have already called "${name}" ${toolCount - 1} times this turn (limit ${perToolLimit}). Stop repeating this tool — switch to a different tool or, if you already have enough evidence, produce the final answer now with inline [^source:<id>] citations. Do NOT retry this call.`,
          };
        }

        if (opts.totalCounter.total > SOFT_TOTAL_BUDGET && HEAVY_TOOLS.has(name)) {
          log.warn("agent.soft_total_budget_exceeded", {
            tool: name,
            total: opts.totalCounter.total,
            softLimit: SOFT_TOTAL_BUDGET,
          });
          return {
            error: "soft_total_budget_exceeded",
            message:
              `You have already made ${opts.totalCounter.total - 1} tool calls this turn (soft limit ${SOFT_TOTAL_BUDGET}). Further heavy retrieval is disabled for this turn. Synthesize the final answer NOW from the evidence already gathered, using "quote" or "inspect" only if you are missing an exact citation.`,
          };
        }

        if (opts.loopDetection) {
          const fingerprint = `${name}:${stableStringify(args)}`;
          const count = (opts.callFingerprints.get(fingerprint) ?? 0) + 1;
          opts.callFingerprints.set(fingerprint, count);
          if (count > LOOP_LIMIT) {
            log.warn("agent.loop_detected", { tool: name, count });
            return {
              error: "loop_detected",
              message:
                "This tool has already been called with identical arguments. Stop repeating: either vary the query / topK / kinds / universeId, switch to a different tool, or produce the final answer from what you already have.",
            };
          }
        }

        const inner = (t.execute as (a: unknown, c: unknown) => Promise<unknown>)(args, ctx);
        if (!opts.toolTimeoutMs) return inner;
        return await raceWithTimeout(name, inner, opts.toolTimeoutMs, ctx.abortSignal);
      },
    } as Tool;
  }
  return wrapped;
}

async function raceWithTimeout<T>(tool: string, p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | { error: string; message: string }> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeout = new Promise<{ error: string; message: string }>((resolve) => {
      timer = setTimeout(() => {
        log.warn("agent.tool_timeout", { tool, ms });
        resolve({
          error: "tool_timeout",
          message: `Tool "${tool}" exceeded the ${ms}ms timeout. Try a narrower query or a different tool.`,
        });
      }, ms);
    });
    const abort = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new Error("aborted"));
      if (signal?.aborted) reject(new Error("aborted"));
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    return (await Promise.race([p, timeout, abort])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
