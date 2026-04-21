import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RemoteEmbedder } from "../../electron/main/core/providers/Embedder";

describe("RemoteEmbedder", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls the /embeddings endpoint and returns vectors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
      text: async () => "",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const emb = new RemoteEmbedder("https://api.example.com/v1/", "sk-test", "text-embed", 2);
    const out = await emb.embed(["hello", "world"], "query");

    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/embeddings");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ model: "text-embed", input: ["hello", "world"] });
  });

  it("returns [] for empty input without hitting the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const emb = new RemoteEmbedder("https://api.example.com/v1", "sk", "m", 2);
    expect(await emb.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a helpful error on non-2xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    }) as unknown as typeof fetch;
    const emb = new RemoteEmbedder("https://api.example.com/v1", "sk", "m", 2);
    await expect(emb.embed(["x"])).rejects.toThrow(/500/);
  });
});
