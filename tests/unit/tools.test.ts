import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock both `generateObject` (primary gate path) and `generateText` (prose
// fallback) so the in-tool relevance gate never touches the network.
// `vi.hoisted` is required because `vi.mock` is hoisted above imports.
const { mockGenObj, mockGenText } = vi.hoisted(() => ({
  mockGenObj: vi.fn(async () => ({ object: { kept: [], droppedIds: [] } })),
  mockGenText: vi.fn(async () => ({ text: "" })),
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: mockGenObj, generateText: mockGenText };
});

import { createTools, type ToolsContext, type EvidenceRecord } from "../../electron/main/core/rag/Tools";
import type { LLMProviderHandle } from "../../electron/main/core/providers/LLMProvider";
import type { Embedder } from "../../electron/main/core/providers/Embedder";
import type { GraphStore } from "../../electron/main/core/storage/GraphStore";
import type { VectorStore, VectorSearchHit } from "../../electron/main/core/storage/VectorStore";

type ToolExecuteArgs = Record<string, unknown>;
type LooseTool = { execute: (args: ToolExecuteArgs, ctx: unknown) => Promise<unknown> };

function makeLlm(): LLMProviderHandle {
  return {
    chatModel: {} as unknown as LLMProviderHandle["chatModel"],
    visionModel: {} as unknown as LLMProviderHandle["visionModel"],
    config: {
      baseUrl: "x",
      apiKey: "x",
      chatModel: "x",
      embeddingMode: "local",
    },
  } as LLMProviderHandle;
}

function makeEmbedder(): Embedder {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Array(4).fill(0.1))),
  } as unknown as Embedder;
}

/** Minimal VectorStore stub exposing only the methods the tested tools call. */
function makeVectors(overrides: Partial<VectorStore> = {}): VectorStore {
  const base: Partial<VectorStore> = {
    search: vi.fn(async () => [] as VectorSearchHit[]),
    getBySourceIds: vi.fn(async () => new Map()),
    sample: vi.fn(async () => [] as VectorSearchHit[]),
  };
  return { ...base, ...overrides } as VectorStore;
}

/** Minimal GraphStore stub exposing only the methods the tested tools call. */
function makeGraph(overrides: Partial<GraphStore> = {}): GraphStore {
  const base: Partial<GraphStore> = {
    ftsSearch: vi.fn(async () => []),
    getNode: vi.fn(async () => null),
    getChunk: vi.fn(async () => null),
    getDocumentSummary: vi.fn(async () => null),
  };
  return { ...base, ...overrides } as GraphStore;
}

function makeCtx(overrides: Partial<ToolsContext> = {}): ToolsContext {
  const vectors = makeVectors();
  const graph = makeGraph();
  const evidence = new Map<string, EvidenceRecord>();
  const goalRef = { current: "test goal" };
  const base: ToolsContext = {
    universes: [
      {
        id: "u1",
        name: "Universe 1",
        graph,
        vectors,
      },
    ],
    embedder: makeEmbedder(),
    llm: makeLlm(),
    saveAgentMemory: vi.fn(async () => ({ id: "m1" })),
    recallAgentMemory: vi.fn(async () => []),
    recordSource: vi.fn(),
    evidence,
    goalRef,
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  mockGenObj.mockReset();
  mockGenObj.mockImplementation(async () => ({ object: { kept: [], droppedIds: [] } }));
  mockGenText.mockReset();
  mockGenText.mockImplementation(async () => ({ text: "" }));
});

describe("Tools.vectorSearch — compact return shape", () => {
  it("strips snippets from the main-context payload and includes relevance/why", async () => {
    const makeHit = (i: number): VectorSearchHit => ({
      id: `vec:${i}`,
      kind: "chunk",
      source_id: `chunk:file1:${i}`,
      universe_id: "u1",
      title: `Doc A ${i}`,
      text: `The full passage text ${i} that should never appear in the compact response.`,
      vector: [],
      keywords: [],
      domain: "",
      topics: [],
      graph_node_id: `chunk:file1:${i}`,
      file_id: "file1",
      created_at: 0,
      score: 0.9 - i * 0.01,
    });
    const hits = [makeHit(0), makeHit(1), makeHit(2)];
    const vectors = makeVectors({
      search: vi.fn(async () => hits),
    });
    const graph = makeGraph();
    const ctx = makeCtx({
      universes: [{ id: "u1", name: "Universe 1", graph, vectors }],
    });

    // Structured-output path: generateObject returns the parsed verdict.
    mockGenObj.mockImplementation(async () => ({
      object: {
        kept: [
          { sourceId: "chunk:file1:0", relevance: "high", why: "covers the goal" },
          { sourceId: "chunk:file1:1", relevance: "medium", why: "related context" },
        ],
        droppedIds: ["chunk:file1:2"],
      },
    }));

    const tools = createTools(ctx) as unknown as Record<string, LooseTool>;
    // When tools are invoked directly (bypassing the AI SDK) Zod defaults are
    // not applied, so supply the numeric params explicitly.
    const out = (await tools.vectorSearch.execute(
      { query: "anything", topK: 8, expandViaGraph: false } as ToolExecuteArgs,
      { toolCallId: "t1" },
    )) as { results: Array<Record<string, unknown>>; note?: string };

    expect(Array.isArray(out.results)).toBe(true);
    expect(out.results).toHaveLength(2);
    const r = out.results[0];
    expect(r.sourceId).toBe("chunk:file1:0");
    expect(r.relevance).toBe("high");
    expect(r.why).toBe("covers the goal");
    expect(r.title).toBe("Doc A 0");
    expect(r).not.toHaveProperty("snippet");
    expect(r).not.toHaveProperty("text");
    expect(out.note).toMatch(/inspect/);
    // The full text of every candidate must still land in the evidence cache
    // for later drills, even the dropped one.
    for (let i = 0; i < 3; i++) {
      expect(ctx.evidence.get(`chunk:file1:${i}`)?.text).toContain("full passage text");
    }
  });
});

describe("Tools.inspect — cache and fallback", () => {
  it("returns the cached record without touching the graph store", async () => {
    const ctx = makeCtx();
    ctx.evidence.set("chunk:seeded", {
      sourceId: "chunk:seeded",
      kind: "chunk",
      title: "Cached Chunk",
      text: "cached body",
      universeId: "u1",
      toolName: "vectorSearch",
      capturedAt: 0,
    });
    const tools = createTools(ctx) as unknown as Record<string, LooseTool>;
    const out = (await tools.inspect.execute(
      { sourceId: "chunk:seeded", universeId: "u1" } as ToolExecuteArgs,
      { toolCallId: "t1" },
    )) as Record<string, unknown>;
    expect(out.fromCache).toBe(true);
    expect(out.text).toBe("cached body");
    const graph = ctx.universes[0].graph as unknown as { getChunk: { mock?: { calls: unknown[] } } };
    expect(graph.getChunk.mock?.calls ?? []).toHaveLength(0);
  });

  it("falls back to graph.getChunk on cache miss and populates the cache", async () => {
    const getChunk = vi.fn(async () => ({
      id: "chunk:cold",
      text: "cold chunk body",
      position: 3,
      documentId: "doc:1",
      documentTitle: "Doc 1",
      heading: ["H1"],
      startOffset: null,
      endOffset: null,
      pageStart: null,
      pageEnd: null,
    }));
    const graph = makeGraph({ getChunk });
    const ctx = makeCtx({
      universes: [{ id: "u1", name: "Universe 1", graph, vectors: makeVectors() }],
    });
    const tools = createTools(ctx) as unknown as Record<string, LooseTool>;
    const out = (await tools.inspect.execute(
      { sourceId: "chunk:cold", universeId: "u1" } as ToolExecuteArgs,
      { toolCallId: "t1" },
    )) as Record<string, unknown>;
    expect(out.fromCache).toBe(false);
    expect(out.text).toBe("cold chunk body");
    expect(getChunk).toHaveBeenCalledWith("chunk:cold");
    expect(ctx.evidence.get("chunk:cold")?.text).toBe("cold chunk body");
  });

  it("returns not_found when the id is unknown everywhere", async () => {
    const ctx = makeCtx();
    const tools = createTools(ctx) as unknown as Record<string, LooseTool>;
    const out = (await tools.inspect.execute(
      { sourceId: "chunk:nope", universeId: "u1" } as ToolExecuteArgs,
      { toolCallId: "t1" },
    )) as Record<string, unknown>;
    expect(out.error).toBe("not_found");
  });
});
