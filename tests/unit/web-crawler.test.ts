import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WebCrawler,
  normalizeUrl,
  slugifyUrl,
  type WebCrawlerRepository,
  type WebPageRow,
  type WebFileRow,
} from "../../electron/main/core/ingestion/web/WebCrawler";
import type {
  IngestionFileRecord,
  IngestionPipeline,
} from "../../electron/main/core/ingestion/IngestionPipeline";
import type { WebSource } from "../../shared/types";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function htmlPage(title: string, body: string, links: string[] = []): string {
  const linkHtml = links.map((l) => `<a href="${l}">link</a>`).join("");
  return `<html lang="en"><head><title>${title}</title></head><body><article><h1>${title}</h1>${body}${linkHtml}</article></body></html>`;
}

interface ResponseInit2 {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

function makeResponse({ status = 200, headers = {}, body = "" }: ResponseInit2): Response {
  const h = new Headers(headers);
  return new Response(body, { status, headers: h });
}

interface FakeFetchHit {
  body: string;
  status?: number;
  headers?: Record<string, string>;
}

function fakeFetch(map: Record<string, FakeFetchHit | ((headers: Headers) => Response)>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; headers: Headers }>;
} {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers((init?.headers as HeadersInit) ?? {});
    calls.push({ url, headers });
    const entry = map[url] ?? map[url.replace(/\/$/, "")];
    if (!entry) return makeResponse({ status: 404, body: "not found" });
    if (typeof entry === "function") return entry(headers);
    return makeResponse({
      status: entry.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...entry.headers },
      body: entry.body,
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function memoryRepo(): WebCrawlerRepository & { pages: Map<string, WebPageRow>; files: Map<string, WebFileRow> } {
  const pages = new Map<string, WebPageRow>();
  const files = new Map<string, WebFileRow>();
  return {
    pages,
    files,
    getPage: (sourceId, normalizedUrl) => pages.get(`${sourceId}::${normalizedUrl}`) ?? null,
    upsertPage: (row) => pages.set(`${row.sourceId}::${row.normalizedUrl}`, row),
    listPages: (sourceId) => Array.from(pages.values()).filter((p) => p.sourceId === sourceId),
    getFileByPath: (universeId, absPath) => {
      for (const f of files.values()) {
        if (f.universeId === universeId && f.absPath === absPath) return f;
      }
      return null;
    },
    insertFile: (row) => files.set(row.id, row),
    updateFile: (id, patch) => {
      const prev = files.get(id);
      if (prev) files.set(id, { ...prev, ...patch } as WebFileRow);
    },
    setSourceStatus: () => void 0,
    setSourceScanned: () => void 0,
  };
}

function stubPipeline(): IngestionPipeline & { ingested: IngestionFileRecord[] } {
  const ingested: IngestionFileRecord[] = [];
  const pipe = {
    ingested,
    async ingestFile(r: IngestionFileRecord) {
      ingested.push(r);
    },
  };
  return pipe as unknown as IngestionPipeline & { ingested: IngestionFileRecord[] };
}

function baseSource(url: string, overrides: Partial<WebSource> = {}): WebSource {
  return {
    id: "src1",
    universeId: "u1",
    url,
    scope: "site",
    maxDepth: 1,
    maxPages: 10,
    sameOrigin: true,
    includePatterns: [],
    excludePatterns: [],
    refreshIntervalHours: null,
    enabled: true,
    status: "idle",
    lastScanAt: null,
    nextScanAt: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("normalizeUrl", () => {
  it("strips fragments and default ports and sorts query", () => {
    expect(normalizeUrl("HTTPS://Example.com:443/path/?b=2&a=1#section")).toBe(
      "https://example.com/path?a=1&b=2",
    );
  });
  it("rejects non-http protocols", () => {
    expect(normalizeUrl("ftp://example.com")).toBeNull();
    expect(normalizeUrl("mailto:a@b")).toBeNull();
  });
});

describe("slugifyUrl", () => {
  it("produces safe filename fragments", () => {
    const s = slugifyUrl("https://Example.com/Some/Path?x=1");
    expect(s).toMatch(/^[a-z0-9-]+$/);
    expect(s.length).toBeLessThanOrEqual(80);
  });
});

describe("WebCrawler", () => {
  let cacheRoot: string;
  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "ragraph-web-"));
  });
  afterEach(() => rmSync(cacheRoot, { recursive: true, force: true }));

  it("crawls same-origin pages up to max depth and writes markdown + files rows", async () => {
    const longBody = "<p>" + "This is substantial page content. ".repeat(20) + "</p>";
    const { fetch: fetchImpl } = fakeFetch({
      "https://example.test/robots.txt": { body: "" },
      "https://example.test/sitemap.xml": { body: "" },
      "https://example.test": {
        body: htmlPage("Home", longBody, ["/a", "/b", "https://other.test/x"]),
      },
      "https://example.test/": {
        body: htmlPage("Home", longBody, ["/a", "/b", "https://other.test/x"]),
      },
      "https://example.test/a": { body: htmlPage("Page A", longBody) },
      "https://example.test/b": { body: htmlPage("Page B", longBody) },
      "https://other.test/x": { body: htmlPage("Other", longBody) },
    });

    const repo = memoryRepo();
    const pipeline = stubPipeline();

    const crawler = new WebCrawler(
      baseSource("https://example.test/", { scope: "site", maxDepth: 1, maxPages: 10 }),
      {
        pipeline,
        repo,
        cacheDir: () => cacheRoot,
        emitProgress: () => void 0,
        fetchImpl,
      },
    );
    await crawler.run();

    // Home + /a + /b; sitemap is empty so only start + discovered links get fetched.
    expect(pipeline.ingested.length).toBeGreaterThanOrEqual(3);
    // Other-origin link must be dropped by sameOrigin filter.
    const ingestedUrls = Array.from(repo.pages.values()).map((p) => p.url);
    expect(ingestedUrls.every((u) => new URL(u).hostname === "example.test")).toBe(true);

    // Each ingested record has a file on disk with frontmatter including source_url.
    for (const rec of pipeline.ingested) {
      expect(existsSync(rec.absPath)).toBe(true);
      const md = readFileSync(rec.absPath, "utf8");
      expect(md.startsWith("---\n")).toBe(true);
      expect(md).toContain("source_url: ");
    }
  });

  it("dedupes unchanged content via content hash on re-crawl", async () => {
    const longBody = "<p>" + "stable content stable content stable content. ".repeat(30) + "</p>";
    const map = {
      "https://stable.test/robots.txt": { body: "" },
      "https://stable.test": { body: htmlPage("Stable", longBody) },
      "https://stable.test/": { body: htmlPage("Stable", longBody) },
    };
    const { fetch: fetchImpl } = fakeFetch(map);

    const repo = memoryRepo();
    const pipeline = stubPipeline();

    await new WebCrawler(
      baseSource("https://stable.test/", { scope: "single", maxDepth: 0 }),
      { pipeline, repo, cacheDir: () => cacheRoot, emitProgress: () => void 0, fetchImpl },
    ).run();
    const firstIngestCount = pipeline.ingested.length;
    expect(firstIngestCount).toBe(1);

    // Second run with identical content → dedupe path, no new ingestion.
    await new WebCrawler(
      baseSource("https://stable.test/", { scope: "single", maxDepth: 0 }),
      { pipeline, repo, cacheDir: () => cacheRoot, emitProgress: () => void 0, fetchImpl },
    ).run();
    expect(pipeline.ingested.length).toBe(firstIngestCount);
  });

  it("honors 304 Not Modified responses", async () => {
    const longBody = "<p>" + "cached content cached content. ".repeat(40) + "</p>";
    const map: Record<string, FakeFetchHit | ((h: Headers) => Response)> = {
      "https://cached.test/robots.txt": { body: "" },
      "https://cached.test": {
        body: htmlPage("Cached", longBody),
        headers: { etag: '"abc"', "content-type": "text/html" },
      },
      "https://cached.test/": {
        body: htmlPage("Cached", longBody),
        headers: { etag: '"abc"', "content-type": "text/html" },
      },
    };
    const { fetch: fetchImpl } = fakeFetch(map);

    const repo = memoryRepo();
    const pipeline = stubPipeline();
    await new WebCrawler(
      baseSource("https://cached.test/", { scope: "single", maxDepth: 0 }),
      { pipeline, repo, cacheDir: () => cacheRoot, emitProgress: () => void 0, fetchImpl },
    ).run();
    expect(pipeline.ingested.length).toBe(1);

    // Swap in a 304 handler (the WHATWG Response constructor refuses 304, so
    // we hand-craft a minimal response-like object with just the shape the
    // crawler reads).
    const not304 = {
      ok: false,
      status: 304,
      headers: new Headers({ etag: '"abc"' }),
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
      async text() {
        return "";
      },
      body: null,
    } as unknown as Response;
    const fetchImpl2 = (async () => not304) as unknown as typeof fetch;

    await new WebCrawler(
      baseSource("https://cached.test/", { scope: "single", maxDepth: 0 }),
      { pipeline, repo, cacheDir: () => cacheRoot, emitProgress: () => void 0, fetchImpl: fetchImpl2 },
    ).run();
    // Same ingestion count — 304 path does not re-ingest.
    expect(pipeline.ingested.length).toBe(1);
  });

  it("respects robots.txt Disallow", async () => {
    const longBody = "<p>" + "blocked content blocked content. ".repeat(30) + "</p>";
    const { fetch: fetchImpl } = fakeFetch({
      "https://blocked.test/robots.txt": {
        body: "User-agent: *\nDisallow: /",
        headers: { "content-type": "text/plain" },
      },
      "https://blocked.test": { body: htmlPage("Blocked", longBody) },
      "https://blocked.test/": { body: htmlPage("Blocked", longBody) },
    });

    const repo = memoryRepo();
    const pipeline = stubPipeline();
    await new WebCrawler(
      baseSource("https://blocked.test/", { scope: "single", maxDepth: 0 }),
      { pipeline, repo, cacheDir: () => cacheRoot, emitProgress: () => void 0, fetchImpl },
    ).run();
    expect(pipeline.ingested.length).toBe(0);
  });
});
