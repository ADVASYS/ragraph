import { describe, it, expect } from "vitest";
import { EntityResolver } from "../../electron/main/core/knowledge/EntityResolver";
import type { GraphStore } from "../../electron/main/core/storage/GraphStore";
import type { VectorStore, VectorRecord, VectorSearchHit } from "../../electron/main/core/storage/VectorStore";
import type { Embedder } from "../../electron/main/core/providers/Embedder";

function makeEmbedder(map: Record<string, number[]>): Embedder {
  return {
    dimension: 3,
    embed: async (texts: string[]) => texts.map((t) => map[t] ?? [0, 0, 0]),
    warm: async () => {},
    dispose: async () => {},
  } as unknown as Embedder;
}

function makeGraph(): GraphStore {
  return { upsertNodeFts: async () => {} } as unknown as GraphStore;
}

interface MockStoreState {
  records: Map<string, VectorRecord>;
}

function makeVectorStore(state: MockStoreState): VectorStore {
  const cosine = (a: number[], b: number[]) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
  };
  return {
    search: async (vec: number[], topK: number, filter?: { kind?: string; entityType?: string }) => {
      const hits: VectorSearchHit[] = [];
      for (const r of state.records.values()) {
        if (filter?.kind && r.kind !== filter.kind) continue;
        if (filter?.entityType && r.domain !== filter.entityType) continue;
        hits.push({ ...(r as unknown as VectorSearchHit), score: cosine(vec, r.vector) });
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, topK);
    },
  } as unknown as VectorStore;
}

describe("EntityResolver", () => {
  it("creates a fresh entity when nothing similar exists", async () => {
    const state: MockStoreState = { records: new Map() };
    const resolver = new EntityResolver(
      makeGraph(),
      makeVectorStore(state),
      makeEmbedder({ "ORG: Acme.": [1, 0, 0] }),
      "uni-1",
      { entityMergeThreshold: 0.95 },
    );
    const out = await resolver.resolve([{ name: "Acme", type: "ORG" }], []);
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0].merged).toBe(false);
    expect(out.entities[0].id).toBe("ent:org:acme");
    expect(out.newVectorRecords).toHaveLength(1);
  });

  it("merges similar entities of the same type by cosine similarity", async () => {
    const state: MockStoreState = {
      records: new Map([
        [
          "ent:org:acme_corp",
          {
            id: "vec_entity_ent:org:acme_corp",
            kind: "entity",
            source_id: "ent:org:acme_corp",
            universe_id: "uni-1",
            title: "Acme Corp",
            text: "A company",
            vector: [1, 0, 0],
            keywords: ["Acme Corp"],
            domain: "ORG",
            topics: [],
            graph_node_id: "ent:org:acme_corp",
            file_id: "",
            created_at: 1,
          } as VectorRecord,
        ],
      ]),
    };
    const resolver = new EntityResolver(
      makeGraph(),
      makeVectorStore(state),
      makeEmbedder({ "ORG: Acme Incorporated.": [0.99, 0.01, 0] }),
      "uni-1",
      { entityMergeThreshold: 0.9 },
    );
    const out = await resolver.resolve([{ name: "Acme Incorporated", type: "ORG" }], []);
    expect(out.entities[0].merged).toBe(true);
    expect(out.entities[0].id).toBe("ent:org:acme_corp");
    expect(out.entities[0].aliases).toEqual(expect.arrayContaining(["Acme Incorporated", "Acme Corp"]));
    expect(out.updatedVectorRecords).toHaveLength(1);
    expect(out.newVectorRecords).toHaveLength(0);
  });

  it("does not cross entity types when merging", async () => {
    const state: MockStoreState = {
      records: new Map([
        [
          "ent:person:acme",
          {
            id: "vec_entity_ent:person:acme",
            kind: "entity",
            source_id: "ent:person:acme",
            universe_id: "uni-1",
            title: "Acme (person)",
            text: "",
            vector: [1, 0, 0],
            keywords: [],
            domain: "PERSON",
            topics: [],
            graph_node_id: "ent:person:acme",
            file_id: "",
            created_at: 1,
          } as VectorRecord,
        ],
      ]),
    };
    const resolver = new EntityResolver(
      makeGraph(),
      makeVectorStore(state),
      makeEmbedder({ "ORG: Acme.": [1, 0, 0] }),
      "uni-1",
      { entityMergeThreshold: 0.5 },
    );
    const out = await resolver.resolve([{ name: "Acme", type: "ORG" }], []);
    expect(out.entities[0].merged).toBe(false);
    expect(out.entities[0].id).toBe("ent:org:acme");
  });

  it("merges topics above threshold and keeps them otherwise", async () => {
    const state: MockStoreState = {
      records: new Map([
        [
          "top:deep_learning",
          {
            id: "vec_topic_top:deep_learning",
            kind: "topic",
            source_id: "top:deep_learning",
            universe_id: "uni-1",
            title: "Deep Learning",
            text: "",
            vector: [0, 1, 0],
            keywords: [],
            domain: "",
            topics: [],
            graph_node_id: "top:deep_learning",
            file_id: "",
            created_at: 1,
          } as VectorRecord,
        ],
      ]),
    };
    const resolver = new EntityResolver(
      makeGraph(),
      makeVectorStore(state),
      makeEmbedder({
        "neural nets. ": [0, 0.99, 0.01],
        "recipes. ": [1, 0, 0],
      }),
      "uni-1",
      { topicMergeThreshold: 0.8 },
    );
    const out = await resolver.resolve([], [{ name: "neural nets" }, { name: "recipes" }]);
    const merged = out.topics.find((t) => t.id === "top:deep_learning");
    const fresh = out.topics.find((t) => t.name === "recipes");
    expect(merged?.merged).toBe(true);
    expect(fresh?.merged).toBe(false);
  });
});
