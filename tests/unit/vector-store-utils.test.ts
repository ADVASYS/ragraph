import { describe, it, expect } from "vitest";
import { quoteLiteral } from "../../electron/main/core/storage/VectorStore";

describe("VectorStore quoteLiteral", () => {
  it("wraps plain strings in single quotes", () => {
    expect(quoteLiteral("hello")).toBe("'hello'");
  });

  it("escapes single quotes by doubling them", () => {
    expect(quoteLiteral("it's fine")).toBe("'it''s fine'");
    expect(quoteLiteral("''")).toBe("''''''");
  });

  it("escapes a classic SQL-injection attempt", () => {
    const malicious = "foo' OR 1=1 --";
    const quoted = quoteLiteral(malicious);
    expect(quoted).toBe("'foo'' OR 1=1 --'");
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });

  it("rejects NUL bytes", () => {
    expect(() => quoteLiteral("a\u0000b")).toThrow(/NUL/);
  });

  it("throws on non-strings", () => {
    expect(() => quoteLiteral(123 as unknown as string)).toThrow(TypeError);
  });
});
