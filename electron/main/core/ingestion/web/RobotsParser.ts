import robotsParser from "robots-parser";

/**
 * Thin wrapper around the `robots-parser` library. Fetches robots.txt once
 * per origin and caches the result so repeated allow-checks during a crawl
 * are cheap. An HTTP error (404, 5xx, timeouts) is treated as "no rules" —
 * the common permissive default.
 */
export class RobotsRegistry {
  private readonly cache = new Map<string, RobotsHandle>();

  constructor(
    private readonly userAgent: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(url: string): Promise<RobotsHandle> {
    const origin = safeOrigin(url);
    if (!origin) return PERMISSIVE;
    const cached = this.cache.get(origin);
    if (cached) return cached;

    const robotsUrl = `${origin}/robots.txt`;
    let handle: RobotsHandle = PERMISSIVE;
    try {
      const res = await this.fetchImpl(robotsUrl, {
        method: "GET",
        headers: { "user-agent": this.userAgent, accept: "text/plain,*/*" },
        redirect: "follow",
      });
      if (res.ok) {
        const body = await res.text();
        const parser = robotsParser(robotsUrl, body);
        handle = {
          isAllowed: (target) => parser.isAllowed(target, this.userAgent) ?? true,
          crawlDelayMs: (() => {
            const d = parser.getCrawlDelay(this.userAgent);
            return typeof d === "number" && d > 0 ? Math.round(d * 1000) : 0;
          })(),
          sitemaps: parser.getSitemaps() ?? [],
        };
      }
    } catch {
      // Network error -> fall back to permissive.
    }
    this.cache.set(origin, handle);
    return handle;
  }
}

export interface RobotsHandle {
  isAllowed(url: string): boolean;
  /** Recommended delay between requests to the same origin, in ms. */
  crawlDelayMs: number;
  /** Sitemap URLs advertised in robots.txt (absolute). */
  sitemaps: string[];
}

const PERMISSIVE: RobotsHandle = {
  isAllowed: () => true,
  crawlDelayMs: 0,
  sitemaps: [],
};

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Per-origin politeness gate. Ensures successive requests to the same origin
 * are spaced by at least `delayMs`. Returns a promise that resolves once the
 * caller may issue the next request.
 */
export class PolitenessGate {
  private readonly lastHit = new Map<string, number>();

  constructor(private readonly defaultDelayMs: number = 500) {}

  async wait(url: string, overrideDelayMs = 0): Promise<void> {
    const origin = safeOrigin(url);
    if (!origin) return;
    const delay = Math.max(overrideDelayMs, this.defaultDelayMs);
    const last = this.lastHit.get(origin) ?? 0;
    const wait = last + delay - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastHit.set(origin, Date.now());
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
