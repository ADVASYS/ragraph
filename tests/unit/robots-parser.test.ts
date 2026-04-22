import { describe, it, expect } from "vitest";
import { PolitenessGate, RobotsRegistry, sleep } from "../../electron/main/core/ingestion/web/RobotsParser";

/**
 * Build a fake `fetch` that returns a synthetic robots.txt for whatever
 * origin it gets, letting us drive the parser deterministically.
 */
function makeFetch(body: string, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  })) as unknown as typeof fetch;
}

describe("RobotsRegistry", () => {
  it("disallows paths matched by Disallow rules", async () => {
    const body = `User-agent: *\nDisallow: /private/\nAllow: /private/public.html`;
    const reg = new RobotsRegistry("TestBot/1.0", makeFetch(body));
    const handle = await reg.get("https://example.com/anything");
    expect(handle.isAllowed("https://example.com/private/x")).toBe(false);
    expect(handle.isAllowed("https://example.com/private/public.html")).toBe(true);
    expect(handle.isAllowed("https://example.com/public")).toBe(true);
  });

  it("exposes sitemaps and crawl-delay", async () => {
    const body = [
      "User-agent: *",
      "Crawl-delay: 2",
      "Sitemap: https://example.com/sitemap.xml",
    ].join("\n");
    const reg = new RobotsRegistry("TestBot/1.0", makeFetch(body));
    const handle = await reg.get("https://example.com/");
    expect(handle.sitemaps).toContain("https://example.com/sitemap.xml");
    expect(handle.crawlDelayMs).toBe(2000);
  });

  it("falls back to permissive rules on network error", async () => {
    const reg = new RobotsRegistry("TestBot/1.0", (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    const handle = await reg.get("https://example.com/x");
    expect(handle.isAllowed("https://example.com/whatever")).toBe(true);
    expect(handle.crawlDelayMs).toBe(0);
    expect(handle.sitemaps).toEqual([]);
  });

  it("caches results per origin", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: true, status: 200, async text() { return ""; } };
    }) as unknown as typeof fetch;
    const reg = new RobotsRegistry("TestBot/1.0", fetchImpl);
    await reg.get("https://example.com/a");
    await reg.get("https://example.com/b");
    expect(calls).toBe(1);
  });
});

describe("PolitenessGate", () => {
  it("spaces consecutive calls to the same origin", async () => {
    const gate = new PolitenessGate(80);
    const t0 = Date.now();
    await gate.wait("https://example.com/a");
    await gate.wait("https://example.com/b");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(70);
  });

  it("does not delay requests to different origins", async () => {
    const gate = new PolitenessGate(150);
    await gate.wait("https://a.example/");
    const t0 = Date.now();
    await gate.wait("https://b.example/");
    expect(Date.now() - t0).toBeLessThan(80);
  });

  it("sleep resolves without throwing on zero or negative", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
    await expect(sleep(-10)).resolves.toBeUndefined();
  });
});
