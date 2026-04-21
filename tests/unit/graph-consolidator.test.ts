import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphConsolidator, type ConsolidationProgress } from "../../electron/main/core/knowledge/GraphConsolidator";
import type { VectorStore, VectorRecord } from "../../electron/main/core/storage/VectorStore";

let GraphStoreCtor: typeof import("../../electron/main/core/storage/GraphStore").GraphStore | null = null;
let nativeLoadError: Error | null = null;
try {
  const mod = await import("../../electron/main/core/storage/GraphStore");
  GraphStoreCtor = mod.GraphStore;
  const probe = new mod.GraphStore(join(mkdtempSync(join(tmpdir(), "ragraph-probe-")), "probe.sqlite"));
  await probe.close();
} catch (err) {
  nativeLoadError = err as Error;
}

class MockVectorStore {
  public store = new Map<string, VectorRecord>();
  setEntity(sourceId: string, vector: number[], type: string) {
    this.store.set(sourceId, {
      id: `vec_entity_${sourceId}`,
      kind: "entity",
      source_id: sourceId,
      universe_id: "uni",
      title: sourceId,
      text: "",
      vector,
      keywords: [],
      domain: type,
      topics: [],
      graph_node_id: sourceId,
      file_id: "",
      created_at: 1,
    });
  }
  setTopic(sourceId: string, vector: number[]) {
    this.store.set(sourceId, {
      id: `vec_topic_${sourceId}`,
      kind: "topic",
      source_id: sourceId,
      universe_id: "uni",
      title: sourceId,
      text: "",
      vector,
      keywords: [],
      domain: "",
      topics: [],
      graph_node_id: sourceId,
      file_id: "",
      created_at: 1,
    });
  }
  async getBySourceIds(ids: string[]): Promise<Map<string, VectorRecord>> {
    const out = new Map<string, VectorRecord>();
    for (const id of ids) {
      const rec = this.store.get(id);
      if (rec) out.set(id, rec);
    }
    return out;
  }
  async rewriteSourceId(oldId: string, newId: string): Promise<number> {
    const rec = this.store.get(oldId);
    if (!rec) return 0;
    this.store.delete(oldId);
    this.store.set(newId, { ...rec, source_id: newId, graph_node_id: newId });
    return 1;
  }
}

let tempDir: string;
let store: InstanceType<NonNullable<typeof GraphStoreCtor>>;
let vectors: MockVectorStore;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "ragraph-consol-"));
  store = new GraphStoreCtor!(join(tempDir, "graph.sqlite"));
  await store.whenReady();
  vectors = new MockVectorStore();
});

afterEach(async () => {
  if (store) await store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe.skipIf(nativeLoadError)("GraphConsolidator", () => {
  it("merges near-duplicate entities of the same type", async () => {
    await store.writeAnalysis({
      documentId: "doc:c1",
      fileId: "f1",
      title: "One",
      path: "/p",
      mime: "text/plain",
      summary: "",
      domain: null,
      topics: [],
      entities: [
        { name: "Acme Corp", type: "ORG" },
        { name: "Acme Corporation", type: "ORG" },
      ],
      keywords: [],
      references: [],
      chunks: [],
    });
    // Supply almost-identical vectors for the two entities.
    vectors.setEntity("ent:org:acme_corp", [1, 0, 0], "ORG");
    vectors.setEntity("ent:org:acme_corporation", [0.98, 0.19, 0], "ORG");

    const consolidator = new GraphConsolidator(store, vectors as unknown as VectorStore, {
      entityMergeThreshold: 0.9,
      topicMergeThreshold: 0.99,
    });
    const progress: ConsolidationProgress[] = [];
    await consolidator.run("uni", (p) => progress.push(p));

    const survivors = await store.listEntities(100);
    const names = survivors.map((e) => e.name);
    expect(names).toContain("Acme Corp");
    expect(names.length).toBe(1);
    expect(progress[progress.length - 1].phase).toBe("done");
  });

  it("does NOT merge entities below the threshold", async () => {
    await store.writeAnalysis({
      documentId: "doc:nom",
      fileId: "fn",
      title: "Not merge",
      path: "/p",
      mime: "text/plain",
      summary: "",
      domain: null,
      topics: [],
      entities: [
        { name: "Apple Inc", type: "ORG" },
        { name: "Microsoft Corp", type: "ORG" },
      ],
      keywords: [],
      references: [],
      chunks: [],
    });
    vectors.setEntity("ent:org:apple_inc", [1, 0, 0], "ORG");
    vectors.setEntity("ent:org:microsoft_corp", [0, 1, 0], "ORG");

    const consolidator = new GraphConsolidator(store, vectors as unknown as VectorStore, {
      entityMergeThreshold: 0.95,
      topicMergeThreshold: 0.99,
    });
    await consolidator.run("uni");
    const survivors = await store.listEntities(100);
    expect(survivors.length).toBe(2);
  });

  it("creates PART_OF edges between similar topics without merging them", async () => {
    await store.writeAnalysis({
      documentId: "doc:tc",
      fileId: "ft",
      title: "Topics",
      path: "/p",
      mime: "text/plain",
      summary: "",
      domain: null,
      topics: ["deep learning", "machine learning"],
      entities: [],
      keywords: [],
      references: [],
      chunks: [],
    });
    vectors.setTopic("top:deep_learning", [1, 0, 0]);
    vectors.setTopic("top:machine_learning", [0.95, 0.3, 0]);

    const consolidator = new GraphConsolidator(store, vectors as unknown as VectorStore, {
      topicMergeThreshold: 0.85,
    });
    await consolidator.run("uni");

    const all = await store.listAllTopics();
    expect(all.length).toBe(2);
    const a = await store.neighborhood("top:deep_learning", 1);
    const b = await store.neighborhood("top:machine_learning", 1);
    const allEdges = [...a.edges, ...b.edges];
    expect(allEdges.some((e) => e.label === "PART_OF")).toBe(true);
  });

  it("links documents with enough shared entities via SIMILAR_TO", async () => {
    const mk = (id: string, ents: string[]) =>
      store.writeAnalysis({
        documentId: id,
        fileId: id,
        title: id,
        path: "/p",
        mime: "text/plain",
        summary: "",
        domain: null,
        topics: [],
        entities: ents.map((n) => ({ name: n, type: "CONCEPT" })),
        keywords: [],
        references: [],
        chunks: [],
      });
    await mk("doc:s1", ["A", "B", "C"]);
    await mk("doc:s2", ["A", "B", "C"]);

    const consolidator = new GraphConsolidator(store, vectors as unknown as VectorStore, {
      entityMergeThreshold: 0.99,
      topicMergeThreshold: 0.99,
      similarDocMinEntityOverlap: 2,
    });
    await consolidator.run("uni");

    const snap = await store.neighborhood("doc:s1", 1);
    expect(snap.edges.some((e) => e.label === "SIMILAR_TO")).toBe(true);
  });

  it("aborts cleanly when the signal is already aborted", async () => {
    await store.writeAnalysis({
      documentId: "doc:ab",
      fileId: "fab",
      title: "A",
      path: "/p",
      mime: "text/plain",
      summary: "",
      domain: null,
      topics: [],
      entities: [{ name: "X", type: "ORG" }, { name: "Y", type: "ORG" }],
      keywords: [],
      references: [],
      chunks: [],
    });
    vectors.setEntity("ent:org:x", [1, 0, 0], "ORG");
    vectors.setEntity("ent:org:y", [0.99, 0.1, 0], "ORG");
    const consolidator = new GraphConsolidator(store, vectors as unknown as VectorStore);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(consolidator.run("uni", undefined, ctrl.signal)).rejects.toThrow(/abort/i);
  });
});
