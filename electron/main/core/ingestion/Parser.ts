import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import matter from "gray-matter";
import mammoth from "mammoth";
import { parse as parseHtml } from "node-html-parser";

/**
 * Inclusive-exclusive offset range mapping back into the raw extracted `text`.
 * Produced by parsers that know about paged / structured formats (currently
 * just PDFs) so downstream consumers can translate chunk offsets into page
 * numbers without re-parsing.
 */
export interface PageOffset {
  page: number;
  start: number;
  end: number;
}

export interface ParsedDocument {
  title: string;
  /** Normalized, already trimmed text that becomes the canonical indexing target. */
  text: string;
  mime: string;
  metadata: Record<string, unknown>;
  /**
   * Per-page character ranges referring to `text`. Present for formats that
   * inherently carry pages (PDF). Empty for flow-based formats (markdown,
   * text, html, code, docx).
   */
  pageOffsets: PageOffset[];
}

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp",
  ".cs", ".rb", ".php", ".sh", ".ps1", ".lua", ".kt", ".swift", ".sql",
  ".yaml", ".yml", ".json", ".toml", ".xml", ".css", ".scss",
]);

const TEXT_EXT = new Set([".txt", ".log", ".csv", ".tsv", ".ini", ".env"]);

export async function parseFile(absPath: string): Promise<ParsedDocument> {
  const ext = extname(absPath).toLowerCase();
  const nameGuess = absPath.split(/[\\/]/).pop() ?? absPath;

  if (ext === ".pdf") return parsePdf(absPath, nameGuess);
  if (ext === ".docx") return parseDocx(absPath, nameGuess);
  if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return parseMarkdown(absPath, nameGuess);
  if (ext === ".html" || ext === ".htm") return parseHtmlFile(absPath, nameGuess);
  if (CODE_EXT.has(ext)) return parseCode(absPath, nameGuess, ext);
  if (TEXT_EXT.has(ext) || ext === "") return parseText(absPath, nameGuess);
  throw new Error(`Unsupported file type: ${ext}`);
}

/**
 * PDF parser that keeps the per-page text separately so we can rebuild a
 * continuous character stream while preserving page boundaries. `pdf-parse`
 * exposes a `pagerender` callback that is invoked for each page during
 * extraction; we use it to accumulate one string per page.
 */
async function parsePdf(path: string, name: string): Promise<ParsedDocument> {
  type PdfParse = (b: Buffer, opts?: { pagerender?: (pageData: unknown) => Promise<string> }) => Promise<{
    text: string;
    info?: Record<string, unknown>;
    numpages?: number;
  }>;
  const mod = (await import("pdf-parse")) as { default?: PdfParse } | PdfParse;
  const pdfParse = typeof mod === "function" ? mod : mod.default!;
  const buf = await readFile(path);

  const pageTexts: string[] = [];
  // pdf.js page data objects expose getTextContent(); we collect text items
  // with newlines between lines but no decoration. Mirrors pdf-parse's default
  // renderer closely enough for downstream chunking.
  const pagerender = async (pageData: unknown): Promise<string> => {
    const data = pageData as { getTextContent: (opts: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }) => Promise<{ items: Array<{ str: string; transform?: number[]; hasEOL?: boolean }> }> };
    const text = await data.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
    let lastY: number | null = null;
    const lines: string[] = [];
    let current = "";
    for (const it of text.items) {
      const y = Array.isArray(it.transform) ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 0.1) {
        lines.push(current);
        current = "";
      }
      current += it.str;
      if (it.hasEOL) {
        lines.push(current);
        current = "";
        lastY = null;
      } else {
        lastY = y;
      }
    }
    if (current) lines.push(current);
    const pageText = lines.join("\n");
    pageTexts.push(pageText);
    return pageText;
  };

  const res = await pdfParse(buf, { pagerender });
  const title = (res.info as { Title?: string } | undefined)?.Title?.trim() || name;

  // Rebuild the concatenated text from our captured pages so our per-page
  // offsets line up exactly with the canonical `text` we return. Use a
  // page separator that also appears in typical pdf-parse output so chunk
  // boundaries look natural.
  const separator = "\n\n";
  const pages = pageTexts.length > 0 ? pageTexts : [res.text];
  const pageOffsets: PageOffset[] = [];
  let assembled = "";
  pages.forEach((pageText, idx) => {
    const start = assembled.length;
    assembled += pageText;
    const end = assembled.length;
    pageOffsets.push({ page: idx + 1, start, end });
    if (idx < pages.length - 1) assembled += separator;
  });

  return {
    title,
    text: assembled.trim(),
    mime: "application/pdf",
    metadata: { pages: res.numpages ?? pages.length },
    pageOffsets,
  };
}

async function parseDocx(path: string, name: string): Promise<ParsedDocument> {
  const res = await mammoth.extractRawText({ path });
  return {
    title: name,
    text: res.value.trim(),
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    metadata: {},
    pageOffsets: [],
  };
}

async function parseMarkdown(path: string, name: string): Promise<ParsedDocument> {
  const raw = await readFile(path, "utf8");
  const { data, content } = matter(raw);
  const title = typeof data.title === "string" ? data.title : extractH1(content) ?? name;
  return {
    title,
    text: content.trim(),
    mime: "text/markdown",
    metadata: data as Record<string, unknown>,
    pageOffsets: [],
  };
}

function extractH1(md: string): string | null {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

async function parseHtmlFile(path: string, name: string): Promise<ParsedDocument> {
  const raw = await readFile(path, "utf8");
  const root = parseHtml(raw);
  const title = root.querySelector("title")?.text?.trim() || name;
  root.querySelectorAll("script,style").forEach((n) => n.remove());
  const text = root.text.replace(/\s+/g, " ").trim();
  return { title, text, mime: "text/html", metadata: {}, pageOffsets: [] };
}

async function parseCode(path: string, name: string, ext: string): Promise<ParsedDocument> {
  const raw = await readFile(path, "utf8");
  return {
    title: name,
    text: raw,
    mime: `text/x-${ext.slice(1)}`,
    metadata: { language: ext.slice(1) },
    pageOffsets: [],
  };
}

async function parseText(path: string, name: string): Promise<ParsedDocument> {
  const raw = await readFile(path, "utf8");
  return { title: name, text: raw, mime: "text/plain", metadata: {}, pageOffsets: [] };
}
