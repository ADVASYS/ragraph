import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import TurndownService from "turndown";

/**
 * Structured output of a successful HTML extraction.
 */
export interface ExtractedPage {
  /** Canonical page title (readability title > <title> > URL hostname). */
  title: string;
  /** Clean Markdown ready to feed into the ingestion pipeline. */
  markdown: string;
  /** Short human-readable excerpt (first ~200 chars, trimmed). */
  excerpt: string;
  /** Author/byline if readability could detect one. */
  byline: string | null;
  /** BCP-47 language code guessed from <html lang>, if any. */
  lang: string | null;
  /** Absolute URL after following <base> / meta refreshes (if any). */
  canonicalUrl: string;
  /** Hyperlinks (absolute) discovered in the rendered document. */
  links: string[];
  /** sha256 of the extracted Markdown — used for change detection. */
  contentHash: string;
}

/**
 * Heuristic boundary for "real" content after extraction. Shorter documents
 * are generally boilerplate (login walls, 404s, cookie banners).
 */
const MIN_MARKDOWN_LENGTH = 120;

let _turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (_turndown) return _turndown;
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    linkStyle: "inlined",
  });
  td.remove(["script", "style", "noscript", "iframe", "form", "nav", "footer"]);
  td.addRule("lazyImages", {
    filter: (node) => node.nodeName === "IMG",
    replacement: (_content, node) => {
      const img = node as unknown as { getAttribute: (k: string) => string | null };
      const alt = img.getAttribute("alt") ?? "";
      const src = img.getAttribute("src") ?? img.getAttribute("data-src") ?? "";
      if (!src) return alt;
      return `![${alt}](${src})`;
    },
  });
  _turndown = td;
  return td;
}

/**
 * Convert an HTML document to clean Markdown. Uses Mozilla Readability to
 * isolate article content where possible; falls back to converting the
 * stripped <body> when the page is not article-like.
 *
 * Uses `linkedom` (pure-CJS DOM implementation) instead of jsdom to stay
 * compatible with Electron's CommonJS require-graph — jsdom pulls in
 * ESM-only dependencies that break `require()` at runtime.
 */
export function extractFromHtml(html: string, url: string): ExtractedPage {
  const { document } = parseHTML(html);
  const doc = document as unknown as Document;

  const canonicalLink = doc.querySelector("link[rel='canonical']");
  const canonicalHref = canonicalLink?.getAttribute("href")?.trim();
  const canonicalUrl = canonicalHref ? safeResolve(canonicalHref, url) : url;
  const lang = doc.documentElement?.getAttribute("lang")?.trim() || null;
  const links = collectLinks(doc, url);

  const titleFromDoc = doc.querySelector("title")?.textContent?.trim();
  let title = titleFromDoc || safeHost(url);
  let markdown = "";
  let excerpt = "";
  let byline: string | null = null;

  const td = getTurndown();

  try {
    // Readability needs a real Document; linkedom's is compatible.
    if (isProbablyReaderable(doc)) {
      // Readability mutates the document it parses; clone first so the
      // fallback body conversion still has the original DOM.
      const clone = parseHTML(html).document as unknown as Document;
      const reader = new Readability(clone, { keepClasses: false });
      const article = reader.parse();
      if (article?.content) {
        title = (article.title ?? title).trim() || title;
        byline = article.byline?.trim() || null;
        excerpt = article.excerpt?.trim() || "";
        markdown = td.turndown(article.content);
      }
    }
  } catch {
    // Fall through to body-based extraction.
  }

  if (!markdown || markdown.length < MIN_MARKDOWN_LENGTH) {
    const body = doc.body;
    if (body) {
      body.querySelectorAll("script,style,noscript,iframe,form,nav,footer,header,aside").forEach((n) => n.remove());
      markdown = td.turndown(body.innerHTML);
    }
  }

  markdown = normalizeMarkdown(markdown);
  if (!excerpt) {
    excerpt = markdown.replace(/\s+/g, " ").slice(0, 240).trim();
  }
  const contentHash = createHash("sha256").update(markdown).digest("hex");

  return {
    title,
    markdown,
    excerpt,
    byline,
    lang,
    canonicalUrl,
    links,
    contentHash,
  };
}

/**
 * Extract absolute href targets from the rendered document. Anchors with
 * javascript:/mailto:/tel:/data: schemes and in-page fragments are dropped.
 */
function collectLinks(doc: Document, base: string): string[] {
  const out = new Set<string>();
  const anchors = Array.from(doc.querySelectorAll("a[href]")) as unknown as Array<{
    getAttribute(name: string): string | null;
  }>;
  for (const a of anchors) {
    const raw = a.getAttribute("href");
    if (!raw) continue;
    const href = raw.trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(href)) continue;
    try {
      const abs = new URL(href, base);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      abs.hash = "";
      out.add(abs.toString());
    } catch {
      // Skip malformed hrefs.
    }
  }
  return Array.from(out);
}

/** Collapse runs of blank lines and trim leading/trailing whitespace. */
function normalizeMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2000-\u200f\u202f\u205f\u3000]/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Whether the extracted content is substantial enough to ingest. */
export function isSubstantial(ext: ExtractedPage): boolean {
  return ext.markdown.length >= MIN_MARKDOWN_LENGTH;
}

function safeResolve(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return base;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
