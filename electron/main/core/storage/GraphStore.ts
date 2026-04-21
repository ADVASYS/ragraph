import Database from "better-sqlite3";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { GraphEdgeDTO, GraphNodeDTO, GraphSnapshot } from "../../../../shared/types";

/**
 * Per-universe property-graph store backed by SQLite (better-sqlite3).
 *
 * Uses a generic node/edge model with JSON property blobs:
 *   nodes(id PK, type, props_json)
 *   edges(id PK autoincrement, rel, src FK, dst FK, props_json, UNIQUE(rel, src, dst))
 *
 * A contentless FTS5 virtual table `nodes_fts` mirrors searchable text for
 * Chunk / Document summaries / Entity / Topic nodes. The FTS rowid is the
 * `rowid` of a companion shadow table `fts_refs(rowid, source_id)` so we can
 * map back to graph nodes after matching.
 *
 * All public methods are asynchronous to keep call sites compatible with the
 * earlier Kuzu-backed implementation, even though the underlying
 * better-sqlite3 calls are synchronous.
 */

export type GraphNodeType = "Document" | "Entity" | "Topic" | "Domain" | "Keyword" | "Chunk" | "AgentNote";

type NodePropsMap = {
  Document: { file_id: string; title: string; path: string; mime: string; summary: string; created_at: number };
  Entity: { name: string; type: string; description: string; aliases?: string[]; centrality?: number };
  Topic: { name: string; description: string; centrality?: number };
  Domain: { name: string };
  Keyword: { term: string };
  Chunk: {
    text: string;
    position: number;
    vector_id: string;
    heading?: string[];
    /** Inclusive char offset of this chunk's own content in the normalized source text. */
    start_offset?: number;
    /** Exclusive char offset of this chunk's own content in the normalized source text. */
    end_offset?: number;
    /** 1-based first page for paged formats (PDF). */
    page_start?: number;
    /** 1-based last page for paged formats (PDF). */
    page_end?: number;
  };
  AgentNote: { content: string; reason: string; created_at: number };
};

export interface EntityInput {
  /** Canonical id from EntityResolver; when absent, a new one is derived from name+type. */
  id?: string;
  name: string;
  type: string;
  description?: string | null;
  /** Accumulated alternative surface forms, merged into props.aliases. */
  aliases?: string[];
}

export interface TopicInput {
  id?: string;
  name: string;
  description?: string | null;
}

export interface RelationInput {
  srcName: string;
  dstName: string;
  kind: "related" | "part_of";
  /** For `related`: verb-phrase predicate (e.g. `works_at`). Defaults to `related_to`. */
  predicate?: string;
  note?: string;
}

export interface AnalysisWriteInput {
  documentId: string;
  fileId: string;
  title: string;
  path: string;
  mime: string;
  summary: string;
  domain: string | null;
  topics: TopicInput[] | string[];
  entities: EntityInput[];
  keywords: string[];
  references: string[];
  chunks: {
    id: string;
    text: string;
    position: number;
    vectorId: string | null;
    heading?: string[];
    startOffset?: number;
    endOffset?: number;
    pageStart?: number;
    pageEnd?: number;
  }[];
  relations?: RelationInput[];
}

export interface FtsHit {
  sourceId: string;
  kind: string;
  fileId: string;
  graphNodeId: string;
  title: string;
  text: string;
  score: number;
}

export interface NodeRecord<T extends GraphNodeType = GraphNodeType> {
  id: string;
  type: T;
  props: NodePropsMap[T];
}

export interface EdgeRecord {
  id: number;
  rel: string;
  src: string;
  dst: string;
  props: Record<string, unknown>;
}

export class GraphStore {
  public readonly db: BetterSqliteDatabase;
  private ready: Promise<void>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.ready = Promise.resolve(this.initSchema());
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        props_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rel TEXT NOT NULL,
        src TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        dst TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        props_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(rel, src, dst)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src, rel);
      CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst, rel);
      CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(rel);

      -- FTS5 virtual table for lexical search (BM25).
      -- Contentless table: we manage rows ourselves (safer than content= mode for
      -- a JSON-blob base table). Unindexed columns are metadata for cheap
      -- re-hydration without follow-up JOINs.
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        source_id UNINDEXED,
        kind UNINDEXED,
        file_id UNINDEXED,
        graph_node_id UNINDEXED,
        title,
        text,
        tokenize = 'unicode61 remove_diacritics 2 tokenchars ''_-.'''
      );

      -- Shadow table so we can dedupe by source_id and regenerate FTS rows
      -- after merges/moves without scanning the FTS itself.
      CREATE TABLE IF NOT EXISTS fts_refs (
        rowid INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fts_refs_source ON fts_refs(source_id);
      CREATE INDEX IF NOT EXISTS idx_fts_refs_kind ON fts_refs(kind);
    `);
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  private slug(s: string): string {
    return s.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 128) || "_";
  }

  private upsertNode<T extends GraphNodeType>(id: string, type: T, props: NodePropsMap[T]): void {
    const row = this.db.prepare("SELECT type, props_json FROM nodes WHERE id = ?").get(id) as
      | { type: string; props_json: string }
      | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO nodes (id, type, props_json) VALUES (?, ?, ?)")
        .run(id, type, JSON.stringify(props));
    } else {
      const existing = JSON.parse(row.props_json || "{}") as Record<string, unknown>;
      const incoming = props as unknown as Record<string, unknown>;
      // Merge aliases arrays without duplicates when both sides carry them.
      if (Array.isArray(existing["aliases"]) || Array.isArray(incoming["aliases"])) {
        const merged = new Set<string>([
          ...(Array.isArray(existing["aliases"]) ? (existing["aliases"] as string[]) : []),
          ...(Array.isArray(incoming["aliases"]) ? (incoming["aliases"] as string[]) : []),
        ]);
        incoming["aliases"] = Array.from(merged).slice(0, 20);
      }
      const merged = { ...existing, ...incoming };
      this.db.prepare("UPDATE nodes SET type = ?, props_json = ? WHERE id = ?").run(type, JSON.stringify(merged), id);
    }
  }

  private addEdge(rel: string, src: string, dst: string, props: Record<string, unknown> = {}): void {
    const existing = this.db
      .prepare("SELECT props_json FROM edges WHERE rel = ? AND src = ? AND dst = ?")
      .get(rel, src, dst) as { props_json: string } | undefined;
    if (!existing) {
      this.db
        .prepare("INSERT INTO edges (rel, src, dst, props_json) VALUES (?, ?, ?, ?)")
        .run(rel, src, dst, JSON.stringify(props));
      return;
    }
    const prev = JSON.parse(existing.props_json || "{}") as Record<string, unknown>;
    const nextProps: Record<string, unknown> = { ...prev, ...props };
    // Counter-style props: if both sides carry a numeric `count`, sum; otherwise
    // increment when an addEdge is called repeatedly for the same (rel,src,dst).
    if (typeof prev["count"] === "number" || typeof props["count"] === "number") {
      nextProps["count"] = Number(prev["count"] ?? 0) + Number(props["count"] ?? 1);
    }
    this.db
      .prepare("UPDATE edges SET props_json = ? WHERE rel = ? AND src = ? AND dst = ?")
      .run(JSON.stringify(nextProps), rel, src, dst);
  }

  /**
   * Insert or replace an FTS row for a given source_id. Kept in sync with
   * node writes during writeAnalysis and agent-note persistence.
   */
  private upsertFtsRow(params: {
    sourceId: string;
    kind: string;
    title: string;
    text: string;
    fileId?: string;
    graphNodeId?: string;
  }): void {
    const existing = this.db
      .prepare("SELECT rowid FROM fts_refs WHERE source_id = ?")
      .get(params.sourceId) as { rowid: number } | undefined;
    if (existing) {
      this.db.prepare("DELETE FROM nodes_fts WHERE rowid = ?").run(existing.rowid);
      this.db
        .prepare(
          "INSERT INTO nodes_fts(rowid, source_id, kind, file_id, graph_node_id, title, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          existing.rowid,
          params.sourceId,
          params.kind,
          params.fileId ?? "",
          params.graphNodeId ?? params.sourceId,
          params.title,
          params.text,
        );
      this.db.prepare("UPDATE fts_refs SET kind = ? WHERE rowid = ?").run(params.kind, existing.rowid);
      return;
    }
    const info = this.db
      .prepare("INSERT INTO fts_refs (source_id, kind) VALUES (?, ?)")
      .run(params.sourceId, params.kind);
    this.db
      .prepare(
        "INSERT INTO nodes_fts(rowid, source_id, kind, file_id, graph_node_id, title, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        Number(info.lastInsertRowid),
        params.sourceId,
        params.kind,
        params.fileId ?? "",
        params.graphNodeId ?? params.sourceId,
        params.title,
        params.text,
      );
  }

  private deleteFtsBySourceId(sourceId: string): void {
    const row = this.db.prepare("SELECT rowid FROM fts_refs WHERE source_id = ?").get(sourceId) as
      | { rowid: number }
      | undefined;
    if (!row) return;
    this.db.prepare("DELETE FROM nodes_fts WHERE rowid = ?").run(row.rowid);
    this.db.prepare("DELETE FROM fts_refs WHERE rowid = ?").run(row.rowid);
  }

  private deleteFtsForDocument(documentId: string, chunkIds: string[]): void {
    this.deleteFtsBySourceId(documentId);
    for (const cid of chunkIds) this.deleteFtsBySourceId(cid);
  }

  async removeDocument(documentId: string): Promise<void> {
    await this.ready;
    const chunkRows = this.db
      .prepare(`SELECT dst AS id FROM edges WHERE rel = 'CONTAINS' AND src = ?`)
      .all(documentId) as { id: string }[];
    const chunkIds = chunkRows.map((r) => r.id);
    const tx = this.db.transaction((docId: string, ids: string[]) => {
      this.deleteFtsForDocument(docId, ids);
      for (const cid of ids) {
        this.db.prepare("DELETE FROM nodes WHERE id = ?").run(cid);
      }
      this.db.prepare("DELETE FROM nodes WHERE id = ?").run(docId);
    });
    tx(documentId, chunkIds);
  }

  /**
   * Persist the analyzer output. `entities` and `topics` are expected to be
   * already resolved (canonical ids) by the EntityResolver; a string[] topics
   * input is still accepted for backward compatibility.
   */
  async writeAnalysis(input: AnalysisWriteInput): Promise<void> {
    await this.ready;
    await this.removeDocument(input.documentId);

    const topicsNormalized: TopicInput[] = (input.topics as Array<string | TopicInput>).map((t) =>
      typeof t === "string" ? { name: t, description: "" } : t,
    );

    const tx = this.db.transaction((inp: AnalysisWriteInput) => {
      this.upsertNode(inp.documentId, "Document", {
        file_id: inp.fileId,
        title: inp.title,
        path: inp.path,
        mime: inp.mime,
        summary: inp.summary,
        created_at: Date.now(),
      });
      this.upsertFtsRow({
        sourceId: inp.documentId,
        kind: "doc_summary",
        title: inp.title,
        text: `${inp.title}\n\n${inp.summary}`,
        fileId: inp.fileId,
        graphNodeId: inp.documentId,
      });

      if (inp.domain) {
        const did = `dom:${this.slug(inp.domain)}`;
        this.upsertNode(did, "Domain", { name: inp.domain });
        this.addEdge("IN_DOMAIN", inp.documentId, did);
      }

      const topicIdByName = new Map<string, string>();
      for (const t of topicsNormalized) {
        const tid = t.id ?? `top:${this.slug(t.name)}`;
        this.upsertNode(tid, "Topic", { name: t.name, description: t.description ?? "" });
        this.addEdge("ABOUT", inp.documentId, tid, { weight: 1.0 });
        topicIdByName.set(t.name.toLowerCase(), tid);
      }

      for (const k of inp.keywords) {
        const kid = `kw:${this.slug(k)}`;
        this.upsertNode(kid, "Keyword", { term: k });
        this.addEdge("TAGGED", inp.documentId, kid);
      }

      const entityIdByName = new Map<string, string>();
      for (const e of input.entities) {
        const eid = e.id ?? `ent:${this.slug(e.type)}:${this.slug(e.name)}`;
        this.upsertNode(eid, "Entity", {
          name: e.name,
          type: e.type,
          description: e.description ?? "",
          ...(e.aliases?.length ? { aliases: e.aliases } : {}),
        });
        this.addEdge("MENTIONS", inp.documentId, eid, { count: 1, weight: 1.0 });
        entityIdByName.set(e.name.toLowerCase(), eid);
      }

      // Pre-compute the (entityId, surface-form) lookup used for chunk-level
      // MENTIONS scanning below. Includes every alias we know, so "Open AI"
      // and "OpenAI" both hit the same canonical node.
      const entitySurfaces: Array<{ id: string; patterns: RegExp[]; surfaces: string[] }> = [];
      for (const e of input.entities) {
        const eid = entityIdByName.get(e.name.toLowerCase());
        if (!eid) continue;
        const surfaces = uniqueSurfaces([e.name, ...(e.aliases ?? [])]);
        const patterns = surfaces.map(compileEntityPattern).filter((p): p is RegExp => p !== null);
        if (patterns.length) entitySurfaces.push({ id: eid, patterns, surfaces });
      }

      for (const c of inp.chunks) {
        this.upsertNode(c.id, "Chunk", {
          text: c.text.slice(0, 8000),
          position: c.position,
          vector_id: c.vectorId ?? "",
          ...(c.heading?.length ? { heading: c.heading } : {}),
          ...(typeof c.startOffset === "number" ? { start_offset: c.startOffset } : {}),
          ...(typeof c.endOffset === "number" ? { end_offset: c.endOffset } : {}),
          ...(typeof c.pageStart === "number" ? { page_start: c.pageStart } : {}),
          ...(typeof c.pageEnd === "number" ? { page_end: c.pageEnd } : {}),
        });
        this.addEdge("CONTAINS", inp.documentId, c.id, { position: c.position });
        const ftsTitle = c.heading?.length ? `${inp.title} — ${c.heading.join(" › ")}` : `${inp.title} — part ${c.position + 1}`;
        this.upsertFtsRow({
          sourceId: c.id,
          kind: "chunk",
          title: ftsTitle,
          text: c.text,
          fileId: inp.fileId,
          graphNodeId: c.id,
        });

        // Chunk-level MENTIONS: every entity whose surface form appears in the
        // chunk text gets a directed edge with an occurrence count. Makes
        // entity→chunk navigation a first-class graph operation.
        for (const ent of entitySurfaces) {
          let count = 0;
          for (const p of ent.patterns) {
            const matches = c.text.match(p);
            if (matches) count += matches.length;
          }
          if (count > 0) {
            this.addEdge("MENTIONS", c.id, ent.id, { count, weight: Math.min(1, 0.3 + 0.1 * count) });
          }
        }
      }

      // Heuristic PART_OF for topics sharing substring / word overlap.
      if (topicsNormalized.length >= 2) {
        for (let i = 0; i < topicsNormalized.length; i++) {
          for (let j = 0; j < topicsNormalized.length; j++) {
            if (i === j) continue;
            const a = topicsNormalized[i];
            const b = topicsNormalized[j];
            const aid = topicIdByName.get(a.name.toLowerCase())!;
            const bid = topicIdByName.get(b.name.toLowerCase())!;
            if (topicIsPartOf(a.name, b.name)) {
              this.addEdge("PART_OF", aid, bid, { confidence: "heuristic" });
            }
          }
        }
      }

      // Explicit relations from the analyzer.
      for (const rel of inp.relations ?? []) {
        const srcKey = rel.srcName.toLowerCase();
        const dstKey = rel.dstName.toLowerCase();
        if (rel.kind === "related") {
          const s = entityIdByName.get(srcKey);
          const d = entityIdByName.get(dstKey);
          if (s && d && s !== d) {
            const predicate = normalizePredicate(rel.predicate);
            this.addEdge("RELATED", s, d, {
              predicate,
              ...(rel.note ? { note: rel.note } : {}),
            });
          }
        } else if (rel.kind === "part_of") {
          const sub = topicIdByName.get(srcKey);
          const sup = topicIdByName.get(dstKey);
          if (sub && sup && sub !== sup) {
            this.addEdge("PART_OF", sub, sup, {});
          }
        }
      }
    });
    tx(input);
  }

  /**
   * Persist the FTS entry for an entity / topic (the node already exists).
   * Called by the EntityResolver after it has written the embedding and
   * ensured the graph node is up to date.
   */
  async upsertNodeFts(params: {
    sourceId: string;
    kind: "entity" | "topic";
    title: string;
    text: string;
  }): Promise<void> {
    await this.ready;
    this.upsertFtsRow({
      sourceId: params.sourceId,
      kind: params.kind,
      title: params.title,
      text: params.text,
      graphNodeId: params.sourceId,
    });
  }

  /**
   * Full-text search with BM25 ranking. Query is tokenized defensively to
   * avoid FTS5 operator injection. Returns hits with score (negated BM25, so
   * higher is better).
   */
  async ftsSearch(query: string, topK: number, kinds?: string[]): Promise<FtsHit[]> {
    await this.ready;
    const expr = sanitizeFtsQuery(query);
    if (!expr) return [];
    const params: Array<string | number> = [expr];
    let sql = `SELECT source_id, kind, file_id, graph_node_id, title, text, bm25(nodes_fts) AS rank
               FROM nodes_fts
               WHERE nodes_fts MATCH ?`;
    if (kinds && kinds.length) {
      sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
      for (const k of kinds) params.push(k);
    }
    sql += ` ORDER BY rank LIMIT ?`;
    params.push(topK);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      source_id: string;
      kind: string;
      file_id: string | null;
      graph_node_id: string | null;
      title: string | null;
      text: string | null;
      rank: number;
    }>;
    return rows.map((r) => ({
      sourceId: r.source_id,
      kind: r.kind,
      fileId: r.file_id ?? "",
      graphNodeId: r.graph_node_id ?? r.source_id,
      title: r.title ?? "",
      text: r.text ?? "",
      // BM25 in SQLite returns lower-is-better; flip to make higher-is-better
      // for caller convenience. Magnitude is not comparable across queries.
      score: -Number(r.rank ?? 0),
    }));
  }

  /**
   * Search for Documents whose title/summary best matches `query` using FTS.
   * Used by the reference matcher during ingest.
   */
  async findDocumentByTitle(query: string, topN = 5): Promise<FtsHit[]> {
    return this.ftsSearch(query, topN, ["doc_summary"]);
  }

  async saveAgentNote(noteId: string, content: string, reason: string, links: string[]): Promise<void> {
    await this.ready;
    const tx = this.db.transaction((id: string, c: string, r: string, ls: string[]) => {
      this.upsertNode(id, "AgentNote", { content: c, reason: r, created_at: Date.now() });
      for (const link of ls) {
        const exists = this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(link);
        if (exists) this.addEdge("DERIVED_FROM_DOC", id, link);
      }
      this.upsertFtsRow({
        sourceId: id,
        kind: "agent_note",
        title: "agent_note",
        text: c,
        graphNodeId: id,
      });
    });
    tx(noteId, content, reason, links);
  }

  async removeAgentNote(noteId: string): Promise<void> {
    await this.ready;
    this.deleteFtsBySourceId(noteId);
    this.db.prepare("DELETE FROM nodes WHERE id = ? AND type = 'AgentNote'").run(noteId);
  }

  async getStats(): Promise<{ documents: number; entities: number; topics: number; chunks: number }> {
    await this.ready;
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN type = 'Document' THEN 1 ELSE 0 END) AS documents,
           SUM(CASE WHEN type = 'Entity'   THEN 1 ELSE 0 END) AS entities,
           SUM(CASE WHEN type = 'Topic'    THEN 1 ELSE 0 END) AS topics,
           SUM(CASE WHEN type = 'Chunk'    THEN 1 ELSE 0 END) AS chunks
         FROM nodes`,
      )
      .get() as { documents: number | null; entities: number | null; topics: number | null; chunks: number | null };
    return {
      documents: row.documents ?? 0,
      entities: row.entities ?? 0,
      topics: row.topics ?? 0,
      chunks: row.chunks ?? 0,
    };
  }

  async listDomains(): Promise<{ id: string; name: string; count: number }[]> {
    await this.ready;
    const rows = this.db
      .prepare(
        `SELECT n.id AS id, json_extract(n.props_json, '$.name') AS name, COUNT(e.src) AS c
         FROM nodes n
         LEFT JOIN edges e ON e.rel = 'IN_DOMAIN' AND e.dst = n.id
         WHERE n.type = 'Domain'
         GROUP BY n.id
         ORDER BY c DESC`,
      )
      .all() as { id: string; name: string | null; c: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name ?? "", count: r.c }));
  }

  async listTopics(limit = 50): Promise<{ id: string; name: string; count: number }[]> {
    await this.ready;
    const rows = this.db
      .prepare(
        `SELECT n.id AS id, json_extract(n.props_json, '$.name') AS name, COUNT(e.src) AS c
         FROM nodes n
         LEFT JOIN edges e ON e.rel = 'ABOUT' AND e.dst = n.id
         WHERE n.type = 'Topic'
         GROUP BY n.id
         ORDER BY c DESC
         LIMIT ?`,
      )
      .all(limit) as { id: string; name: string | null; c: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name ?? "", count: r.c }));
  }

  async listEntities(limit = 50): Promise<{ id: string; name: string; type: string; aliases: string[]; count: number }[]> {
    await this.ready;
    const rows = this.db
      .prepare(
        `SELECT n.id AS id,
                json_extract(n.props_json, '$.name')      AS name,
                json_extract(n.props_json, '$.type')      AS type,
                json_extract(n.props_json, '$.aliases')   AS aliases,
                COUNT(e.src) AS c
         FROM nodes n
         LEFT JOIN edges e ON e.rel = 'MENTIONS' AND e.dst = n.id
         WHERE n.type = 'Entity'
         GROUP BY n.id
         ORDER BY c DESC
         LIMIT ?`,
      )
      .all(limit) as { id: string; name: string | null; type: string | null; aliases: string | null; c: number }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? "",
      type: r.type ?? "",
      aliases: parseAliases(r.aliases),
      count: r.c,
    }));
  }

  async listEntitiesByType(type: string): Promise<NodeRecord<"Entity">[]> {
    await this.ready;
    const rows = this.db
      .prepare(
        `SELECT id, props_json FROM nodes
         WHERE type = 'Entity'
           AND json_extract(props_json, '$.type') = ?`,
      )
      .all(type) as { id: string; props_json: string }[];
    return rows.map((r) => ({
      id: r.id,
      type: "Entity" as const,
      props: JSON.parse(r.props_json || "{}") as NodePropsMap["Entity"],
    }));
  }

  async listAllTopics(): Promise<NodeRecord<"Topic">[]> {
    await this.ready;
    const rows = this.db
      .prepare(`SELECT id, props_json FROM nodes WHERE type = 'Topic'`)
      .all() as { id: string; props_json: string }[];
    return rows.map((r) => ({
      id: r.id,
      type: "Topic" as const,
      props: JSON.parse(r.props_json || "{}") as NodePropsMap["Topic"],
    }));
  }

  /**
   * Rewrite every edge that references `fromId` as either src or dst onto
   * `toId`. Used by the GraphConsolidator when merging alias entities. Drops
   * edges that would become self-loops and deduplicates via the UNIQUE
   * constraint.
   */
  async mergeNode(fromId: string, toId: string): Promise<number> {
    await this.ready;
    if (fromId === toId) return 0;
    let rewritten = 0;
    const tx = this.db.transaction(() => {
      const upd = this.db.prepare("UPDATE OR IGNORE edges SET src = ? WHERE src = ?");
      const upd2 = this.db.prepare("UPDATE OR IGNORE edges SET dst = ? WHERE dst = ?");
      rewritten += upd.run(toId, fromId).changes;
      rewritten += upd2.run(toId, fromId).changes;
      // Any edges that conflicted with existing unique rows get left behind;
      // remove them explicitly.
      this.db.prepare("DELETE FROM edges WHERE src = ? OR dst = ?").run(fromId, fromId);
      this.db.prepare("DELETE FROM edges WHERE src = dst").run();
      // Migrate FTS row.
      this.deleteFtsBySourceId(toId);
      const shadow = this.db.prepare("SELECT rowid FROM fts_refs WHERE source_id = ?").get(fromId) as
        | { rowid: number }
        | undefined;
      if (shadow) {
        this.db.prepare("UPDATE fts_refs SET source_id = ? WHERE rowid = ?").run(toId, shadow.rowid);
        this.db.prepare("UPDATE nodes_fts SET graph_node_id = ? WHERE rowid = ?").run(toId, shadow.rowid);
      }
      this.db.prepare("DELETE FROM nodes WHERE id = ?").run(fromId);
    });
    tx();
    return rewritten;
  }

  async getNode(id: string): Promise<NodeRecord | null> {
    await this.ready;
    const row = this.db
      .prepare("SELECT id, type, props_json FROM nodes WHERE id = ?")
      .get(id) as { id: string; type: string; props_json: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      type: row.type as GraphNodeType,
      props: JSON.parse(row.props_json || "{}"),
    };
  }

  async updateNodeProps(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.ready;
    const row = this.db.prepare("SELECT props_json FROM nodes WHERE id = ?").get(id) as
      | { props_json: string }
      | undefined;
    if (!row) return;
    const next = { ...(JSON.parse(row.props_json || "{}") as Record<string, unknown>), ...patch };
    this.db.prepare("UPDATE nodes SET props_json = ? WHERE id = ?").run(JSON.stringify(next), id);
  }

  async getDocumentSummary(documentId: string): Promise<{ id: string; title: string; summary: string; path: string } | null> {
    await this.ready;
    const row = this.db
      .prepare(
        `SELECT id,
                json_extract(props_json, '$.title')   AS title,
                json_extract(props_json, '$.summary') AS summary,
                json_extract(props_json, '$.path')    AS path
         FROM nodes
         WHERE id = ? AND type = 'Document'`,
      )
      .get(documentId) as { id: string; title: string | null; summary: string | null; path: string | null } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title ?? "",
      summary: row.summary ?? "",
      path: row.path ?? "",
    };
  }

  async getChunk(chunkId: string): Promise<{
    id: string;
    text: string;
    position: number;
    documentId: string | null;
    documentTitle: string | null;
    heading: string[] | null;
    startOffset: number | null;
    endOffset: number | null;
    pageStart: number | null;
    pageEnd: number | null;
  } | null> {
    await this.ready;
    const row = this.db
      .prepare(
        `SELECT c.id AS id,
                c.props_json AS cprops,
                e.src AS did,
                json_extract(d.props_json, '$.title')    AS dtitle
         FROM nodes c
         LEFT JOIN edges e ON e.rel = 'CONTAINS' AND e.dst = c.id
         LEFT JOIN nodes d ON d.id = e.src
         WHERE c.id = ? AND c.type = 'Chunk'
         LIMIT 1`,
      )
      .get(chunkId) as
      | { id: string; cprops: string | null; did: string | null; dtitle: string | null }
      | undefined;
    if (!row) return null;
    const props = (JSON.parse(row.cprops || "{}") as NodePropsMap["Chunk"]) ?? {};
    return {
      id: row.id,
      text: typeof props.text === "string" ? props.text : "",
      position: typeof props.position === "number" ? props.position : 0,
      documentId: row.did ?? null,
      documentTitle: row.dtitle ?? null,
      heading: Array.isArray(props.heading) ? props.heading : null,
      startOffset: typeof props.start_offset === "number" ? props.start_offset : null,
      endOffset: typeof props.end_offset === "number" ? props.end_offset : null,
      pageStart: typeof props.page_start === "number" ? props.page_start : null,
      pageEnd: typeof props.page_end === "number" ? props.page_end : null,
    };
  }

  /**
   * Documents related to `documentId` through shared entities or topics.
   * Returns candidates ordered by overlap count (descending), limited to
   * `topK`. Used by the `findRelatedDocs` agent tool.
   */
  async relatedDocuments(
    documentId: string,
    via: "entities" | "topics" | "references" | "all",
    topK = 10,
  ): Promise<Array<{ id: string; title: string; score: number; reason: string }>> {
    await this.ready;
    const results = new Map<string, { id: string; title: string; score: number; reason: string }>();
    const addHit = (row: { id: string; title: string | null; overlap: number }, reason: string, weight: number) => {
      const prev = results.get(row.id);
      const next = {
        id: row.id,
        title: row.title ?? "",
        score: (prev?.score ?? 0) + row.overlap * weight,
        reason: prev ? `${prev.reason}; ${reason}` : reason,
      };
      results.set(row.id, next);
    };

    if (via === "entities" || via === "all") {
      const rows = this.db
        .prepare(
          `SELECT d.id AS id,
                  json_extract(d.props_json, '$.title') AS title,
                  COUNT(*) AS overlap
           FROM edges e1
           JOIN edges e2 ON e1.dst = e2.dst AND e1.rel = 'MENTIONS' AND e2.rel = 'MENTIONS' AND e1.src <> e2.src
           JOIN nodes d ON d.id = e2.src AND d.type = 'Document'
           WHERE e1.src = ?
           GROUP BY d.id
           ORDER BY overlap DESC
           LIMIT ?`,
        )
        .all(documentId, topK * 2) as { id: string; title: string | null; overlap: number }[];
      for (const r of rows) addHit(r, "shared entities", 1.0);
    }

    if (via === "topics" || via === "all") {
      const rows = this.db
        .prepare(
          `SELECT d.id AS id,
                  json_extract(d.props_json, '$.title') AS title,
                  COUNT(*) AS overlap
           FROM edges e1
           JOIN edges e2 ON e1.dst = e2.dst AND e1.rel = 'ABOUT' AND e2.rel = 'ABOUT' AND e1.src <> e2.src
           JOIN nodes d ON d.id = e2.src AND d.type = 'Document'
           WHERE e1.src = ?
           GROUP BY d.id
           ORDER BY overlap DESC
           LIMIT ?`,
        )
        .all(documentId, topK * 2) as { id: string; title: string | null; overlap: number }[];
      for (const r of rows) addHit(r, "shared topics", 0.7);
    }

    if (via === "references" || via === "all") {
      const rows = this.db
        .prepare(
          `SELECT d.id AS id,
                  json_extract(d.props_json, '$.title') AS title,
                  1 AS overlap
           FROM edges e
           JOIN nodes d ON d.id = e.dst AND d.type = 'Document'
           WHERE e.rel = 'REFERENCES_DOC' AND e.src = ?
           UNION ALL
           SELECT d.id AS id,
                  json_extract(d.props_json, '$.title') AS title,
                  1 AS overlap
           FROM edges e
           JOIN nodes d ON d.id = e.src AND d.type = 'Document'
           WHERE e.rel = 'REFERENCES_DOC' AND e.dst = ?`,
        )
        .all(documentId, documentId) as { id: string; title: string | null; overlap: number }[];
      for (const r of rows) addHit(r, "cross-document reference", 1.5);
    }

    return Array.from(results.values())
      .filter((r) => r.id !== documentId)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Hydrate an ordered list of node ids to a narrative-friendly payload with
   * readable labels and types. Used by `findPath` to expose a ready-to-cite
   * structure instead of bare ids.
   */
  async describeNodes(ids: string[]): Promise<Array<{ id: string; type: GraphNodeType; label: string }>> {
    await this.ready;
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT id, type, props_json FROM nodes WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: string; type: string; props_json: string }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const row = byId.get(id);
      if (!row) return { id, type: "Document" as GraphNodeType, label: id };
      return {
        id: row.id,
        type: row.type as GraphNodeType,
        label: this.rowToDTO(row).label,
      };
    });
  }

  /**
   * Shortest path (undirected hop count) between two node ids, up to `maxHops`.
   * Returns the sequence of traversed edges (with relation label & props) or
   * null if no path exists.
   */
  async findPath(
    fromId: string,
    toId: string,
    maxHops = 4,
  ): Promise<{ nodes: string[]; edges: EdgeRecord[] } | null> {
    await this.ready;
    if (fromId === toId) return { nodes: [fromId], edges: [] };
    interface Pred {
      nodeId: string;
      edge: EdgeRecord | null;
    }
    const prev = new Map<string, Pred>();
    prev.set(fromId, { nodeId: fromId, edge: null });
    let frontier: string[] = [fromId];
    for (let hop = 0; hop < maxHops && !prev.has(toId); hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        const rows = this.db
          .prepare(
            `SELECT id, rel, src, dst, props_json FROM edges
             WHERE src = ? OR dst = ?`,
          )
          .all(id, id) as { id: number; rel: string; src: string; dst: string; props_json: string }[];
        for (const e of rows) {
          const other = e.src === id ? e.dst : e.src;
          if (prev.has(other)) continue;
          prev.set(other, {
            nodeId: other,
            edge: {
              id: e.id,
              rel: e.rel,
              src: e.src,
              dst: e.dst,
              props: JSON.parse(e.props_json || "{}"),
            },
          });
          next.push(other);
          if (other === toId) break;
        }
        if (prev.has(toId)) break;
      }
      frontier = next;
    }
    if (!prev.has(toId)) return null;
    const nodes: string[] = [];
    const edges: EdgeRecord[] = [];
    let cur = toId;
    while (cur !== fromId) {
      const p = prev.get(cur);
      if (!p || !p.edge) break;
      nodes.unshift(cur);
      edges.unshift(p.edge);
      cur = p.edge.src === cur ? p.edge.dst : p.edge.src;
    }
    nodes.unshift(fromId);
    return { nodes, edges };
  }

  /**
   * Chunks that MENTION a given entity, ranked by mention count × document
   * centrality. Used by `findEntityMentions` and by the graph-expansion
   * scorer when the query seed is an entity node.
   */
  async chunksMentioningEntity(entityId: string, topK = 8): Promise<Array<{
    chunkId: string;
    documentId: string;
    documentTitle: string;
    position: number;
    text: string;
    count: number;
  }>> {
    await this.ready;
    const rows = this.db
      .prepare(
        `SELECT c.id AS cid,
                json_extract(c.props_json, '$.text')     AS ctext,
                json_extract(c.props_json, '$.position') AS cpos,
                d.id AS did,
                json_extract(d.props_json, '$.title')    AS dtitle,
                json_extract(e.props_json, '$.count')    AS ecount
         FROM edges e
         JOIN nodes c ON c.id = e.src AND c.type = 'Chunk'
         LEFT JOIN edges cd ON cd.rel = 'CONTAINS' AND cd.dst = c.id
         LEFT JOIN nodes d  ON d.id = cd.src AND d.type = 'Document'
         WHERE e.rel = 'MENTIONS' AND e.dst = ?
         ORDER BY CAST(COALESCE(json_extract(e.props_json, '$.count'), 1) AS INTEGER) DESC
         LIMIT ?`,
      )
      .all(entityId, topK) as Array<{
      cid: string;
      ctext: string | null;
      cpos: number | null;
      did: string | null;
      dtitle: string | null;
      ecount: number | null;
    }>;
    return rows.map((r) => ({
      chunkId: r.cid,
      documentId: r.did ?? "",
      documentTitle: r.dtitle ?? "",
      position: r.cpos ?? 0,
      text: r.ctext ?? "",
      count: r.ecount ?? 1,
    }));
  }

  /**
   * Top documents that mention a given entity, ranked by MENTIONS count. Used
   * to enrich `entitySearch` hits so the agent immediately sees "where does
   * this entity live in the corpus".
   */
  async documentsForEntity(entityId: string, topK = 5): Promise<Array<{
    documentId: string;
    title: string;
    count: number;
  }>> {
    await this.ready;
    const rows = this.db
      .prepare(
        `SELECT d.id AS did,
                json_extract(d.props_json, '$.title') AS title,
                CAST(COALESCE(json_extract(e.props_json, '$.count'), 1) AS INTEGER) AS cnt
         FROM edges e
         JOIN nodes d ON d.id = e.src AND d.type = 'Document'
         WHERE e.rel = 'MENTIONS' AND e.dst = ?
         ORDER BY cnt DESC
         LIMIT ?`,
      )
      .all(entityId, topK) as Array<{ did: string; title: string | null; cnt: number }>;
    return rows.map((r) => ({ documentId: r.did, title: r.title ?? "", count: r.cnt }));
  }

  /**
   * Outgoing typed RELATED triples for an entity — the (subject, predicate,
   * object) view of the knowledge graph. Filters out self-loops and merges
   * on both directions (RELATED is conceptually directed; consolidator may
   * create reverse edges which we keep distinct).
   */
  async entityTriples(entityId: string, topK = 10): Promise<Array<{
    direction: "out" | "in";
    predicate: string;
    otherId: string;
    otherName: string;
    otherType: string;
  }>> {
    await this.ready;
    const rows = this.db
      .prepare(
        `SELECT 'out' AS dir,
                e.dst AS oid,
                json_extract(n.props_json, '$.name') AS name,
                json_extract(n.props_json, '$.type') AS type,
                COALESCE(json_extract(e.props_json, '$.predicate'), 'related_to') AS pred
         FROM edges e JOIN nodes n ON n.id = e.dst
         WHERE e.rel = 'RELATED' AND e.src = ?
         UNION ALL
         SELECT 'in'  AS dir,
                e.src AS oid,
                json_extract(n.props_json, '$.name') AS name,
                json_extract(n.props_json, '$.type') AS type,
                COALESCE(json_extract(e.props_json, '$.predicate'), 'related_to') AS pred
         FROM edges e JOIN nodes n ON n.id = e.src
         WHERE e.rel = 'RELATED' AND e.dst = ?
         LIMIT ?`,
      )
      .all(entityId, entityId, topK) as Array<{
      dir: "out" | "in";
      oid: string;
      name: string | null;
      type: string | null;
      pred: string;
    }>;
    return rows.map((r) => ({
      direction: r.dir,
      predicate: r.pred,
      otherId: r.oid,
      otherName: r.name ?? r.oid,
      otherType: r.type ?? "",
    }));
  }

  async topicHierarchy(rootId?: string): Promise<Array<{ id: string; name: string; parents: string[]; children: string[] }>> {
    await this.ready;
    const topics = await this.listAllTopics();
    const out = topics.map((t) => ({
      id: t.id,
      name: (t.props as { name?: string }).name ?? t.id,
      parents: [] as string[],
      children: [] as string[],
    }));
    const byId = new Map(out.map((t) => [t.id, t]));
    const partOf = this.db
      .prepare(`SELECT src, dst FROM edges WHERE rel = 'PART_OF'`)
      .all() as { src: string; dst: string }[];
    for (const e of partOf) {
      byId.get(e.src)?.parents.push(e.dst);
      byId.get(e.dst)?.children.push(e.src);
    }
    if (rootId) {
      const reachable = new Set<string>();
      const walk = (id: string) => {
        if (reachable.has(id)) return;
        reachable.add(id);
        for (const c of byId.get(id)?.children ?? []) walk(c);
      };
      walk(rootId);
      return out.filter((t) => reachable.has(t.id));
    }
    return out;
  }

  private rowToDTO(row: { id: string; type: string; props_json: string }): GraphNodeDTO {
    const props = JSON.parse(row.props_json || "{}") as Record<string, unknown>;
    const type = row.type as GraphNodeType;
    const label =
      type === "Document" ? String(props["title"] ?? row.id) :
      type === "Keyword" ? String(props["term"] ?? row.id) :
      type === "Chunk" ? row.id :
      type === "Entity" || type === "Topic" || type === "Domain" ? String(props["name"] ?? row.id) :
      type === "AgentNote" ? String(props["content"] ?? row.id).slice(0, 60) :
      row.id;
    return {
      id: row.id,
      label,
      type: type as GraphNodeDTO["type"],
      properties: props,
    };
  }

  async neighborhood(
    nodeId: string,
    depth = 1,
    filter?: { includeRels?: string[]; excludeRels?: string[] },
  ): Promise<GraphSnapshot> {
    await this.ready;
    const nodeMap = new Map<string, GraphNodeDTO>();
    const edges: GraphEdgeDTO[] = [];
    const frontier = new Set<string>([nodeId]);
    const visited = new Set<string>();
    const include = filter?.includeRels && filter.includeRels.length
      ? new Set(filter.includeRels)
      : null;
    const exclude = filter?.excludeRels && filter.excludeRels.length
      ? new Set(filter.excludeRels)
      : null;
    const edgeAllowed = (rel: string): boolean => {
      if (include && !include.has(rel)) return false;
      if (exclude && exclude.has(rel)) return false;
      return true;
    };

    const nodeStmt = this.db.prepare("SELECT id, type, props_json FROM nodes WHERE id = ?");
    const outStmt = this.db.prepare("SELECT rel, dst, props_json FROM edges WHERE src = ? LIMIT 200");
    const inStmt = this.db.prepare("SELECT rel, src, props_json FROM edges WHERE dst = ? LIMIT 200");

    for (let d = 0; d <= depth; d++) {
      const next = new Set<string>();
      for (const id of frontier) {
        if (visited.has(id)) continue;
        visited.add(id);
        const row = nodeStmt.get(id) as { id: string; type: string; props_json: string } | undefined;
        if (!row) continue;
        if (!nodeMap.has(row.id)) nodeMap.set(row.id, this.rowToDTO(row));
        if (d === depth) continue;
        const outs = outStmt.all(id) as { rel: string; dst: string; props_json: string }[];
        for (const e of outs) {
          if (!edgeAllowed(e.rel)) continue;
          edges.push({
            id: `${id}__${e.rel}__${e.dst}`,
            source: id,
            target: e.dst,
            label: e.rel,
            properties: JSON.parse(e.props_json || "{}"),
          });
          next.add(e.dst);
        }
        const ins = inStmt.all(id) as { rel: string; src: string; props_json: string }[];
        for (const e of ins) {
          if (!edgeAllowed(e.rel)) continue;
          edges.push({
            id: `${e.src}__${e.rel}__${id}`,
            source: e.src,
            target: id,
            label: e.rel,
            properties: JSON.parse(e.props_json || "{}"),
          });
          next.add(e.src);
        }
      }
      frontier.clear();
      for (const x of next) frontier.add(x);
    }

    return { nodes: Array.from(nodeMap.values()), edges };
  }

  async overview(limit = 120): Promise<GraphSnapshot> {
    await this.ready;
    const snap: GraphSnapshot = { nodes: [], edges: [] };
    const nodeRows = this.db
      .prepare(
        `SELECT id, type, props_json FROM nodes
         WHERE type IN ('Document','Topic','Entity','Domain')
         ORDER BY CASE type
           WHEN 'Document' THEN 1
           WHEN 'Topic'    THEN 2
           WHEN 'Entity'   THEN 3
           WHEN 'Domain'   THEN 4
         END
         LIMIT ?`,
      )
      .all(limit * 4) as { id: string; type: string; props_json: string }[];
    for (const r of nodeRows) snap.nodes.push(this.rowToDTO(r));

    const allowed = new Set(snap.nodes.map((n) => n.id));
    const edgeRows = this.db
      .prepare(
        `SELECT rel, src, dst, props_json FROM edges
         WHERE rel IN ('ABOUT','MENTIONS','IN_DOMAIN','RELATED','PART_OF','REFERENCES_DOC','SIMILAR_TO')
         LIMIT 3000`,
      )
      .all() as { rel: string; src: string; dst: string; props_json: string }[];
    for (const e of edgeRows) {
      if (!allowed.has(e.src) || !allowed.has(e.dst)) continue;
      snap.edges.push({
        id: `${e.src}__${e.rel}__${e.dst}`,
        source: e.src,
        target: e.dst,
        label: e.rel,
        properties: JSON.parse(e.props_json || "{}"),
      });
    }
    return snap;
  }

  /**
   * Compute normalized degree centrality for every node and persist as
   * `props.centrality`. Used by the GraphConsolidator and the graph-expanded
   * retrieval scorer.
   */
  async recomputeCentrality(): Promise<void> {
    await this.ready;
    const rows = this.db
      .prepare(
        `SELECT n.id AS id, COUNT(e.id) AS degree
         FROM nodes n
         LEFT JOIN edges e ON (e.src = n.id OR e.dst = n.id)
         GROUP BY n.id`,
      )
      .all() as { id: string; degree: number }[];
    if (rows.length === 0) return;
    const maxDeg = Math.max(1, ...rows.map((r) => r.degree));
    const tx = this.db.transaction((items: typeof rows) => {
      const stmt = this.db.prepare(
        `UPDATE nodes
         SET props_json = json_set(props_json, '$.centrality', ?)
         WHERE id = ?`,
      );
      for (const r of items) {
        stmt.run(r.degree / maxDeg, r.id);
      }
    });
    tx(rows);
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // no-op
    }
  }
}

/**
 * True when `a` looks like a sub-topic of `b` (word-prefix/suffix overlap).
 * Used to seed PART_OF edges as heuristic fallbacks.
 */
function topicIsPartOf(a: string, b: string): boolean {
  if (a === b) return false;
  const ta = a.toLowerCase().split(/\s+/).filter(Boolean);
  const tb = b.toLowerCase().split(/\s+/).filter(Boolean);
  if (tb.length === 0 || ta.length < 2) return false;
  // a is a sub-topic if b's full string is a suffix of a (e.g. "Deep Learning" is part of "Supervised Deep Learning"?). We invert:
  // Treat `a` as part_of `b` if every word of `b` appears in `a` (b is a superset phrase).
  const aSet = new Set(ta);
  for (const w of tb) if (!aSet.has(w)) return false;
  return tb.length < ta.length;
}

/**
 * Produce a safe FTS5 MATCH expression from a user-provided query by stripping
 * operators and quoting each token. Returns an empty string when nothing
 * searchable remains.
 */
export function sanitizeFtsQuery(query: string): string {
  const cleaned = query
    .replace(/["'*^:()\-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (cleaned.length === 0) return "";
  return cleaned.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Normalize a free-form predicate string into a short lower_snake_case token
 * usable as a stable edge property. Falls back to "related_to" on empty input.
 */
function normalizePredicate(raw: string | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "related_to";
  return s
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "related_to";
}

/** Dedupe and clean a list of entity surface forms before compiling patterns. */
function uniqueSurfaces(items: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const it of items) {
    const trimmed = (it ?? "").trim();
    if (trimmed.length >= 2) out.add(trimmed);
  }
  return Array.from(out);
}

/**
 * Compile a surface form (e.g. "OpenAI", "Acme Corp.") into a whole-word,
 * Unicode-aware, case-insensitive regex. Short surfaces (< 3 chars) are
 * rejected to avoid spurious matches like "AI" matching within "mail".
 */
function compileEntityPattern(surface: string): RegExp | null {
  const s = surface.trim();
  if (s.length < 3) return null;
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `\b` doesn't handle Unicode letters reliably in Node regex, so we use
  // custom boundaries via lookarounds over letter/digit classes.
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
  } catch {
    return null;
  }
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string");
  } catch {
    // fall through
  }
  return [];
}
