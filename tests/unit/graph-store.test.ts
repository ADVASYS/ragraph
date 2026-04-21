import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `better-sqlite3` is a native module. In development it's built against the
// Electron ABI via `electron-builder install-app-deps`, so it cannot be loaded
// under plain Node. Detect this at file load time and skip the suite when
// running with a mismatched ABI. The tests can still be executed under the
// correct ABI via the npm `test:native` script.
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

let tempDir: string;
let store: InstanceType<NonNullable<typeof GraphStoreCtor>>;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "ragraph-test-"));
  store = new GraphStoreCtor!(join(tempDir, "graph.sqlite"));
  await store.whenReady();
});

afterEach(async () => {
  if (store) await store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe.skipIf(nativeLoadError)("GraphStore", () => {
  it("initializes an empty graph", async () => {
    const stats = await store.getStats();
    expect(stats).toEqual({ documents: 0, entities: 0, topics: 0, chunks: 0 });
    expect(await store.listDomains()).toEqual([]);
    expect(await store.listTopics()).toEqual([]);
  });

  it("writes an analysis and produces matching stats, summaries and listings", async () => {
    await store.writeAnalysis({
      documentId: "doc:1",
      fileId: "file:1",
      title: "RAG Overview",
      path: "/tmp/rag.md",
      mime: "text/markdown",
      summary: "Discusses retrieval augmented generation.",
      domain: "AI",
      topics: ["retrieval", "llm"],
      entities: [
        { name: "OpenAI", type: "ORG", description: null },
        { name: "RAG", type: "CONCEPT", description: "retrieval augmented generation" },
      ],
      keywords: ["rag", "embeddings"],
      references: [],
      chunks: [
        { id: "chunk:1", text: "intro paragraph", position: 0, vectorId: "v1" },
        { id: "chunk:2", text: "body paragraph", position: 1, vectorId: "v2" },
      ],
    });

    const stats = await store.getStats();
    expect(stats).toEqual({ documents: 1, entities: 2, topics: 2, chunks: 2 });

    const doc = await store.getDocumentSummary("doc:1");
    expect(doc).toMatchObject({
      id: "doc:1",
      title: "RAG Overview",
      summary: "Discusses retrieval augmented generation.",
      path: "/tmp/rag.md",
    });

    const chunk = await store.getChunk("chunk:1");
    expect(chunk).toMatchObject({
      id: "chunk:1",
      text: "intro paragraph",
      position: 0,
      documentId: "doc:1",
      documentTitle: "RAG Overview",
    });

    const topics = await store.listTopics();
    expect(topics.map((t) => t.name).sort()).toEqual(["llm", "retrieval"]);
    expect(topics.every((t) => t.count === 1)).toBe(true);

    const domains = await store.listDomains();
    expect(domains).toEqual([{ id: "dom:ai", name: "AI", count: 1 }]);

    const entities = await store.listEntities();
    expect(entities.map((e) => e.name).sort()).toEqual(["OpenAI", "RAG"]);
  });

  it("re-writing a document replaces its chunks and does not leak the old ones", async () => {
    const base = {
      documentId: "doc:1",
      fileId: "file:1",
      title: "Doc",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: "d",
      topics: ["t"],
      entities: [],
      keywords: [],
      references: [],
    };
    await store.writeAnalysis({
      ...base,
      chunks: [
        { id: "chunk:a", text: "a", position: 0, vectorId: null },
        { id: "chunk:b", text: "b", position: 1, vectorId: null },
      ],
    });
    expect((await store.getStats()).chunks).toBe(2);

    await store.writeAnalysis({
      ...base,
      chunks: [{ id: "chunk:c", text: "c", position: 0, vectorId: null }],
    });
    const stats = await store.getStats();
    expect(stats.chunks).toBe(1);
    expect(await store.getChunk("chunk:a")).toBeNull();
    expect(await store.getChunk("chunk:c")).not.toBeNull();
  });

  it("removes a document and cascades to its chunks", async () => {
    await store.writeAnalysis({
      documentId: "doc:rm",
      fileId: "file:rm",
      title: "Temp",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: [],
      entities: [],
      keywords: [],
      references: [],
      chunks: [{ id: "chunk:rm", text: "x", position: 0, vectorId: null }],
    });
    expect((await store.getStats()).documents).toBe(1);

    await store.removeDocument("doc:rm");
    const stats = await store.getStats();
    expect(stats.documents).toBe(0);
    expect(stats.chunks).toBe(0);
    expect(await store.getChunk("chunk:rm")).toBeNull();
  });

  it("returns a connected neighborhood snapshot", async () => {
    await store.writeAnalysis({
      documentId: "doc:1",
      fileId: "file:1",
      title: "D1",
      path: "/1",
      mime: "text/plain",
      summary: "s",
      domain: "AI",
      topics: ["x"],
      entities: [{ name: "X", type: "CONCEPT" }],
      keywords: [],
      references: [],
      chunks: [],
    });
    const snap = await store.neighborhood("doc:1", 1);
    const ids = snap.nodes.map((n) => n.id);
    expect(ids).toContain("doc:1");
    expect(ids).toContain("dom:ai");
    expect(ids).toContain("top:x");
    expect(ids).toContain("ent:concept:x");
    expect(snap.edges.length).toBeGreaterThanOrEqual(3);
  });

  it("writes typed RELATED, PART_OF edges from analyzer relations", async () => {
    await store.writeAnalysis({
      documentId: "doc:rel",
      fileId: "file:rel",
      title: "Relations",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: [
        { name: "Neural Networks", description: "" },
        { name: "Deep Learning", description: "" },
      ],
      entities: [
        { name: "OpenAI", type: "ORG", description: "" },
        { name: "GPT", type: "MODEL", description: "" },
      ],
      keywords: [],
      references: [],
      chunks: [],
      relations: [
        { srcName: "OpenAI", dstName: "GPT", kind: "related", predicate: "builds", note: "" },
        { srcName: "Neural Networks", dstName: "Deep Learning", kind: "part_of" },
      ],
    });
    const snap = await store.neighborhood("ent:org:openai", 1);
    const relatedEdge = snap.edges.find((e) => e.label === "RELATED");
    expect(relatedEdge).toBeDefined();
    expect((relatedEdge?.properties as { predicate?: string }).predicate).toBe("builds");

    const topicSnap = await store.neighborhood("top:neural_networks", 1);
    expect(topicSnap.edges.some((e) => e.label === "PART_OF")).toBe(true);

    const triples = await store.entityTriples("ent:org:openai", 5);
    expect(triples.some((t) => t.predicate === "builds" && t.otherId === "ent:model:gpt")).toBe(true);
  });

  it("falls back to 'related_to' when predicate missing and normalizes free-form predicates", async () => {
    await store.writeAnalysis({
      documentId: "doc:rel2",
      fileId: "file:rel2",
      title: "r",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: [],
      entities: [
        { name: "Alice", type: "PERSON" },
        { name: "Acme", type: "ORG" },
        { name: "Bob", type: "PERSON" },
      ],
      keywords: [],
      references: [],
      chunks: [],
      relations: [
        { srcName: "Alice", dstName: "Acme", kind: "related" },
        { srcName: "Bob", dstName: "Acme", kind: "related", predicate: "Works At!" },
      ],
    });
    const triples = await store.entityTriples("ent:person:alice", 5);
    expect(triples.find((t) => t.otherId === "ent:org:acme")?.predicate).toBe("related_to");
    const triples2 = await store.entityTriples("ent:person:bob", 5);
    expect(triples2.find((t) => t.otherId === "ent:org:acme")?.predicate).toBe("works_at");
  });

  it("creates Chunk→Entity MENTIONS edges when entity surfaces appear in chunk text", async () => {
    await store.writeAnalysis({
      documentId: "doc:mc",
      fileId: "file:mc",
      title: "Mentions",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: [],
      entities: [
        { name: "OpenAI", type: "ORG", aliases: ["Open AI"] },
        { name: "GPT", type: "MODEL" },
      ],
      keywords: [],
      references: [],
      chunks: [
        { id: "chunk:mc:0", text: "OpenAI released the new GPT model yesterday.", position: 0, vectorId: null },
        { id: "chunk:mc:1", text: "The market response was positive.", position: 1, vectorId: null },
        { id: "chunk:mc:2", text: "Open AI also announced a research preview.", position: 2, vectorId: null },
      ],
    });
    const mentions = await store.chunksMentioningEntity("ent:org:openai", 10);
    const byChunk = new Map(mentions.map((m) => [m.chunkId, m]));
    expect(byChunk.has("chunk:mc:0")).toBe(true);
    expect(byChunk.has("chunk:mc:2")).toBe(true);
    expect(byChunk.has("chunk:mc:1")).toBe(false);

    const docsForEntity = await store.documentsForEntity("ent:org:openai", 5);
    expect(docsForEntity[0].documentId).toBe("doc:mc");
    expect(docsForEntity[0].count).toBeGreaterThanOrEqual(1);
  });

  it("describeNodes hydrates ids with labels and types for path narratives", async () => {
    await store.writeAnalysis({
      documentId: "doc:dn",
      fileId: "file:dn",
      title: "Describe Nodes",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: [{ name: "Alpha", description: "" }],
      entities: [{ name: "Nova", type: "CONCEPT" }],
      keywords: [],
      references: [],
      chunks: [],
    });
    const described = await store.describeNodes(["doc:dn", "top:alpha", "ent:concept:nova"]);
    expect(described[0]).toMatchObject({ id: "doc:dn", type: "Document", label: "Describe Nodes" });
    expect(described[1]).toMatchObject({ id: "top:alpha", type: "Topic", label: "Alpha" });
    expect(described[2]).toMatchObject({ id: "ent:concept:nova", type: "Entity", label: "Nova" });
  });

  it("neighborhood filter excludes CONTAINS/TAGGED when requested", async () => {
    await store.writeAnalysis({
      documentId: "doc:nf",
      fileId: "file:nf",
      title: "NF",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: "AI",
      topics: ["t"],
      entities: [],
      keywords: ["alpha", "beta"],
      references: [],
      chunks: [{ id: "chunk:nf:0", text: "hello", position: 0, vectorId: null }],
    });
    const full = await store.neighborhood("doc:nf", 1);
    const filtered = await store.neighborhood("doc:nf", 1, { excludeRels: ["CONTAINS", "TAGGED"] });
    expect(full.edges.some((e) => e.label === "CONTAINS")).toBe(true);
    expect(filtered.edges.some((e) => e.label === "CONTAINS")).toBe(false);
    expect(filtered.edges.some((e) => e.label === "TAGGED")).toBe(false);
    expect(filtered.edges.some((e) => e.label === "ABOUT")).toBe(true);
  });

  it("FTS search returns seeded chunks and sanitizes operators", async () => {
    await store.writeAnalysis({
      documentId: "doc:fts",
      fileId: "file:fts",
      title: "Vector Search Primer",
      path: "/p",
      mime: "text/plain",
      summary: "Vector databases, BM25 and hybrid retrieval.",
      domain: null,
      topics: [],
      entities: [],
      keywords: [],
      references: [],
      chunks: [
        { id: "chunk:f1", text: "Reciprocal rank fusion merges BM25 and vector ranks.", position: 0, vectorId: null },
        { id: "chunk:f2", text: "LanceDB stores embeddings.", position: 1, vectorId: null },
      ],
    });

    const hits = await store.ftsSearch("reciprocal rank", 10, ["chunk"]);
    expect(hits.some((h) => h.sourceId === "chunk:f1")).toBe(true);

    const quirky = await store.ftsSearch("foo* AND (bar", 10);
    expect(Array.isArray(quirky)).toBe(true);
  });

  it("recomputes normalized degree centrality", async () => {
    await store.writeAnalysis({
      documentId: "doc:c1",
      fileId: "f1",
      title: "One",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: ["t1"],
      entities: [{ name: "Shared", type: "CONCEPT" }],
      keywords: [],
      references: [],
      chunks: [],
    });
    await store.writeAnalysis({
      documentId: "doc:c2",
      fileId: "f2",
      title: "Two",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: ["t1"],
      entities: [{ name: "Shared", type: "CONCEPT" }],
      keywords: [],
      references: [],
      chunks: [],
    });
    await store.recomputeCentrality();
    const node = await store.getNode("ent:concept:shared");
    expect(typeof (node?.props as { centrality?: number }).centrality).toBe("number");
    expect((node!.props as { centrality: number }).centrality).toBeGreaterThan(0);
  });

  it("merges two nodes, rewrites edges and preserves FTS row", async () => {
    await store.writeAnalysis({
      documentId: "doc:m",
      fileId: "fm",
      title: "Merge",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: [],
      entities: [
        { name: "Alpha Inc", type: "ORG" },
        { name: "Alpha Incorporated", type: "ORG" },
      ],
      keywords: [],
      references: [],
      chunks: [],
    });
    await store.mergeNode("ent:org:alpha_incorporated", "ent:org:alpha_inc");
    expect(await store.getNode("ent:org:alpha_incorporated")).toBeNull();
    const snap = await store.neighborhood("ent:org:alpha_inc", 1);
    expect(snap.nodes.some((n) => n.id === "doc:m")).toBe(true);
  });

  it("findPath returns a short BFS path and null when disconnected", async () => {
    await store.writeAnalysis({
      documentId: "doc:p1",
      fileId: "fp1",
      title: "P1",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: ["tp"],
      entities: [],
      keywords: [],
      references: [],
      chunks: [],
    });
    await store.writeAnalysis({
      documentId: "doc:p2",
      fileId: "fp2",
      title: "P2",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: ["tp"],
      entities: [],
      keywords: [],
      references: [],
      chunks: [],
    });
    const path = await store.findPath("doc:p1", "doc:p2", 3);
    expect(path).not.toBeNull();
    expect(path!.nodes[0]).toBe("doc:p1");
    expect(path!.nodes[path!.nodes.length - 1]).toBe("doc:p2");

    const none = await store.findPath("doc:p1", "doc:does-not-exist", 3);
    expect(none).toBeNull();
  });

  it("relatedDocuments ranks by shared entities and topics", async () => {
    const mk = (id: string, ents: string[], topics: string[]) =>
      store.writeAnalysis({
        documentId: id,
        fileId: id,
        title: id,
        path: "/p",
        mime: "text/plain",
        summary: "s",
        domain: null,
        topics,
        entities: ents.map((n) => ({ name: n, type: "CONCEPT" })),
        keywords: [],
        references: [],
        chunks: [],
      });
    await mk("doc:r1", ["A", "B"], ["t"]);
    await mk("doc:r2", ["A", "B"], ["t"]);
    await mk("doc:r3", ["C"], ["other"]);

    const related = await store.relatedDocuments("doc:r1", "all", 5);
    expect(related.some((r) => r.id === "doc:r2")).toBe(true);
    const r2 = related.find((r) => r.id === "doc:r2");
    const r3 = related.find((r) => r.id === "doc:r3");
    expect((r2?.score ?? 0)).toBeGreaterThan(r3?.score ?? 0);
  });

  it("saves and removes agent notes without touching other documents", async () => {
    await store.writeAnalysis({
      documentId: "doc:linked",
      fileId: "file:1",
      title: "Linked",
      path: "/p",
      mime: "text/plain",
      summary: "s",
      domain: null,
      topics: [],
      entities: [],
      keywords: [],
      references: [],
      chunks: [],
    });
    await store.saveAgentNote("note:1", "useful insight", "because", ["doc:linked"]);

    const snap = await store.neighborhood("note:1", 1);
    expect(snap.nodes.some((n) => n.id === "note:1")).toBe(true);
    expect(snap.nodes.some((n) => n.id === "doc:linked")).toBe(true);

    await store.removeAgentNote("note:1");
    const after = await store.neighborhood("note:1", 1);
    expect(after.nodes).toEqual([]);
  });
});
