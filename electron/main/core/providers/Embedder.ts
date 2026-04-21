import type { ProviderConfig } from "../../../../shared/types";

/**
 * Embedding task. E5-family models (and most multilingual embedders) expect a
 * `query: ` / `passage: ` prefix depending on which side of retrieval is being
 * embedded. OpenAI-style remote endpoints ignore the task.
 */
export type EmbeddingTask = "query" | "passage";

export interface Embedder {
  readonly dimension: number;
  /**
   * Embed one or more texts.
   * @param task - defaults to `passage`. Use `query` for user queries.
   */
  embed(texts: string[], task?: EmbeddingTask): Promise<number[][]>;
  close?(): Promise<void>;
}

/**
 * Local embedder using @huggingface/transformers (transformers.js v3).
 * Loads a multilingual small embedding model once and reuses it.
 *
 * Applies the E5 `query: ` / `passage: ` prefix convention. Callers MUST pass
 * the correct task — e.g. user queries should use `"query"`, document/chunk
 * text should use `"passage"` (default).
 */
export class LocalEmbedder implements Embedder {
  private pipelinePromise: Promise<unknown> | null = null;
  readonly dimension = 384;
  private readonly modelId: string;

  constructor(modelId = "Xenova/multilingual-e5-small", private readonly cacheDir?: string) {
    this.modelId = modelId;
  }

  private async getPipeline(): Promise<unknown> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const tf = await import("@huggingface/transformers");
        if (this.cacheDir) {
          (tf as unknown as { env: { cacheDir: string } }).env.cacheDir = this.cacheDir;
        }
        return (tf as unknown as { pipeline: (task: string, model: string) => Promise<unknown> }).pipeline(
          "feature-extraction",
          this.modelId,
        );
      })();
    }
    return this.pipelinePromise;
  }

  async embed(texts: string[], task: EmbeddingTask = "passage"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipe = (await this.getPipeline()) as (
      input: string[],
      opts: { pooling: string; normalize: boolean },
    ) => Promise<{ data: Float32Array; dims: number[] }>;

    const prefix = task === "query" ? "query: " : "passage: ";
    const prefixed = texts.map((t) => `${prefix}${t}`);
    const out = await pipe(prefixed, { pooling: "mean", normalize: true });
    const dim = out.dims[out.dims.length - 1];
    const result: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      const slice = Array.from(out.data.slice(i * dim, (i + 1) * dim));
      result.push(slice);
    }
    return result;
  }
}

/**
 * Remote embedder calling an OpenAI-compatible /v1/embeddings endpoint.
 * OpenAI-style endpoints ignore the `task` parameter; it's accepted to keep the
 * Embedder interface uniform.
 */
export class RemoteEmbedder implements Embedder {
  readonly dimension: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    dimension = 1536,
  ) {
    this.dimension = dimension;
  }

  async embed(texts: string[], _task: EmbeddingTask = "passage"): Promise<number[][]> {
    if (texts.length === 0) return [];
    void _task;
    const url = this.baseUrl.replace(/\/$/, "") + "/embeddings";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Embeddings request failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
}

export function createEmbedder(provider: ProviderConfig | null, cacheDir?: string): Embedder {
  if (provider?.embeddingMode === "remote" && provider.embeddingModel && provider.embeddingApiKey && provider.embeddingBaseUrl) {
    return new RemoteEmbedder(
      provider.embeddingBaseUrl,
      provider.embeddingApiKey,
      provider.embeddingModel,
    );
  }
  return new LocalEmbedder("Xenova/multilingual-e5-small", cacheDir);
}
