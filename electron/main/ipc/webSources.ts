import { ipcMain } from "electron";
import log from "electron-log/main.js";
import { IPC } from "../../../shared/ipc";
import type { AppContext } from "../services/AppContext";
import type {
  WebPagePreview,
  WebSource,
  WebSourceScope,
} from "../../../shared/types";
import { extractFromHtml } from "../core/ingestion/web/HtmlExtractor";
import { USER_AGENT } from "../core/ingestion/web/WebCrawler";

interface CreateWebSourceInput {
  universeId: string;
  url: string;
  scope?: WebSourceScope;
  maxDepth?: number;
  maxPages?: number;
  sameOrigin?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
  refreshIntervalHours?: number | null;
}

/** Hard caps enforced server-side regardless of what the UI sends. */
const LIMITS = {
  maxDepth: { min: 0, max: 5, default: 2 },
  maxPages: { min: 1, max: 2000, default: 100 },
  refreshIntervalHours: { min: 1, max: 24 * 90 },
};

export function registerWebSourceHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.WebSource.List, (_e, universeId: string): WebSource[] => {
    return ctx.listWebSources(universeId);
  });

  ipcMain.handle(IPC.WebSource.Create, async (_e, input: CreateWebSourceInput): Promise<string> => {
    const normalized = normalizeCreateInput(input);
    const id = ctx.createWebSource(normalized);
    // Kick off first crawl in the background so the UI returns quickly.
    void ctx.runWebCrawl(id).catch((err) =>
      log.warn("web.create.crawl failed", { sourceId: id, err: (err as Error).message }),
    );
    return id;
  });

  ipcMain.handle(IPC.WebSource.Update, async (_e, id: string, patch: Partial<WebSource>) => {
    const cleaned: Partial<WebSource> = { ...patch };
    if (typeof cleaned.maxDepth === "number") {
      cleaned.maxDepth = clamp(cleaned.maxDepth, LIMITS.maxDepth.min, LIMITS.maxDepth.max);
    }
    if (typeof cleaned.maxPages === "number") {
      cleaned.maxPages = clamp(cleaned.maxPages, LIMITS.maxPages.min, LIMITS.maxPages.max);
    }
    if (cleaned.refreshIntervalHours != null) {
      cleaned.refreshIntervalHours = clamp(
        cleaned.refreshIntervalHours,
        LIMITS.refreshIntervalHours.min,
        LIMITS.refreshIntervalHours.max,
      );
    }
    ctx.updateWebSource(id, cleaned);
  });

  ipcMain.handle(IPC.WebSource.Delete, async (_e, id: string) => {
    await ctx.deleteWebSource(id);
  });

  ipcMain.handle(IPC.WebSource.Rescan, async (_e, id: string) => {
    // Fire-and-forget: the renderer tracks progress via the WebCrawlProgress event.
    void ctx.runWebCrawl(id).catch((err) =>
      log.warn("web.rescan.crawl failed", { sourceId: id, err: (err as Error).message }),
    );
  });

  ipcMain.handle(IPC.WebSource.CancelScan, (_e, id: string) => {
    ctx.cancelWebCrawl(id);
  });

  ipcMain.handle(IPC.WebSource.TestUrl, async (_e, url: string): Promise<WebPagePreview> => {
    const cleaned = url.trim();
    if (!/^https?:\/\//i.test(cleaned)) {
      throw new Error("Invalid URL: must start with http:// or https://");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(cleaned, {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "";
      if (!/html|xml|text\/plain/i.test(contentType)) {
        throw new Error(`Unsupported content-type: ${contentType || "unknown"}`);
      }
      const html = await res.text();
      const extracted = extractFromHtml(html, cleaned);
      return {
        url: extracted.canonicalUrl,
        title: extracted.title,
        excerpt: extracted.excerpt,
        byline: extracted.byline,
        lang: extracted.lang,
        markdownLength: extracted.markdown.length,
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

function normalizeCreateInput(input: CreateWebSourceInput) {
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("Invalid URL");
  return {
    universeId: input.universeId,
    url,
    scope: (input.scope ?? "site") as WebSourceScope,
    maxDepth: clamp(input.maxDepth ?? LIMITS.maxDepth.default, LIMITS.maxDepth.min, LIMITS.maxDepth.max),
    maxPages: clamp(input.maxPages ?? LIMITS.maxPages.default, LIMITS.maxPages.min, LIMITS.maxPages.max),
    sameOrigin: input.sameOrigin ?? true,
    includePatterns: input.includePatterns ?? [],
    excludePatterns: input.excludePatterns ?? [],
    refreshIntervalHours:
      input.refreshIntervalHours && input.refreshIntervalHours > 0
        ? clamp(input.refreshIntervalHours, LIMITS.refreshIntervalHours.min, LIMITS.refreshIntervalHours.max)
        : null,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}
