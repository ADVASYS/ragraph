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

# How you work: scan -> filter -> drill -> synthesize

Retrieval tools run in TWO layers. You only see the outer (compact) layer:
- Heavy tools (vectorSearch, entitySearch, findEntityMentions, findRelatedDocs, graphNavigate, sampleKnowledge, navigate) feed their full output into an internal relevance sub-LLM. That sub-LLM keeps only what actually supports the current goal.
- Each tool result therefore contains: { sourceId, kind, title, relevance: "high"|"medium"|"low", why }. Snippets are deliberately omitted.
- When you need the exact text, call:
  * inspect(sourceId)           — pulls the full passage into context.
  * quote(sourceId, question)   — returns 1-3 verbatim supporting sentences (cheaper than inspect).
  * summarizeSubthread(sourceIds, subQuestion) — synthesizes many passages in a sub-thread.
- Prefer "high" relevance entries. Only fall back to "medium" when no "high" hit answers the claim. Ignore "low".

Every heavy tool accepts an optional \`subGoal\` argument — use it to tell the gate what you are actually looking for on THIS call (e.g. "find companies that Marie Curie co-founded, not just mentions of her name"). The default is the user's original question.

# Active navigation

Use \`navigate(nodeId, goal)\` to walk the graph one hop at a time. It returns at most 3 neighbors judged relevant to your goal, each with a short reason and the connecting edge(s). Iterate: navigate -> pick the next nodeId -> navigate again. This is the preferred way to answer relational questions ("how does X relate to Y through the graph?").

# Tool-selection rubric

1. "Who/what is X?" / "tell me about X" -> entitySearch(X, subGoal). Read the compact refs + the inlined triples / linkedDocuments (these are safe to keep — they are short). Drill into promising triples via navigate(entityId, goal) or findEntityMentions(entityId).
2. Open-ended factual question -> vectorSearch(query, subGoal). Then inspect(bestSourceId) or quote(bestSourceId, ...) for citations.
3. "How are X and Y related?" -> entitySearch for both, then findPath(fromId, toId) for a narrative, OR navigate() iteratively for a goal-directed walk.
4. "What documents also discuss Z?" -> findRelatedDocs(documentId, via="all", subGoal).
5. "Which passages mention entity E?" -> findEntityMentions(entityId, subGoal).
6. Unfamiliar universe -> listDomains -> listTopics or topicHierarchy -> vectorSearch on the most promising topic.
7. Need to survey a neighborhood -> graphNavigate(nodeId, subGoal); for goal-directed walking use navigate(nodeId, goal).
8. Need to synthesize several retrieved passages without bloating context -> summarizeSubthread(sourceIds, subQuestion).

# Example chains

- "Welche Firmen wurden von Marie Curie gegründet?" -> entitySearch("Marie Curie", subGoal="gegründete Firmen") -> navigate(marieCurieId, goal="gegründete Firmen") -> for the best candidate entity: findEntityMentions(companyId, subGoal=...) -> quote(chunkId, "gründete ...").
- "Wie hängen LangChain und LlamaIndex zusammen?" -> entitySearch("LangChain"), entitySearch("LlamaIndex") -> findPath(aId, bId) -> cite the narrative.
- "Zusammenfassung aller Dokumente über 'climate policy'?" -> listTopics -> pick topic -> vectorSearch(topic name, kinds=["doc_summary"], subGoal="summary of climate policy docs").

# Hard rules

- NEVER fabricate facts. Every non-trivial claim must be grounded in a retrieved source.
- NEVER restate full tool results in your reasoning. Reference them only by sourceId and only inspect/quote them when the compact reason is insufficient.
- Do NOT call the same tool with the same (non-subGoal) arguments more than twice — the loop detector will abort the turn. Vary the query, kinds, or universe when retrying.
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
  const tools = wrapTools(baseTools, {
    toolTimeoutMs: budget.toolTimeoutMs,
    loopDetection: budget.loopDetection,
    callFingerprints,
    abort: () => controller.abort(),
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

interface WrapOptions {
  toolTimeoutMs: number;
  loopDetection: boolean;
  callFingerprints: Map<string, number>;
  abort: () => void;
}

/**
 * Wrap every tool in a safety shell:
 *   1. Loop detection (abort after N identical calls with identical args).
 *      The `subGoal` field is stripped from the fingerprint so the agent can
 *      retry the same query with a sharper goal without tripping the guard.
 *   2. Per-tool timeout that resolves with a structured error instead of hanging.
 * The wrapper keeps Zod parameter schemas intact so the AI SDK still validates.
 */
function wrapTools<T extends Record<string, Tool>>(
  base: T,
  opts: WrapOptions,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(base)) {
    wrapped[name] = {
      ...t,
      execute: async (args: unknown, ctx: { toolCallId?: string; messages?: unknown; abortSignal?: AbortSignal }) => {
        const fingerprintArgs = stripSubGoal(args);
        const fingerprint = `${name}:${stableStringify(fingerprintArgs)}`;
        if (opts.loopDetection) {
          const count = (opts.callFingerprints.get(fingerprint) ?? 0) + 1;
          opts.callFingerprints.set(fingerprint, count);
          if (count > LOOP_LIMIT) {
            log.warn("agent.loop_detected", { tool: name, count });
            opts.abort();
            return {
              error: "loop_detected",
              message:
                "This tool has already been called with identical arguments. Stop repeating and either vary the query or answer with what you already have.",
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

/** Remove the `subGoal` key from a tool-args object so loop detection only compares the structural arguments. */
function stripSubGoal(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  delete copy["subGoal"];
  return copy;
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
