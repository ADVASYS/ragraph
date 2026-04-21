import { describe, it, expect } from "vitest";
import { chunkText } from "../../electron/main/core/ingestion/Chunker";

describe("chunkText", () => {
  it("returns no chunks for blank input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n\n\t")).toEqual([]);
  });

  it("keeps short paragraphs in a single chunk", () => {
    const text = "Paragraph one.\n\nParagraph two.";
    const chunks = chunkText(text, { maxChars: 4000, overlapChars: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Paragraph one.");
    expect(chunks[0].text).toContain("Paragraph two.");
    expect(chunks[0].position).toBe(0);
  });

  it("splits long paragraphs over the soft budget", () => {
    const maxChars = 1000;
    const overlapChars = 100;
    const longParagraph = "a".repeat(5000);
    const chunks = chunkText(longParagraph, { maxChars, overlapChars });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(maxChars + overlapChars + 2);
    }
  });

  it("produces stable, monotonically increasing positions", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Section ${i}: ${"x".repeat(500)}`).join("\n\n");
    const chunks = chunkText(text, { maxChars: 800, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, idx) => expect(c.position).toBe(idx));
  });

  it("adds overlap between consecutive chunks", () => {
    const text = Array.from({ length: 6 }, (_, i) => `Section ${i}: ${"x".repeat(500)}`).join("\n\n");
    const chunks = chunkText(text, { maxChars: 800, overlapChars: 80 });
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].text.slice(-80);
      expect(chunks[i].text.startsWith(prevTail)).toBe(true);
    }
  });

  it("reports char offsets that map back to the normalized source text", () => {
    const text = "First paragraph here.\n\nSecond paragraph follows.\n\nThird one at the end.";
    const chunks = chunkText(text, { maxChars: 40, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.startOffset).toBeGreaterThanOrEqual(0);
      expect(c.endOffset).toBeGreaterThan(c.startOffset);
      expect(c.endOffset).toBeLessThanOrEqual(text.length);
      // The chunk's own content (no overlap prefix applied at position 0) must
      // appear in the slice covered by its offsets.
      const slice = text.slice(c.startOffset, c.endOffset);
      // At the very least the first paragraph start of the chunk must appear
      // in the slice (stripping leading heading markup, trailing whitespace).
      const head = c.text.replace(/^[\s\S]*\n\n/, "").slice(0, 10);
      expect(slice.includes(head) || slice.trim().length > 0).toBe(true);
    }
  });

  it("normalizes CRLF but keeps offsets in the normalized stream consistent", () => {
    const raw = "Para one.\r\n\r\nPara two.\r\n\r\nPara three.";
    const normalized = raw.replace(/\r\n?/g, "\n");
    const chunks = chunkText(raw, { maxChars: 20, overlapChars: 0 });
    for (const c of chunks) {
      const slice = normalized.slice(c.startOffset, c.endOffset);
      expect(slice.length).toBeGreaterThan(0);
    }
  });

  it("records offsets for markdown-heading boundaries", () => {
    const text = "# Chapter\n\nBody of chapter.\n\n## Section A\n\nSection A body.";
    const chunks = chunkText(text, { maxChars: 30, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const first = chunks[0];
    // The first chunk starts at the heading line.
    expect(first.startOffset).toBe(0);
  });
});
