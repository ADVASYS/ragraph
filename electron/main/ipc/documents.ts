import { ipcMain } from "electron";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import mammoth from "mammoth";
import { IPC } from "../../../shared/ipc";
import type { AppContext } from "../services/AppContext";
import type { DocumentContent, DocumentExcerpt } from "../../../shared/types";
import type { GraphStore } from "../core/storage/GraphStore";
import { parseFile } from "../core/ingestion/Parser";

const CONTEXT_PADDING = 400;

/**
 * Handlers that power the in-app source viewer panel. They translate agent
 * citations (sourceId) into the precise passage from the original document and
 * stream the file's raw content to the renderer when it needs to show the
 * excerpt in context (PDF page, markdown paragraph, code line, etc.).
 */
export function registerDocumentHandlers(ctx: AppContext): void {
  ipcMain.handle(
    IPC.Documents.GetExcerpt,
    async (_e, universeId: string, sourceId: string): Promise<DocumentExcerpt | null> => {
      const stores = await ctx.getUniverseStores(universeId);
      if (!stores) return null;

      if (sourceId.startsWith("chunk:")) {
        return resolveChunkExcerpt(ctx, stores.graph, sourceId);
      }
      if (sourceId.startsWith("doc:")) {
        return resolveDocumentExcerpt(ctx, stores.graph, sourceId);
      }
      return null;
    },
  );

  ipcMain.handle(
    IPC.Documents.ReadOriginal,
    async (_e, fileId: string): Promise<DocumentContent | null> => {
      const row = ctx.meta.db
        .prepare("SELECT abs_path as absPath FROM files WHERE id = ?")
        .get(fileId) as { absPath: string } | undefined;
      if (!row) return null;
      const ext = extname(row.absPath).toLowerCase();
      const st = await stat(row.absPath).catch(() => null);
      if (!st) return null;

      // Keep PDFs as raw bytes so the renderer can hand them to pdf.js. For
      // DOCX we convert to HTML once on the main side (mammoth is heavy and
      // cannot run in the renderer sandbox). Everything else is plain text.
      if (ext === ".pdf") {
        const buf = await readFile(row.absPath);
        return {
          fileId,
          absPath: row.absPath,
          mime: "application/pdf",
          encoding: "base64",
          data: buf.toString("base64"),
          size: st.size,
        };
      }

      if (ext === ".docx") {
        const res = await mammoth.convertToHtml({ path: row.absPath });
        return {
          fileId,
          absPath: row.absPath,
          mime: "text/html",
          encoding: "utf8",
          text: res.value,
          size: st.size,
        };
      }

      const raw = await readFile(row.absPath, "utf8");
      const normalized = raw.replace(/\r\n?/g, "\n");
      return {
        fileId,
        absPath: row.absPath,
        mime: guessTextMime(ext),
        encoding: "utf8",
        text: normalized,
        size: st.size,
      };
    },
  );
}

async function resolveChunkExcerpt(
  ctx: AppContext,
  graph: GraphStore,
  sourceId: string,
): Promise<DocumentExcerpt | null> {
  const chunk = await graph.getChunk(sourceId);
  if (!chunk) return null;
  const fileId = extractFileId(chunk.documentId ?? "");
  if (!fileId) return null;
  const fileRow = ctx.meta.db
    .prepare("SELECT abs_path as absPath, rel_path as relPath FROM files WHERE id = ?")
    .get(fileId) as { absPath: string; relPath: string | null } | undefined;
  if (!fileRow) return null;

  // Re-extract the canonical text so offsets translate to the exact passage we
  // stored. For binary formats this is the only way to rebuild the excerpt on
  // demand without duplicating the full document text into SQLite.
  let excerpt = chunk.text;
  let contextBefore = "";
  let contextAfter = "";
  let mime = "text/plain";
  try {
    const parsed = await parseFile(fileRow.absPath);
    mime = parsed.mime;
    const normalized = parsed.text.replace(/\r\n?/g, "\n");
    if (
      chunk.startOffset != null &&
      chunk.endOffset != null &&
      chunk.startOffset >= 0 &&
      chunk.endOffset <= normalized.length &&
      chunk.endOffset >= chunk.startOffset
    ) {
      excerpt = normalized.slice(chunk.startOffset, chunk.endOffset);
      const ctxStart = Math.max(0, chunk.startOffset - CONTEXT_PADDING);
      const ctxEnd = Math.min(normalized.length, chunk.endOffset + CONTEXT_PADDING);
      contextBefore = normalized.slice(ctxStart, chunk.startOffset);
      contextAfter = normalized.slice(chunk.endOffset, ctxEnd);
    }
  } catch {
    // Re-parsing failures must not break citations — fall back to the stored
    // chunk text. The viewer will show the chunk body without precise context.
  }

  return {
    sourceId,
    kind: "chunk",
    fileId,
    absPath: fileRow.absPath,
    relPath: fileRow.relPath,
    mime,
    title: chunk.documentTitle ?? fileRow.relPath ?? fileRow.absPath,
    heading: chunk.heading ?? [],
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    excerpt,
    contextBefore,
    contextAfter,
  };
}

async function resolveDocumentExcerpt(
  ctx: AppContext,
  graph: GraphStore,
  sourceId: string,
): Promise<DocumentExcerpt | null> {
  const doc = await graph.getDocumentSummary(sourceId);
  if (!doc) return null;
  const fileId = extractFileId(sourceId);
  if (!fileId) return null;
  const fileRow = ctx.meta.db
    .prepare("SELECT abs_path as absPath, rel_path as relPath FROM files WHERE id = ?")
    .get(fileId) as { absPath: string; relPath: string | null } | undefined;
  if (!fileRow) return null;

  let mime = "text/plain";
  try {
    const parsed = await parseFile(fileRow.absPath);
    mime = parsed.mime;
  } catch {
    // Leave the default mime if re-parse fails (e.g. file removed); the panel
    // still has enough data to render the summary.
  }

  return {
    sourceId,
    kind: "document",
    fileId,
    absPath: fileRow.absPath,
    relPath: fileRow.relPath,
    mime,
    title: doc.title || fileRow.relPath || fileRow.absPath,
    heading: [],
    startOffset: null,
    endOffset: null,
    pageStart: null,
    pageEnd: null,
    excerpt: doc.summary || "",
    contextBefore: "",
    contextAfter: "",
  };
}

function extractFileId(nodeId: string): string | null {
  if (!nodeId.startsWith("doc:")) return null;
  const rest = nodeId.slice("doc:".length);
  return rest.length > 0 ? rest : null;
}

function guessTextMime(ext: string): string {
  switch (ext) {
    case ".md":
    case ".markdown":
    case ".mdx":
      return "text/markdown";
    case ".html":
    case ".htm":
      return "text/html";
    case ".json":
      return "application/json";
    case ".xml":
      return "application/xml";
    case ".csv":
    case ".tsv":
      return "text/csv";
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".py":
    case ".rs":
    case ".go":
    case ".java":
    case ".c":
    case ".cpp":
    case ".cs":
    case ".rb":
    case ".php":
    case ".sh":
    case ".ps1":
    case ".lua":
    case ".kt":
    case ".swift":
    case ".sql":
    case ".yaml":
    case ".yml":
    case ".toml":
    case ".css":
    case ".scss":
      return `text/x-${ext.slice(1)}`;
    default:
      return "text/plain";
  }
}
