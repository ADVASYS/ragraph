import { describe, it, expect, vi } from "vitest";
import type { Tool } from "ai";
import { wrapTools, __internals } from "../../electron/main/core/rag/Agent";

/**
 * These tests exercise the agent safety shell in isolation (no LLM, no
 * streamText). They cover the three budgets stacked on top of every tool:
 *   1. The exact-args fingerprint loop guard (`loop_detected`).
 *   2. The per-tool call-count budget (`per_tool_budget_exceeded`).
 *   3. The soft total-turn budget (`soft_total_budget_exceeded`).
 */

type LooseTool = { execute: (args: unknown, ctx: unknown) => Promise<unknown> };

function makeStubTool(name: string): Tool {
  return {
    description: name,
    parameters: { _def: { typeName: "ZodObject" } } as unknown as Tool["parameters"],
    execute: vi.fn(async (args: unknown) => ({ ok: true, name, args })) as Tool["execute"],
  } as unknown as Tool;
}

function makeOpts(over: Partial<Parameters<typeof wrapTools>[1]> = {}) {
  return {
    toolTimeoutMs: 0,
    loopDetection: true,
    callFingerprints: new Map<string, number>(),
    perToolCounts: new Map<string, number>(),
    totalCounter: { total: 0 },
    ...over,
  };
}

describe("Agent.wrapTools — safety shell", () => {
  it("passes through the underlying tool result on normal calls", async () => {
    const inner = makeStubTool("vectorSearch");
    const opts = makeOpts();
    const wrapped = wrapTools({ vectorSearch: inner }, opts) as Record<string, LooseTool>;
    const out = await wrapped.vectorSearch.execute({ query: "a", topK: 8 }, { toolCallId: "1" });
    expect(out).toMatchObject({ ok: true, name: "vectorSearch" });
    expect(opts.perToolCounts.get("vectorSearch")).toBe(1);
    expect(opts.totalCounter.total).toBe(1);
  });

  it("returns loop_detected after LOOP_LIMIT identical calls and does NOT invoke the underlying tool again", async () => {
    const inner = makeStubTool("entitySearch");
    const exec = inner.execute as ReturnType<typeof vi.fn>;
    const opts = makeOpts();
    const wrapped = wrapTools({ entitySearch: inner }, opts) as Record<string, LooseTool>;
    for (let i = 0; i < __internals.LOOP_LIMIT; i++) {
      await wrapped.entitySearch.execute({ name: "X" }, { toolCallId: `t${i}` });
    }
    const over = (await wrapped.entitySearch.execute({ name: "X" }, { toolCallId: "t_over" })) as {
      error?: string;
    };
    expect(over.error).toBe("loop_detected");
    expect(exec).toHaveBeenCalledTimes(__internals.LOOP_LIMIT);
  });

  it("returns per_tool_budget_exceeded when the same tool is called with DIFFERENT args past the per-tool cap", async () => {
    const inner = makeStubTool("vectorSearch");
    const exec = inner.execute as ReturnType<typeof vi.fn>;
    const opts = makeOpts();
    const wrapped = wrapTools({ vectorSearch: inner }, opts) as Record<string, LooseTool>;
    const limit = __internals.PER_TOOL_LIMITS.vectorSearch;
    // Each call has a DIFFERENT subGoal so the fingerprint loop guard cannot
    // fire — this is exactly the abuse pattern we observed in production.
    for (let i = 0; i < limit; i++) {
      const out = await wrapped.vectorSearch.execute(
        { query: "q", subGoal: `goal variant ${i}`, topK: 8 },
        { toolCallId: `t${i}` },
      );
      expect((out as { error?: string }).error).toBeUndefined();
    }
    const over = (await wrapped.vectorSearch.execute(
      { query: "q", subGoal: "goal variant FINAL", topK: 8 },
      { toolCallId: "t_over" },
    )) as { error?: string; message?: string };
    expect(over.error).toBe("per_tool_budget_exceeded");
    expect(over.message).toMatch(/vectorSearch/);
    expect(exec).toHaveBeenCalledTimes(limit);
  });

  it("returns soft_total_budget_exceeded for HEAVY tools once the total-turn budget is exceeded", async () => {
    const opts = makeOpts({ loopDetection: false });
    const heavy = makeStubTool("graphNavigate"); // HEAVY
    const drillA = makeStubTool("quote"); // NOT heavy, limit 10
    const drillB = makeStubTool("inspect"); // NOT heavy, limit 10
    const heavyExec = heavy.execute as ReturnType<typeof vi.fn>;
    const wrapped = wrapTools(
      { graphNavigate: heavy, quote: drillA, inspect: drillB },
      opts,
    ) as Record<string, LooseTool>;

    // Push the shared counter past SOFT_TOTAL_BUDGET (18) without tripping the
    // per-tool cap on either drill tool (both capped at 10). Alternating gives
    // us 9 quotes + 9 inspects = 18 calls, and the 19th is the heavy one.
    const half = Math.floor(__internals.SOFT_TOTAL_BUDGET / 2);
    for (let i = 0; i < half; i++) {
      await wrapped.quote.execute({ sourceId: `c:${i}`, question: "?" }, { toolCallId: `q${i}` });
      await wrapped.inspect.execute({ sourceId: `c:${i}` }, { toolCallId: `i${i}` });
    }
    expect(opts.totalCounter.total).toBe(__internals.SOFT_TOTAL_BUDGET);

    const heavyOut = (await wrapped.graphNavigate.execute(
      { nodeId: "n1", subGoal: "anything" },
      { toolCallId: "h1" },
    )) as { error?: string };
    expect(heavyOut.error).toBe("soft_total_budget_exceeded");
    expect(heavyExec).not.toHaveBeenCalled();

    // Drill tools remain usable (still under their own per-tool cap) so the
    // model can finish its citations.
    const drillOut = (await wrapped.quote.execute(
      { sourceId: "c:final", question: "?" },
      { toolCallId: "qFinal" },
    )) as { error?: string };
    expect(drillOut.error).toBeUndefined();
  });
});
