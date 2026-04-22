import { createHash } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import PQueue from "p-queue";
import log from "electron-log/main.js";
import type { IngestionPipeline, IngestionFileRecord } from "../IngestionPipeline";
import type {
  FileStatus,
  WebCrawlProgress,
  WebSource,
  WebSourceStatus,
} from "../../../../../shared/types";
import { extractFromHtml, isSubstantial, type ExtractedPage } from "./HtmlExtractor";
import { PolitenessGate, RobotsRegistry, sleep } from "./RobotsParser";

/** Identifier the crawler uses for its User-Agent string. */
export const USER_AGENT = "RAGraph/0.1 (+https://github.com/ADVASYS/ragraph)";

/** Hard cap on a single page's byte size. Anything larger is skipped. */
const MAX_HTML_BYTES = 4 * 1024 * 1024;
/** Overall fetch timeout per request (ms). */
const FETCH_TIMEOUT_MS = 20_000;
/** Concurrent fetches per source. */
const DEFAULT_CONCURRENCY = 2;
/** Politeness delay between two requests to the same origin (ms). */
const DEFAULT_DELAY_MS = 500;

export interface WebPageRow {
  id: string;
  sourceId: string;
  universeId: string;
  url: string;
  normalizedUrl: string;
  httpStatus: number | null;
  contentHash: string | null;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number | null;
  depth: number;
  fileId: string | null;
}

export interface WebFileRow {
  id: string;
  universeId: string;
  webSourceId: string;
  absPath: string;
  relPath: string;
  mtime: number;
  size: number;
  hash: string | null;
  status: FileStatus;
}

/**
 * Side-effect contract the crawler uses for persistence. Kept deliberately
 * narrow so the core module stays decoupled from Electron's data layer.
 */
export interface WebCrawlerRepository {
  getPage(sourceId: string, normalizedUrl: string): WebPageRow | null;
  upsertPage(row: WebPageRow): void;
  listPages(sourceId: string): WebPageRow[];
  getFileByPath(universeId: string, absPath: string): WebFileRow | null;
  insertFile(row: WebFileRow): void;
  updateFile(id: string, patch: Partial<WebFileRow>): void;
  setSourceStatus(sourceId: string, status: WebSourceStatus, error: string | null): void;
  setSourceScanned(sourceId: string, lastScanAt: number, nextScanAt: number | null): void;
}

export interface WebCrawlerDeps {
  pipeline: IngestionPipeline;
  repo: WebCrawlerRepository;
  cacheDir: (universeId: string, sourceId: string) => string;
  emitProgress: (progress: WebCrawlProgress) => void;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  concurrency?: number;
  /** Injected for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * One-shot crawler run bound to a specific `WebSource` configuration. The
 * instance is single-use: construct it, `await run()`, then discard.
 */
export class WebCrawler {
  private readonly robots: RobotsRegistry;
  private readonly politeness: PolitenessGate;
  private readonly queue: PQueue;
  private readonly visited = new Set<string>();
  private readonly enqueued = new Set<string>();
  private readonly includeRegex: RegExp[];
  private readonly excludeRegex: RegExp[];
  private aborted = false;
  private pagesDiscovered = 0;
  private pagesFetched = 0;
  private pagesSkipped = 0;
  private pagesFailed = 0;

  constructor(
    private readonly source: WebSource,
    private readonly deps: WebCrawlerDeps,
  ) {
    const ua = deps.userAgent ?? USER_AGENT;
    this.robots = new RobotsRegistry(ua, deps.fetchImpl);
    this.politeness = new PolitenessGate(DEFAULT_DELAY_MS);
    this.queue = new PQueue({ concurrency: Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY) });
    this.includeRegex = compileRegexList(source.includePatterns);
    this.excludeRegex = compileRegexList(source.excludePatterns);
  }

  /** Signal the run to stop; in-flight fetches finish but no new pages are queued. */
  abort(): void {
    this.aborted = true;
    this.queue.clear();
  }

  async run(): Promise<void> {
    const now = this.deps.now ?? Date.now;
    this.deps.repo.setSourceStatus(this.source.id, "crawling", null);
    this.emit("queue");

    try {
      const seeds = await this.collectSeeds();
      for (const seed of seeds) this.enqueueUrl(seed, 0);

      await this.queue.onIdle();

      const next = this.source.refreshIntervalHours && this.source.refreshIntervalHours > 0
        ? now() + this.source.refreshIntervalHours * 3_600_000
        : null;
      this.deps.repo.setSourceScanned(this.source.id, now(), next);
      this.deps.repo.setSourceStatus(this.source.id, this.aborted ? "idle" : "idle", null);
      this.emit("done");
    } catch (err) {
      const message = (err as Error).message || String(err);
      this.deps.repo.setSourceStatus(this.source.id, "error", message);
      this.emit("error", undefined, message);
      log.error("web.crawl.failed", { sourceId: this.source.id, url: this.source.url, message });
    }
  }

  /**
   * Determine the initial URL set. For 'sitemap' scope we try sitemap.xml
   * exclusively; 'site' first asks robots.txt for sitemap hints and falls
   * back to the start URL; 'single' just seeds the start URL.
   */
  private async collectSeeds(): Promise<string[]> {
    const start = normalizeUrl(this.source.url);
    if (!start) return [];
    if (this.source.scope === "single") return [start];

    const fromRobots = await this.robots.get(start);
    const sitemapCandidates = new Set<string>(fromRobots.sitemaps);
    try {
      const u = new URL(start);
      sitemapCandidates.add(`${u.origin}/sitemap.xml`);
    } catch {
      // ignore
    }

    const seeds: string[] = [];
    for (const sm of sitemapCandidates) {
      const urls = await this.loadSitemap(sm);
      for (const u of urls) {
        const nu = normalizeUrl(u);
        if (nu) seeds.push(nu);
      }
    }
    if (this.source.scope === "sitemap") return seeds.length ? seeds : [start];
    return seeds.length ? Array.from(new Set([start, ...seeds])) : [start];
  }

  /** Fetch and parse a sitemap. Handles <sitemapindex> recursion one level deep. */
  private async loadSitemap(url: string, depth = 0): Promise<string[]> {
    if (depth > 2) return [];
    try {
      const res = await this.fetch(url, {});
      if (!res.ok || !res.body) return [];
      const text = await res.text();
      if (/<sitemapindex/i.test(text)) {
        const childUrls = Array.from(text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);
        const acc: string[] = [];
        for (const child of childUrls) {
          acc.push(...(await this.loadSitemap(child, depth + 1)));
        }
        return acc;
      }
      return Array.from(text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);
    } catch {
      return [];
    }
  }

  /** Add a URL to the queue after applying depth/origin/pattern filters. */
  private enqueueUrl(url: string, depth: number): void {
    if (this.aborted) return;
    if (this.pagesDiscovered >= this.source.maxPages) return;
    if (depth > this.source.maxDepth) return;
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    if (this.enqueued.has(normalized)) return;
    if (!this.isInScope(normalized)) return;

    this.enqueued.add(normalized);
    this.pagesDiscovered++;
    this.queue.add(() => this.processUrl(normalized, depth));
  }

  private isInScope(url: string): boolean {
    try {
      const target = new URL(url);
      if (target.protocol !== "http:" && target.protocol !== "https:") return false;
      if (this.source.sameOrigin) {
        const root = new URL(this.source.url);
        if (target.hostname !== root.hostname) return false;
      }
      if (this.excludeRegex.some((re) => re.test(url))) return false;
      if (this.includeRegex.length && !this.includeRegex.some((re) => re.test(url))) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * End-to-end handling of a single URL: politeness, robots, conditional
   * fetch, extraction, cache + DB upsert, and pipeline enqueue.
   */
  private async processUrl(url: string, depth: number): Promise<void> {
    if (this.aborted) return;
    if (this.visited.has(url)) return;
    this.visited.add(url);

    try {
      const robots = await this.robots.get(url);
      if (!robots.isAllowed(url)) {
        this.pagesSkipped++;
        this.emit("skip", url, "robots");
        return;
      }
      await this.politeness.wait(url, robots.crawlDelayMs);

      const previous = this.deps.repo.getPage(this.source.id, url);
      const headers: Record<string, string> = {
        "user-agent": this.deps.userAgent ?? USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "accept-language": "en,*;q=0.5",
      };
      if (previous?.etag) headers["if-none-match"] = previous.etag;
      if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;

      this.emit("fetch", url);
      const res = await this.fetch(url, { headers });

      if (res.status === 304) {
        this.pagesSkipped++;
        this.deps.repo.upsertPage({
          ...(previous as WebPageRow),
          fetchedAt: (this.deps.now ?? Date.now)(),
          httpStatus: 304,
        });
        this.emit("skip", url, "not-modified");
        if (depth < this.source.maxDepth && previous?.fileId) {
          // No new links to discover without body; move on.
        }
        return;
      }

      if (!res.ok) {
        this.pagesFailed++;
        this.deps.repo.upsertPage({
          id: previous?.id ?? nanoid(),
          sourceId: this.source.id,
          universeId: this.source.universeId,
          url,
          normalizedUrl: url,
          httpStatus: res.status,
          contentHash: previous?.contentHash ?? null,
          etag: previous?.etag ?? null,
          lastModified: previous?.lastModified ?? null,
          fetchedAt: (this.deps.now ?? Date.now)(),
          depth,
          fileId: previous?.fileId ?? null,
        });
        this.emit("error", url, `HTTP ${res.status}`);
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!/html|xml|text\/plain/i.test(contentType)) {
        this.pagesSkipped++;
        this.emit("skip", url, `content-type ${contentType || "unknown"}`);
        return;
      }

      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_HTML_BYTES) {
        this.pagesSkipped++;
        this.emit("skip", url, "too-large");
        return;
      }
      const html = new TextDecoder().decode(new Uint8Array(buf));

      this.emit("extract", url);
      const extracted = extractFromHtml(html, url);
      if (!isSubstantial(extracted)) {
        this.pagesSkipped++;
        this.emit("skip", url, "boilerplate");
        return;
      }

      const etag = res.headers.get("etag");
      const lastModified = res.headers.get("last-modified");
      await this.persistPage({ url, depth, extracted, etag, lastModified, httpStatus: res.status });
      this.pagesFetched++;

      // Queue new links discovered in this page.
      if (depth + 1 <= this.source.maxDepth) {
        for (const link of extracted.links) this.enqueueUrl(link, depth + 1);
      }
    } catch (err) {
      this.pagesFailed++;
      const message = (err as Error).message || String(err);
      log.warn("web.page.failed", { sourceId: this.source.id, url, message });
      this.emit("error", url, message);
    }
  }

  /**
   * Write the extracted markdown to cache, upsert the `web_pages` + `files`
   * rows, and enqueue the file for the normal ingestion pipeline.
   */
  private async persistPage(args: {
    url: string;
    depth: number;
    extracted: ExtractedPage;
    etag: string | null;
    lastModified: string | null;
    httpStatus: number;
  }): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const { url, depth, extracted, etag, lastModified, httpStatus } = args;

    const dir = this.deps.cacheDir(this.source.universeId, this.source.id);
    const hashPrefix = extracted.contentHash.slice(0, 8);
    const slug = slugifyUrl(url);
    const fileName = `${slug}-${hashPrefix}.md`;
    const absPath = join(dir, fileName);
    const relPath = `web/${this.source.id}/${fileName}`;
    const markdown = buildMarkdownWithFrontMatter(url, extracted, this.source.id);
    const size = Buffer.byteLength(markdown, "utf8");
    const fileHash = createHash("sha256").update(markdown).digest("hex");

    const previousPage = this.deps.repo.getPage(this.source.id, url);

    // Content-hash dedupe: unchanged page → just bump fetch metadata.
    if (previousPage?.contentHash === extracted.contentHash && previousPage.fileId) {
      this.emit("cache", url, "unchanged");
      this.deps.repo.upsertPage({
        id: previousPage.id,
        sourceId: this.source.id,
        universeId: this.source.universeId,
        url,
        normalizedUrl: url,
        httpStatus,
        contentHash: extracted.contentHash,
        etag,
        lastModified,
        fetchedAt: now,
        depth,
        fileId: previousPage.fileId,
      });
      return;
    }

    // Remove the stale cache file if the name is changing (hash prefix differs).
    if (previousPage?.fileId) {
      const prevFile = this.deps.repo.getFileByPath(this.source.universeId, absPath);
      if (!prevFile) {
        await this.removeStaleFile(previousPage.fileId);
      }
    }

    await writeFile(absPath, markdown, "utf8");
    this.emit("cache", url);

    let fileId = previousPage?.fileId ?? null;
    const existingFile = this.deps.repo.getFileByPath(this.source.universeId, absPath);
    if (existingFile) {
      fileId = existingFile.id;
      this.deps.repo.updateFile(fileId, {
        mtime: now,
        size,
        hash: fileHash,
        status: "pending",
      });
    } else {
      fileId = nanoid();
      this.deps.repo.insertFile({
        id: fileId,
        universeId: this.source.universeId,
        webSourceId: this.source.id,
        absPath,
        relPath,
        mtime: now,
        size,
        hash: fileHash,
        status: "pending",
      });
    }

    this.deps.repo.upsertPage({
      id: previousPage?.id ?? nanoid(),
      sourceId: this.source.id,
      universeId: this.source.universeId,
      url,
      normalizedUrl: url,
      httpStatus,
      contentHash: extracted.contentHash,
      etag,
      lastModified,
      fetchedAt: now,
      depth,
      fileId,
    });

    const record: IngestionFileRecord = {
      id: fileId,
      universeId: this.source.universeId,
      absPath,
      relPath,
      mtime: now,
      size,
      hash: fileHash,
      status: "pending",
    };
    this.emit("ingest", url);
    // Fire-and-forget into the pipeline's queue.
    void this.deps.pipeline.ingestFile(record);
  }

  private async removeStaleFile(fileId: string): Promise<void> {
    try {
      const pages = this.deps.repo.listPages(this.source.id).filter((p) => p.fileId === fileId);
      for (const p of pages) {
        this.deps.repo.upsertPage({ ...p, fileId: null });
      }
    } catch {
      // Non-fatal: worst case, orphan row stays.
    }
  }

  private emit(phase: WebCrawlProgress["phase"], currentUrl?: string, message?: string): void {
    this.deps.emitProgress({
      universeId: this.source.universeId,
      sourceId: this.source.id,
      phase,
      currentUrl,
      pagesDiscovered: this.pagesDiscovered,
      pagesFetched: this.pagesFetched,
      pagesSkipped: this.pagesSkipped,
      pagesFailed: this.pagesFailed,
      maxPages: this.source.maxPages,
      message,
    });
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const impl = this.deps.fetchImpl ?? fetch;
      return await impl(url, {
        ...init,
        signal: controller.signal,
        redirect: "follow",
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Clear a cached web file from disk. Used when a source is deleted. */
export async function removeCachedFile(absPath: string): Promise<void> {
  try {
    await unlink(absPath);
  } catch {
    // File already gone — nothing to do.
  }
}

/**
 * Normalize a URL for deduplication: lowercase host, drop fragment, strip
 * default ports, sort query params. Returns null for unparsable inputs.
 */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    // Sort search params so ?a=1&b=2 equals ?b=2&a=1.
    const params = Array.from(u.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of params) u.searchParams.append(k, v);
    // Drop trailing slash on path when it's not the root.
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return null;
  }
}

/** Convert a URL to a safe filename fragment. */
export function slugifyUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = `${u.hostname}${u.pathname}${u.search ? `_${u.search}` : ""}`;
    return path
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "page";
  } catch {
    return "page";
  }
}

/** Compile a list of raw regex strings; skips invalid patterns silently. */
function compileRegexList(patterns: string[] | undefined): RegExp[] {
  if (!patterns?.length) return [];
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      // ignore invalid
    }
  }
  return out;
}

function buildMarkdownWithFrontMatter(url: string, ex: ExtractedPage, sourceId: string): string {
  const lines = ["---"];
  lines.push(`title: ${quoteYaml(ex.title)}`);
  lines.push(`source_url: ${quoteYaml(url)}`);
  lines.push(`canonical_url: ${quoteYaml(ex.canonicalUrl)}`);
  if (ex.byline) lines.push(`author: ${quoteYaml(ex.byline)}`);
  if (ex.lang) lines.push(`language: ${quoteYaml(ex.lang)}`);
  lines.push(`web_source_id: ${quoteYaml(sourceId)}`);
  lines.push(`fetched_at: ${new Date().toISOString()}`);
  lines.push("---");
  lines.push("");
  lines.push(ex.markdown);
  return lines.join("\n");
}

function quoteYaml(value: string): string {
  const needsQuote = /[:#>|\-&*!%@`,{}\[\]?]/.test(value) || /^\s|\s$/.test(value);
  if (!needsQuote) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export { sleep };
