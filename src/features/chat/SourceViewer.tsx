import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Document, Page, pdfjs } from "react-pdf";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  X,
} from "lucide-react";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
// Vite resolves the ?url import into a hashed asset URL pointing at the exact
// pdfjs-dist worker that ships in node_modules, so the renderer can load it
// both in the dev server and in the packaged Electron bundle. Using plain
// `new URL(..., import.meta.url)` does NOT trigger Vite module resolution and
// therefore 404s silently, which is what caused "Failed to render document".
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "@/lib/api";
import { useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SourceRef, DocumentExcerpt, DocumentContent } from "@shared/types";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function SourceViewer({ source }: { source: SourceRef }) {
  const { t } = useTranslation();
  const setActiveSource = useApp((s) => s.setActiveSource);

  const excerptQuery = useQuery({
    queryKey: ["source-excerpt", source.universeId, source.id],
    queryFn: () => api.documents.getExcerpt(source.universeId, source.id),
    enabled: !!source.id && !!source.universeId,
    staleTime: 60_000,
  });

  const contentQuery = useQuery({
    queryKey: ["source-content", excerptQuery.data?.fileId],
    queryFn: () =>
      excerptQuery.data?.fileId
        ? api.documents.readOriginal(excerptQuery.data.fileId)
        : Promise.resolve(null),
    enabled: !!excerptQuery.data?.fileId,
    staleTime: 5 * 60_000,
  });

  const excerpt = excerptQuery.data ?? null;
  const content = contentQuery.data ?? null;

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-border/60 flex items-start gap-2 bg-white/80 backdrop-blur-sm">
        <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
          <FileText className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold truncate" title={excerpt?.title ?? source.title}>
            {excerpt?.title ?? source.title}
          </div>
          {(excerpt?.relPath || source.filePath) && (
            <div className="text-[10px] text-muted-foreground truncate" title={excerpt?.absPath ?? source.filePath ?? undefined}>
              {excerpt?.relPath ?? source.filePath}
            </div>
          )}
          <ExcerptMeta excerpt={excerpt} />
        </div>
        <div className="flex items-center gap-0.5">
          {excerpt?.fileId && (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                title={t("common.reveal", { defaultValue: "Show in folder" }) as string}
                onClick={() => api.files.reveal(excerpt.fileId)}
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title={t("common.openExternal", { defaultValue: "Open externally" }) as string}
                onClick={() => api.files.open(excerpt.fileId)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("common.close", { defaultValue: "Close" }) as string}
            onClick={() => setActiveSource(null)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/20">
        {excerptQuery.isLoading || contentQuery.isLoading ? (
          <div className="flex items-center justify-center py-16 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            {t("common.loading", { defaultValue: "Loading…" })}
          </div>
        ) : !excerpt ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            {t("chat.sourceViewer.notFound", { defaultValue: "Source not found." })}
          </div>
        ) : (
          <ViewerBody excerpt={excerpt} content={content} />
        )}
      </div>
    </div>
  );
}

function ExcerptMeta({ excerpt }: { excerpt: DocumentExcerpt | null }) {
  if (!excerpt) return null;
  const parts: string[] = [];
  if (excerpt.pageStart && excerpt.pageEnd) {
    parts.push(
      excerpt.pageStart === excerpt.pageEnd
        ? `page ${excerpt.pageStart}`
        : `pages ${excerpt.pageStart}–${excerpt.pageEnd}`,
    );
  }
  if (excerpt.heading?.length) {
    parts.push(excerpt.heading.join(" › "));
  }
  if (parts.length === 0) return null;
  return (
    <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
      {parts.join(" · ")}
    </div>
  );
}

function ViewerBody({
  excerpt,
  content,
}: {
  excerpt: DocumentExcerpt;
  content: DocumentContent | null;
}) {
  if (excerpt.mime === "application/pdf" && content?.encoding === "base64" && content.data) {
    return <PdfViewer excerpt={excerpt} data={content.data} />;
  }
  if (content?.encoding === "utf8" && typeof content.text === "string") {
    return <TextViewer excerpt={excerpt} mime={excerpt.mime} text={content.text} />;
  }
  // Fallback: show just the excerpt + its immediate context.
  return (
    <div className="p-6">
      <ContextExcerpt excerpt={excerpt} />
    </div>
  );
}

function ContextExcerpt({ excerpt }: { excerpt: DocumentExcerpt }) {
  return (
    <div className="rounded-xl border border-border bg-white p-4 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
      {excerpt.contextBefore && (
        <span className="text-muted-foreground">{excerpt.contextBefore}</span>
      )}
      <mark className="bg-yellow-200/60 text-foreground rounded px-0.5">
        {excerpt.excerpt}
      </mark>
      {excerpt.contextAfter && (
        <span className="text-muted-foreground">{excerpt.contextAfter}</span>
      )}
    </div>
  );
}

interface PdfViewerProps {
  excerpt: DocumentExcerpt;
  data: string;
}

function PdfViewer({ excerpt, data }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(excerpt.pageStart ?? 1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrolledFor = useRef<string | null>(null);

  // Decode the base64 payload into a Uint8Array exactly once per document.
  // pdf.js transfers the underlying ArrayBuffer to the worker, so we keep the
  // memoized object stable and never mutate it after the first render.
  const pdfFile = useMemo(() => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { data: bytes };
  }, [data]);

  // Normalize the excerpt for lookup on the text layer. Pdf.js returns text
  // items without soft-hyphens or line-internal whitespace quirks, so we
  // lowercase + collapse whitespace for fuzzy matching.
  const needle = useMemo(() => normalizeForMatch(excerpt.excerpt), [excerpt.excerpt]);

  // Auto-scroll to the page carrying the excerpt once it has rendered.
  useEffect(() => {
    if (!numPages || !excerpt.pageStart) return;
    const target = Math.min(excerpt.pageStart, numPages);
    const marker = `${excerpt.sourceId}:${target}`;
    if (scrolledFor.current === marker) return;
    const el = pageRefs.current.get(target);
    if (el) {
      el.scrollIntoView({ behavior: "auto", block: "start" });
      scrolledFor.current = marker;
    }
  }, [numPages, excerpt.pageStart, excerpt.sourceId]);

  // Highlight matching text spans by decorating the text layer via
  // customTextRenderer. react-pdf calls this for every text item with the
  // string + index info; we return a wrapper span whose CSS class applies the
  // highlight style.
  const customTextRenderer = useMemo(() => {
    if (!needle) return undefined;
    const words = needle
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .slice(0, 40);
    if (words.length === 0) return undefined;
    const set = new Set(words);
    return (textItem: { str: string }): string => {
      const raw = textItem.str;
      if (!raw) return raw;
      const lowered = raw.toLowerCase();
      let hit = false;
      for (const w of set) {
        if (lowered.includes(w)) {
          hit = true;
          break;
        }
      }
      return hit
        ? `<mark class="ragraph-pdf-mark">${escapeHtml(raw)}</mark>`
        : escapeHtml(raw);
    };
  }, [needle]);

  return (
    <div className="flex flex-col items-stretch gap-3 p-4">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground bg-white/70 rounded-lg px-3 py-1.5 border border-border/60 sticky top-0 z-10">
        <span>
          {numPages > 0 ? `${currentPage} / ${numPages}` : "…"}
          {excerpt.pageStart && (
            <span className="ml-2 text-primary">
              excerpt · p.{excerpt.pageStart}
              {excerpt.pageEnd && excerpt.pageEnd !== excerpt.pageStart ? `–${excerpt.pageEnd}` : ""}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={currentPage <= 1}
            onClick={() => scrollToPage(pageRefs, currentPage - 1)}
          >
            <ChevronUp className="h-3 w-3" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={currentPage >= numPages}
            onClick={() => scrollToPage(pageRefs, currentPage + 1)}
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {loadError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 text-destructive text-[11px] px-3 py-2">
          {loadError}
        </div>
      )}
      <Document
        file={pdfFile}
        onLoadSuccess={({ numPages: n }) => {
          setNumPages(n);
          setLoadError(null);
        }}
        onLoadError={(err: Error) => {
          // Surface the real pdf.js error to the UI and the console so issues
          // like a missing worker URL or a truncated base64 payload become
          // actionable instead of a generic "failed to render" fallback.
          console.error("[pdf.js] document load failed", err);
          setLoadError(err?.message ?? "Failed to load PDF.");
        }}
        loading={<ViewerSpinner />}
        error={<ViewerError message={loadError} />}
      >
        {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
          <div
            key={page}
            ref={(el) => {
              if (el) pageRefs.current.set(page, el);
              else pageRefs.current.delete(page);
            }}
            className="mb-4"
            onScrollCapture={() => setCurrentPage(page)}
          >
            <Page
              pageNumber={page}
              width={720}
              renderAnnotationLayer={false}
              customTextRenderer={customTextRenderer}
              onRenderSuccess={() => {
                // Using an IntersectionObserver on every page would be nicer,
                // but updating currentPage from the visible-in-viewport page
                // during scroll covers the common case.
              }}
              className="shadow-sm border border-border/60 bg-white"
            />
          </div>
        ))}
      </Document>

      <style>{`.ragraph-pdf-mark { background-color: rgba(250, 204, 21, 0.55); color: inherit; border-radius: 2px; padding: 0 1px; }`}</style>
    </div>
  );
}

function scrollToPage(refs: React.MutableRefObject<Map<number, HTMLDivElement>>, page: number) {
  const el = refs.current.get(page);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function ViewerSpinner() {
  return (
    <div className="flex items-center justify-center py-10 text-muted-foreground text-xs">
      <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading document…
    </div>
  );
}

function ViewerError({ message }: { message?: string | null }) {
  return (
    <div className="p-6 text-center text-xs text-destructive space-y-1">
      <div>Failed to render document.</div>
      {message ? <div className="text-[10px] opacity-80 break-all">{message}</div> : null}
    </div>
  );
}

interface TextViewerProps {
  excerpt: DocumentExcerpt;
  mime: string;
  text: string;
}

function TextViewer({ excerpt, mime, text }: TextViewerProps) {
  const hasRange =
    excerpt.startOffset != null &&
    excerpt.endOffset != null &&
    excerpt.endOffset > excerpt.startOffset &&
    excerpt.startOffset >= 0 &&
    excerpt.endOffset <= text.length;

  const before = hasRange ? text.slice(0, excerpt.startOffset!) : "";
  const middle = hasRange ? text.slice(excerpt.startOffset!, excerpt.endOffset!) : excerpt.excerpt;
  const after = hasRange ? text.slice(excerpt.endOffset!) : "";

  const highlightRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "auto", block: "center" });
    }
  }, [excerpt.sourceId]);

  if (mime === "text/markdown") {
    // Markdown path: render the document but replace the excerpt with a
    // highlighted slot so the formatting stays intact around the excerpt.
    return (
      <div className="p-4">
        <div className="mb-3 rounded-lg border border-border/60 bg-white p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Excerpt</div>
          <div
            className="whitespace-pre-wrap text-[13px] leading-relaxed bg-yellow-100/60 rounded px-2 py-1"
          >
            {middle}
          </div>
        </div>
        <div className="prose-chat max-w-none rounded-xl border border-border bg-white p-4">
          <HighlightedMarkdown before={before} middle={middle} after={after} highlightRef={highlightRef} />
        </div>
      </div>
    );
  }

  if (mime === "text/html") {
    return (
      <div className="p-4">
        <HighlightedHtml text={text} startOffset={excerpt.startOffset} endOffset={excerpt.endOffset} highlightRef={highlightRef} />
      </div>
    );
  }

  // Default code / plain-text rendering with a stable highlight range.
  return (
    <div className="p-4">
      <pre
        className={cn(
          "text-[12px] leading-relaxed whitespace-pre-wrap break-words font-mono bg-white rounded-xl border border-border p-4",
        )}
      >
        <span className="text-muted-foreground">{before}</span>
        <span
          ref={(el) => {
            highlightRef.current = el;
          }}
          className="bg-yellow-200/70 text-foreground rounded px-0.5"
        >
          {middle}
        </span>
        <span className="text-muted-foreground">{after}</span>
      </pre>
    </div>
  );
}

interface HighlightedMarkdownProps {
  before: string;
  middle: string;
  after: string;
  highlightRef: React.MutableRefObject<HTMLElement | null>;
}

function HighlightedMarkdown({ before, middle, after, highlightRef }: HighlightedMarkdownProps) {
  // Markdown is flow-formatted — preserving per-character offsets through a
  // full markdown renderer is infeasible. We render the three segments
  // separately; the middle segment carries the highlight. The seams (start
  // and end of `middle`) may land mid-paragraph, which is visually
  // acceptable for an inline excerpt highlight.
  return (
    <>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{before}</ReactMarkdown>
      <div
        ref={(el) => {
          highlightRef.current = el;
        }}
        className="bg-yellow-100/70 rounded-md px-2 py-1 my-2 border-l-4 border-yellow-400"
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{middle}</ReactMarkdown>
      </div>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{after}</ReactMarkdown>
    </>
  );
}

interface HighlightedHtmlProps {
  text: string;
  startOffset: number | null;
  endOffset: number | null;
  highlightRef: React.MutableRefObject<HTMLElement | null>;
}

function HighlightedHtml({ text, startOffset, endOffset, highlightRef }: HighlightedHtmlProps) {
  // We cannot safely splice markers into rendered HTML without risking tag
  // corruption, so we render the HTML into an isolated container and then
  // walk text nodes to find a best-effort match against the excerpt slice.
  const excerpt = useMemo(() => {
    if (startOffset == null || endOffset == null) return "";
    return text.slice(startOffset, endOffset);
  }, [text, startOffset, endOffset]);

  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = text;
    if (excerpt.length > 20) {
      const needle = normalizeForMatch(excerpt).slice(0, 160);
      markFirstMatch(host, needle, highlightRef);
    }
  }, [text, excerpt, highlightRef]);

  return (
    <div className="ragraph-html-viewer prose-chat max-w-none rounded-xl border border-border bg-white p-4" ref={hostRef} />
  );
}

function markFirstMatch(
  root: HTMLElement,
  needle: string,
  highlightRef: React.MutableRefObject<HTMLElement | null>,
): void {
  if (!needle) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let cur: Node | null;
  while ((cur = walker.nextNode())) nodes.push(cur as Text);

  // Concatenate text nodes into one haystack but keep a reverse map for
  // precise wrapping.
  const ranges: Array<{ node: Text; start: number; end: number }> = [];
  let haystack = "";
  for (const n of nodes) {
    const start = haystack.length;
    haystack += n.nodeValue ?? "";
    ranges.push({ node: n, start, end: haystack.length });
  }
  const lowered = haystack.toLowerCase();
  const idx = lowered.indexOf(needle);
  if (idx < 0) return;
  const matchEnd = idx + needle.length;

  // Wrap the matching range by splitting text nodes as needed.
  const span = document.createElement("span");
  span.className = "ragraph-md-mark";
  span.setAttribute("data-ragraph-excerpt", "1");
  span.style.backgroundColor = "rgba(250, 204, 21, 0.6)";
  span.style.borderRadius = "2px";
  span.style.padding = "0 1px";

  // Naive approach: wrap text content from first match node up to last match
  // node. May cross inline elements but acceptable for a soft highlight.
  const first = ranges.find((r) => r.end > idx);
  const last = [...ranges].reverse().find((r) => r.start < matchEnd);
  if (!first || !last) return;

  // Split boundary nodes so the marked range is exactly the needle.
  const firstOffset = Math.max(0, idx - first.start);
  const lastOffset = Math.min(last.node.nodeValue?.length ?? 0, matchEnd - last.start);
  const startNode = firstOffset > 0 ? (first.node.splitText(firstOffset) as Text) : first.node;
  if (last.node === first.node) {
    // Single-node match: split again to close the range.
    if (lastOffset - firstOffset < startNode.nodeValue!.length) {
      startNode.splitText(lastOffset - firstOffset);
    }
    span.appendChild(startNode.cloneNode(true));
    startNode.replaceWith(span);
  } else {
    // Multi-node match: collect up to and including the last split segment.
    const endTail = last.node.splitText(lastOffset);
    void endTail; // remaining tail stays outside the mark
    const toWrap: Node[] = [];
    let cursor: Node | null = startNode;
    while (cursor) {
      toWrap.push(cursor);
      if (cursor === last.node) break;
      const next: Node | null = cursor.nextSibling ?? cursor.parentNode?.nextSibling ?? null;
      cursor = next;
    }
    const parent = startNode.parentNode;
    if (parent) {
      parent.insertBefore(span, startNode);
      for (const n of toWrap) span.appendChild(n);
    }
  }

  highlightRef.current = span;
  span.scrollIntoView({ behavior: "auto", block: "center" });
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
