export interface Chunk {
  id: string;
  /** The chunk text as embedded / indexed (may include overlap from the previous chunk). */
  text: string;
  position: number;
  /** Heading path leading up to this chunk, outermost first. */
  heading?: string[];
  /**
   * Inclusive start offset of the chunk's own content within the normalized
   * source text (CRLF/CR converted to LF). Excludes the overlap prefix so the
   * source-viewer can highlight exactly the part of the document that this
   * chunk represents.
   */
  startOffset: number;
  /** Exclusive end offset within the normalized source text. */
  endOffset: number;
}

export interface ChunkOptions {
  /** Soft character budget. Default ~3500 characters (~850-1000 tokens). */
  maxChars?: number;
  /** Target overlap in characters carried from the end of the previous chunk. */
  overlapChars?: number;
  /**
   * Alternative specification in approximate tokens. If provided, overrides
   * `maxChars` / `overlapChars` using a 4 chars/token heuristic.
   */
  maxTokens?: number;
  overlapTokens?: number;
}

const CHARS_PER_TOKEN = 4;

/**
 * Semantic chunker. Respects markdown headings and paragraph boundaries,
 * applies overlap deterministically at emission time (tail of the previous
 * chunk prepended to the next), and never splits a paragraph smaller than the
 * character budget.
 *
 * Returns chunks with sequential position ids and character offsets back into
 * the normalized source text. The `IngestionPipeline` derives globally-unique
 * ids (`chunk:<fileId>:<position>`) from these.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  if (!text.trim()) return [];
  const maxChars = options.maxTokens != null ? options.maxTokens * CHARS_PER_TOKEN : options.maxChars ?? 3500;
  const overlap = options.overlapTokens != null ? options.overlapTokens * CHARS_PER_TOKEN : options.overlapChars ?? 300;
  if (maxChars <= 0) throw new Error("chunkText: maxChars must be positive");
  if (overlap < 0 || overlap >= maxChars) throw new Error("chunkText: overlap must be >= 0 and < maxChars");

  // Normalize line endings but preserve character count so offsets stay stable
  // across the pipeline. CR and CRLF both collapse to LF (single char).
  const normalized = text.replace(/\r\n?/g, "\n");
  const blocks = splitIntoBlocks(normalized);

  interface Emitted {
    text: string;
    heading: string[];
    start: number;
    end: number;
  }
  const emitted: Emitted[] = [];
  let buffer: Emitted | null = null;

  const flushBuffer = () => {
    if (buffer && buffer.text.trim()) {
      emitted.push({ ...buffer, text: buffer.text.trim() });
    }
    buffer = null;
  };

  let headingStack: string[] = [];

  for (const block of blocks) {
    if (block.kind === "heading") {
      flushBuffer();
      headingStack = setHeadingAtLevel(headingStack, block.level, block.text);
      buffer = {
        text: block.raw,
        heading: [...headingStack],
        start: block.start,
        end: block.end,
      };
      continue;
    }

    const para = block.text;
    if (para.length > maxChars) {
      flushBuffer();
      for (let i = 0; i < para.length; i += maxChars) {
        const slice = para.slice(i, i + maxChars);
        emitted.push({
          text: slice,
          heading: [...headingStack],
          start: block.start + i,
          end: block.start + Math.min(para.length, i + maxChars),
        });
      }
      continue;
    }

    if (!buffer) {
      buffer = {
        text: para,
        heading: [...headingStack],
        start: block.start,
        end: block.end,
      };
      continue;
    }
    const prospective = buffer.text.length + 2 + para.length;
    if (prospective <= maxChars) {
      buffer.text += `\n\n${para}`;
      buffer.end = block.end;
    } else {
      flushBuffer();
      buffer = {
        text: para,
        heading: [...headingStack],
        start: block.start,
        end: block.end,
      };
    }
  }
  flushBuffer();

  const withOverlap: Chunk[] = [];
  for (let i = 0; i < emitted.length; i++) {
    const current = emitted[i];
    let text = current.text;
    if (overlap > 0 && i > 0) {
      const prev = emitted[i - 1].text;
      const tail = prev.slice(Math.max(0, prev.length - overlap));
      if (tail && !text.startsWith(tail)) {
        text = `${tail}\n\n${text}`;
      }
    }
    withOverlap.push({
      id: `chunk_${i}`,
      text,
      position: i,
      heading: current.heading.length ? current.heading : undefined,
      startOffset: current.start,
      endOffset: current.end,
    });
  }
  return withOverlap;
}

type Block =
  | { kind: "paragraph"; text: string; start: number; end: number }
  | { kind: "heading"; level: number; text: string; raw: string; start: number; end: number };

/**
 * Split the normalized source text into heading and paragraph blocks while
 * tracking original character offsets. We walk the input character-by-character
 * instead of `split("\n")` so we can reconstruct precise `start`/`end` offsets
 * without having to re-scan the input afterwards.
 */
function splitIntoBlocks(normalized: string): Block[] {
  const out: Block[] = [];
  const n = normalized.length;
  let i = 0;

  interface LineSpan {
    text: string;
    start: number;
    end: number;
  }
  let paraLines: LineSpan[] = [];

  const flushPara = () => {
    if (paraLines.length === 0) return;
    const joinedRaw = paraLines.map((l) => l.text).join("\n");
    const trimmed = joinedRaw.trim();
    if (trimmed) {
      const start = paraLines[0].start;
      const end = paraLines[paraLines.length - 1].end;
      out.push({ kind: "paragraph", text: trimmed, start, end });
    }
    paraLines = [];
  };

  while (i < n) {
    const lineStart = i;
    while (i < n && normalized[i] !== "\n") i++;
    const lineEnd = i; // exclusive; points at the '\n' or end-of-text
    const line = normalized.slice(lineStart, lineEnd);

    if (line.trim() === "") {
      flushPara();
    } else {
      const heading = matchHeading(line);
      if (heading) {
        flushPara();
        out.push({
          kind: "heading",
          level: heading.level,
          text: heading.text,
          raw: line,
          start: lineStart,
          end: lineEnd,
        });
      } else {
        paraLines.push({ text: line, start: lineStart, end: lineEnd });
      }
    }

    if (i < n && normalized[i] === "\n") i++;
  }
  flushPara();
  return out;
}

function matchHeading(line: string): { level: number; text: string } | null {
  const md = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
  if (md) return { level: md[1].length, text: md[2].trim() };
  return null;
}

function setHeadingAtLevel(stack: string[], level: number, text: string): string[] {
  const next = stack.slice(0, Math.max(0, level - 1));
  next[level - 1] = text;
  return next;
}
