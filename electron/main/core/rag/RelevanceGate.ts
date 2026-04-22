import { generateObject, generateText, type LanguageModel } from "ai";
import { z } from "zod";
import log from "electron-log/main.js";
import type { LLMProviderHandle } from "../providers/LLMProvider";

/**
 * Candidate item the relevance gate evaluates. The gate is generic over the
 * caller's record shape but always needs at minimum a `sourceId`, a `title`
 * and a `text` window for the sub-LLM to read.
 */
export interface GateCandidate {
  sourceId: string;
  title: string;
  text: string;
  /** Optional free-form hints that help the gate judge relevance (kind, predicate, edge label, ...). */
  hint?: string;
}

export interface GateInput {
  llm: LLMProviderHandle;
  /**
   * Current agent goal — typically the last user message, optionally refined
   * by a per-tool `subGoal` argument.
   */
  goal: string;
  toolName: string;
  items: GateCandidate[];
  /** Upper bound on the `kept` list returned to the main model. */
  maxKeep?: number;
  /** Abort signal from the parent tool wrapper. */
  signal?: AbortSignal;
  /**
   * Hard internal timeout for the sub-LLM call. Prevents a single flaky
   * provider response from consuming the outer tool budget. Defaults to 12s.
   */
  timeoutMs?: number;
}

export type Relevance = "high" | "medium" | "low";

export interface GateVerdict {
  sourceId: string;
  relevance: Relevance;
  why: string;
}

export interface GateOutput {
  kept: GateVerdict[];
  droppedIds: string[];
}

const DEFAULT_MAX_KEEP = 6;
/**
 * Hard budget for the sub-LLM gate call. Kept well below the outer tool
 * timeout (default 30s) so that slow gates never cause the surrounding heavy
 * tool (vectorSearch / entitySearch / ...) to hit its own timeout — otherwise
 * the main model sees `tool_timeout`, retries the same call, and eventually
 * trips the loop guard. The structured and prose passes each get this budget.
 */
const DEFAULT_TIMEOUT_MS = 6_000;
/** If there are this many (or fewer) candidates we skip the sub-LLM entirely. */
const TRIVIAL_ITEMS_THRESHOLD = 2;

const verdictSchema = z.object({
  kept: z
    .array(
      z.object({
        sourceId: z.string(),
        relevance: z.enum(["high", "medium", "low"]),
        why: z.string().max(240),
      }),
    )
    .default([]),
  droppedIds: z.array(z.string()).default([]),
});

/**
 * Run the full tool output through a tiny sub-context call that returns only
 * compact relevance verdicts. The main agent loop then receives nothing but
 * (sourceId, relevance, one-line reason) — snippets stay in the evidence cache.
 *
 * Implementation order (fall through on failure so the agent never stalls):
 *   1. `generateObject` with a Zod schema (strict JSON, works on most
 *      OpenAI-compatible providers via json-mode / tool-calling).
 *   2. `generateText` + loose JSON parsing (covers providers without
 *      structured-output support).
 *   3. Keep-all fallback (every candidate returned at `medium` relevance).
 *
 * The whole sub-LLM call is wrapped in an internal timeout so a slow gate
 * cannot push the surrounding tool past its own timeout budget.
 */
export async function evaluateRelevance(input: GateInput): Promise<GateOutput> {
  const maxKeep = Math.max(1, input.maxKeep ?? DEFAULT_MAX_KEEP);
  if (!input.items.length) return { kept: [], droppedIds: [] };

  // Short-circuit trivially small result sets — invoking the model costs more
  // than the filtering is worth, and the agent can still drop them later.
  if (input.items.length <= TRIVIAL_ITEMS_THRESHOLD) {
    return trivialKeepAll(input.items);
  }

  const numbered = input.items.map((it, idx) => ({
    n: idx + 1,
    sourceId: it.sourceId,
    title: it.title?.trim() || "(untitled)",
    hint: it.hint?.trim() || "",
    text: truncate(it.text ?? "", 1000),
  }));

  const system = [
    "You are a relevance filter inside a RAG agent.",
    "You receive the user's current goal and a list of retrieval candidates.",
    "Decide which candidates are worth returning to the outer agent.",
    "Keep the output compact: at most " + maxKeep + " high/medium entries.",
    "Drop everything that does not actually help answer the goal.",
    'Use "high" only when the candidate directly supports the goal, "medium" for supporting context, "low" for weak tangential links.',
    "`why` must be a single sentence (<=140 chars) and must not quote the candidate verbatim.",
  ].join("\n");

  const prompt = [
    `Goal: ${input.goal || "(no explicit goal — infer from context)"}`,
    `Tool that produced these candidates: ${input.toolName}`,
    "",
    "Candidates:",
    numbered
      .map(
        (c) =>
          `#${c.n} sourceId=${c.sourceId}\n  title: ${c.title}${c.hint ? `\n  hint: ${c.hint}` : ""}\n  text: ${c.text}`,
      )
      .join("\n\n"),
  ].join("\n");

  const timeoutMs = Math.max(1000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const validIds = new Set(input.items.map((it) => it.sourceId));

  try {
    const parsed = await withTimeout(
      timeoutMs,
      input.signal,
      async (signal) => runStructured(input.llm.chatModel, system, prompt, signal),
    );
    return shapeVerdict(parsed, input.items, validIds, maxKeep);
  } catch (structuredErr) {
    const msg = (structuredErr as Error).message;
    // Only attempt the prose fallback if the provider or the schema rejected
    // the structured call — not if the caller aborted or we hit our timeout.
    if (msg === "aborted" || msg === "gate_timeout") {
      log.warn("relevance_gate.skipped", { tool: input.toolName, items: input.items.length, reason: msg });
      return fallbackKeepAll(input.items, maxKeep);
    }
    try {
      const text = await withTimeout(
        timeoutMs,
        input.signal,
        async (signal) => runProse(input.llm.chatModel, system, prompt, signal),
      );
      const loose = parseJsonLoose(text);
      if (!loose) throw new Error("gate_response_not_json");
      return shapeVerdict(verdictSchema.parse(coerceVerdictShape(loose)), input.items, validIds, maxKeep);
    } catch (textErr) {
      log.warn("relevance_gate.fallback", {
        tool: input.toolName,
        items: input.items.length,
        structured: msg,
        prose: (textErr as Error).message,
      });
      return fallbackKeepAll(input.items, maxKeep);
    }
  }
}

async function runStructured(
  model: LanguageModel,
  system: string,
  prompt: string,
  signal: AbortSignal,
): Promise<z.infer<typeof verdictSchema>> {
  const res = await generateObject({
    model,
    schema: verdictSchema,
    system,
    prompt,
    temperature: 0,
    maxTokens: 300,
    abortSignal: signal,
  });
  return res.object;
}

async function runProse(
  model: LanguageModel,
  system: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const res = await generateText({
    model,
    system: system + "\nRespond with STRICT JSON only — no prose, no markdown fences.",
    prompt: prompt + "\n\nReturn JSON now.",
    temperature: 0,
    maxTokens: 300,
    abortSignal: signal,
  });
  return res.text;
}

function shapeVerdict(
  parsed: z.infer<typeof verdictSchema>,
  items: GateCandidate[],
  validIds: Set<string>,
  maxKeep: number,
): GateOutput {
  const kept: GateVerdict[] = [];
  for (const raw of parsed.kept ?? []) {
    if (!validIds.has(raw.sourceId)) continue;
    if (kept.find((k) => k.sourceId === raw.sourceId)) continue;
    kept.push({
      sourceId: raw.sourceId,
      relevance: raw.relevance,
      why: (raw.why ?? "").trim().slice(0, 240),
    });
    if (kept.length >= maxKeep) break;
  }
  const keptIds = new Set(kept.map((k) => k.sourceId));
  const droppedIds: string[] = [];
  for (const id of parsed.droppedIds ?? []) {
    if (validIds.has(id) && !keptIds.has(id)) droppedIds.push(id);
  }
  for (const it of items) {
    if (!keptIds.has(it.sourceId) && !droppedIds.includes(it.sourceId)) droppedIds.push(it.sourceId);
  }
  return { kept, droppedIds };
}

/**
 * Best-effort re-shaping when a prose response is loosely parsed. Some models
 * return `{ results: [...] }` or `{ dropped: [...] }` or use uppercase enum
 * values; normalise everything to our strict schema.
 */
function coerceVerdictShape(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.kept) && Array.isArray(obj.results)) obj.kept = obj.results;
  if (!Array.isArray(obj.droppedIds) && Array.isArray(obj.dropped)) obj.droppedIds = obj.dropped;
  if (Array.isArray(obj.kept)) {
    obj.kept = obj.kept
      .map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const e = entry as Record<string, unknown>;
        if (typeof e.relevance === "string") {
          const v = e.relevance.toLowerCase().trim();
          e.relevance = v === "high" || v === "medium" || v === "low" ? v : "medium";
        } else {
          e.relevance = "medium";
        }
        if (typeof e.why !== "string") e.why = "";
        if (typeof e.sourceId !== "string" && typeof e.source_id === "string") e.sourceId = e.source_id;
        return e;
      })
      .filter((e) => e && typeof e === "object" && typeof (e as Record<string, unknown>).sourceId === "string");
  }
  if (Array.isArray(obj.droppedIds)) {
    obj.droppedIds = obj.droppedIds.filter((x) => typeof x === "string");
  }
  return obj;
}

function trivialKeepAll(items: GateCandidate[]): GateOutput {
  const kept = items.map((it) => ({
    sourceId: it.sourceId,
    relevance: "medium" as const,
    why: "Trivially small result set; forwarded without relevance filter.",
  }));
  return { kept, droppedIds: [] };
}

function fallbackKeepAll(items: GateCandidate[], maxKeep: number): GateOutput {
  const kept = items.slice(0, maxKeep).map((it) => ({
    sourceId: it.sourceId,
    relevance: "medium" as const,
    why: "Relevance filter unavailable; returned as-is.",
  }));
  const keptIds = new Set(kept.map((k) => k.sourceId));
  const droppedIds = items.filter((it) => !keptIds.has(it.sourceId)).map((it) => it.sourceId);
  return { kept, droppedIds };
}

/**
 * Race the sub-LLM call against an internal timeout and the outer abort
 * signal. The inner operation receives a derived AbortSignal so network work
 * is actually cancelled when we give up.
 */
async function withTimeout<T>(
  ms: number,
  outerSignal: AbortSignal | undefined,
  op: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", forward, { once: true });
  }
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("gate_timeout"));
    }, ms);
  });
  try {
    return (await Promise.race([op(controller.signal), timeout])) as T;
  } finally {
    if (timer) clearTimeout(timer);
    outerSignal?.removeEventListener("abort", forward);
  }
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

/**
 * Best-effort JSON extraction — some models wrap the response in ```json fences
 * or prepend a short apology. We strip code fences and then fall back to the
 * first balanced `{ ... }` block if direct parsing fails.
 */
function parseJsonLoose(text: string): unknown | null {
  if (!text) return null;
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}
