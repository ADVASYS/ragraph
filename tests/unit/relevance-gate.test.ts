import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock both `generateObject` (primary path) and `generateText` (prose fallback).
// `vi.hoisted` is required because `vi.mock` is hoisted above imports.
const { state } = vi.hoisted(() => ({
  state: {
    objectResponse: null as unknown,
    objectError: null as Error | null,
    textResponse: "",
    textError: null as Error | null,
  },
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: vi.fn().mockImplementation(async () => {
      if (state.objectError) throw state.objectError;
      return { object: state.objectResponse };
    }),
    generateText: vi.fn().mockImplementation(async () => {
      if (state.textError) throw state.textError;
      return { text: state.textResponse };
    }),
  };
});

import { evaluateRelevance, __resetRelevanceGateBreakerForTests } from "../../electron/main/core/rag/RelevanceGate";
import type { LLMProviderHandle } from "../../electron/main/core/providers/LLMProvider";

const llm = {
  chatModel: {} as unknown as LLMProviderHandle["chatModel"],
  visionModel: {} as unknown as LLMProviderHandle["visionModel"],
  config: {
    baseUrl: "x",
    apiKey: "x",
    chatModel: "x",
    embeddingMode: "local",
  },
} as unknown as LLMProviderHandle;

beforeEach(() => {
  state.objectResponse = null;
  state.objectError = null;
  state.textResponse = "";
  state.textError = null;
  // The breaker is module-scoped; reset it so a prior test that induced a
  // structured failure does not disable the structured path for the next one.
  __resetRelevanceGateBreakerForTests();
});

describe("RelevanceGate.evaluateRelevance", () => {
  it("returns empty output for empty input without calling the model", async () => {
    const out = await evaluateRelevance({
      llm,
      goal: "anything",
      toolName: "vectorSearch",
      items: [],
    });
    expect(out).toEqual({ kept: [], droppedIds: [] });
  });

  it("short-circuits trivially small result sets without invoking the gate", async () => {
    state.objectError = new Error("should not be called");
    const out = await evaluateRelevance({
      llm,
      goal: "g",
      toolName: "t",
      items: [
        { sourceId: "a", title: "A", text: "aa" },
        { sourceId: "b", title: "B", text: "bb" },
      ],
    });
    expect(out.kept.map((k) => k.sourceId)).toEqual(["a", "b"]);
    expect(out.droppedIds).toEqual([]);
    for (const k of out.kept) expect(k.relevance).toBe("medium");
  });

  it("uses generateObject (structured) on the happy path", async () => {
    state.objectResponse = {
      kept: [
        { sourceId: "chunk:a", relevance: "high", why: "direct answer" },
        { sourceId: "chunk:b", relevance: "medium", why: "context" },
        { sourceId: "chunk:unknown", relevance: "high", why: "hallucinated" },
      ],
      droppedIds: ["chunk:c"],
    };
    const out = await evaluateRelevance({
      llm,
      goal: "what is X",
      toolName: "vectorSearch",
      items: [
        { sourceId: "chunk:a", title: "A", text: "aa" },
        { sourceId: "chunk:b", title: "B", text: "bb" },
        { sourceId: "chunk:c", title: "C", text: "cc" },
      ],
    });
    expect(out.kept).toEqual([
      { sourceId: "chunk:a", relevance: "high", why: "direct answer" },
      { sourceId: "chunk:b", relevance: "medium", why: "context" },
    ]);
    expect(out.droppedIds).toEqual(["chunk:c"]);
  });

  it("falls back to the line-list prose format when generateObject throws", async () => {
    state.objectError = new Error("provider rejected schema");
    // Small / local models reliably emit this line format; it is the primary
    // fallback before we even attempt loose JSON parsing.
    state.textResponse = [
      "#1 high: directly answers the goal",
      "#2 medium: adds supporting context",
      "#3 drop",
    ].join("\n");
    const out = await evaluateRelevance({
      llm,
      goal: "g",
      toolName: "t",
      items: [
        { sourceId: "s1", title: "", text: "aa" },
        { sourceId: "s2", title: "", text: "bb" },
        { sourceId: "s3", title: "", text: "cc" },
      ],
    });
    expect(out.kept).toEqual([
      { sourceId: "s1", relevance: "high", why: "directly answers the goal" },
      { sourceId: "s2", relevance: "medium", why: "adds supporting context" },
    ]);
    expect(out.droppedIds).toEqual(["s3"]);
  });

  it("accepts loose JSON as a final fallback when the line-list format is not produced", async () => {
    state.objectError = new Error("provider rejected schema");
    // Text does not match the line-list pattern, so the line-list parser
    // returns null and we fall through to the loose-JSON parser.
    state.textResponse =
      "```json\n" + JSON.stringify({ kept: [{ sourceId: "s1", relevance: "HIGH", why: "yep" }], droppedIds: [] }) + "\n```";
    const out = await evaluateRelevance({
      llm,
      goal: "g",
      toolName: "t",
      items: [
        { sourceId: "s1", title: "", text: "aa" },
        { sourceId: "s2", title: "", text: "bb" },
        { sourceId: "s3", title: "", text: "cc" },
      ],
    });
    expect(out.kept).toEqual([{ sourceId: "s1", relevance: "high", why: "yep" }]);
  });

  it("falls back to keep-all at medium when both paths fail", async () => {
    state.objectError = new Error("no structured output support");
    state.textResponse = "I'm sorry I cannot comply with this request.";
    const out = await evaluateRelevance({
      llm,
      goal: "g",
      toolName: "t",
      items: [
        { sourceId: "s1", title: "A", text: "aa" },
        { sourceId: "s2", title: "B", text: "bb" },
        { sourceId: "s3", title: "C", text: "cc" },
      ],
    });
    expect(out.kept).toHaveLength(3);
    for (const k of out.kept) {
      expect(k.relevance).toBe("medium");
      expect(k.why).toMatch(/unavailable/i);
    }
    expect(out.droppedIds).toEqual([]);
  });

  it("respects the maxKeep bound", async () => {
    state.objectResponse = {
      kept: [
        { sourceId: "a", relevance: "high", why: "1" },
        { sourceId: "b", relevance: "high", why: "2" },
        { sourceId: "c", relevance: "medium", why: "3" },
        { sourceId: "d", relevance: "medium", why: "4" },
      ],
      droppedIds: [],
    };
    const out = await evaluateRelevance({
      llm,
      goal: "g",
      toolName: "t",
      maxKeep: 2,
      items: [
        { sourceId: "a", title: "", text: "" },
        { sourceId: "b", title: "", text: "" },
        { sourceId: "c", title: "", text: "" },
        { sourceId: "d", title: "", text: "" },
      ],
    });
    expect(out.kept).toHaveLength(2);
    expect(out.kept.map((k) => k.sourceId)).toEqual(["a", "b"]);
    expect(out.droppedIds.sort()).toEqual(["c", "d"]);
  });
});
