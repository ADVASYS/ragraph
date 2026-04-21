import { describe, it, expect } from "vitest";
import { stableStringify } from "../../electron/main/core/rag/agent-utils";

describe("stableStringify", () => {
  it("serializes primitives like JSON.stringify", () => {
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify("hi")).toBe('"hi"');
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
  });

  it("produces the same output regardless of object key order", () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b = { c: { x: 2, y: 1 }, a: 2, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
    expect(stableStringify([{ b: 2, a: 1 }, { b: 3, a: 0 }])).toBe(
      '[{"a":1,"b":2},{"a":0,"b":3}]',
    );
  });

  it("uses sorted keys for fingerprinting tool args", () => {
    const arg1 = { query: "deep learning", topK: 5, filters: { kind: "chunk" } };
    const arg2 = { filters: { kind: "chunk" }, topK: 5, query: "deep learning" };
    const fp1 = `vectorSearch:${stableStringify(arg1)}`;
    const fp2 = `vectorSearch:${stableStringify(arg2)}`;
    expect(fp1).toBe(fp2);
  });
});
