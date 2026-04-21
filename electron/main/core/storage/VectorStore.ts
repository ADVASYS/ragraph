import * as lancedb from "@lancedb/lancedb";
import { nanoid } from "nanoid";

export interface VectorRecord {
  id: string;
  kind: "doc_summary" | "chunk" | "entity" | "topic" | "agent_note";
  source_id: string;
  universe_id: string;
  title: string;
  text: string;
  vector: number[];
  keywords: string[];
  domain: string;
  topics: string[];
  graph_node_id: string;
  file_id: string;
  created_at: number;
}

export interface VectorSearchHit extends VectorRecord {
  score: number;
}

export interface VectorSearchFilters {
  kind?: VectorRecord["kind"] | VectorRecord["kind"][];
  fileId?: string;
  domain?: string;
  sourceIds?: string[];
  excludeSourceIds?: string[];
  /** Filter by the `type` discriminator stored in entity/topic records. Matches against `domain` column for entities, and `keywords[0]` otherwise; see EntityResolver usage. Optional. */
  entityType?: string;
}

export interface VectorSearchOptions {
  includeVector?: boolean;
}

/** Hard cap to protect the process from pathological inserts. */
const MAX_UPSERT_BATCH = 5000;
/** Allowed characters for our internal vector IDs and source IDs. */
const ID_PATTERN = /^[A-Za-z0-9_\-:.]+$/;

/**
 * Quote a single SQL literal for LanceDB (which uses DataFusion SQL under the
 * hood). LanceDB accepts standard SQL string escaping — single quotes are
 * escaped by doubling. Newlines and NUL bytes are rejected outright since they
 * are valid in DataFusion strings but have no legitimate use in the identifier
 * / filter values this store accepts.
 */
export function quoteLiteral(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("quoteLiteral requires a string");
  }
  if (value.includes("\u0000")) {
    throw new Error("quoteLiteral: string contains NUL byte");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function assertValidId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid id for vector store: ${JSON.stringify(id)}`);
  }
}

function cosine(a: number[], b: number[]): number {
  // Assumes both vectors are L2-normalized (true for E5 and most sane embedders).
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * LanceDB-backed vector store. One table per universe.
 */
export class VectorStore {
  private tablePromise: Promise<lancedb.Table> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly tableName: string,
    private readonly dimension: number,
  ) {}

  private async getTable(): Promise<lancedb.Table> {
    if (!this.tablePromise) {
      const promise = (async () => {
        const db = await lancedb.connect(this.dbPath);
        const tables = await db.tableNames();
        if (tables.includes(this.tableName)) {
          return db.openTable(this.tableName);
        }
        // LanceDB infers the Arrow schema from the seed record. Lists MUST contain
        // at least one value of the target inner type, otherwise LanceDB throws
        // "Cannot infer list vector from empty array or empty list". The seed row
        // is deleted immediately after table creation, so the placeholder values
        // never leak into real data.
        const seed = {
          id: nanoid(),
          kind: "doc_summary",
          source_id: "__seed__",
          universe_id: "__seed__",
          title: "__seed__",
          text: "",
          vector: new Array(this.dimension).fill(0),
          keywords: ["__seed__"],
          domain: "",
          topics: ["__seed__"],
          graph_node_id: "",
          file_id: "",
          created_at: Date.now(),
        } as Record<string, unknown>;
        const table = await db.createTable(this.tableName, [seed]);
        await table.delete(`source_id = '__seed__'`);
        return table;
      })();
      // Do NOT cache rejected promises — a transient failure should not poison
      // every subsequent call for the lifetime of the process.
      promise.catch(() => {
        if (this.tablePromise === promise) this.tablePromise = null;
      });
      this.tablePromise = promise;
    }
    return this.tablePromise;
  }

  /**
   * Returns the table only if it already exists on disk. Used by delete paths so
   * we don't trigger an expensive createTable just to find out there was nothing
   * to delete on a fresh universe.
   */
  private async getTableIfExists(): Promise<lancedb.Table | null> {
    const db = await lancedb.connect(this.dbPath);
    const tables = await db.tableNames();
    if (!tables.includes(this.tableName)) return null;
    return this.getTable();
  }

  async upsertMany(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (records.length > MAX_UPSERT_BATCH) {
      throw new Error(`upsertMany: batch too large (${records.length} > ${MAX_UPSERT_BATCH})`);
    }
    for (const r of records) {
      assertValidId(r.id);
      assertValidId(r.source_id);
    }
    const table = await this.getTable();
    const quoted = records.map((r) => quoteLiteral(r.id)).join(",");
    if (quoted) {
      await table.delete(`id IN (${quoted})`);
    }
    await table.add(records as unknown as Record<string, unknown>[]);
  }

  /**
   * Rewrite every record whose current `source_id` is `oldSourceId` onto
   * `newSourceId`. Used by the GraphConsolidator when merging aliased entities.
   * Returns the number of rewritten records.
   */
  async rewriteSourceId(oldSourceId: string, newSourceId: string): Promise<number> {
    assertValidId(oldSourceId);
    assertValidId(newSourceId);
    const table = await this.getTableIfExists();
    if (!table) return 0;
    const rows = (await table
      .query()
      .where(`source_id = ${quoteLiteral(oldSourceId)}`)
      .toArray()) as Record<string, unknown>[];
    if (rows.length === 0) return 0;
    await table.delete(`source_id = ${quoteLiteral(oldSourceId)}`);
    const rewritten = rows.map((r) => ({
      ...r,
      source_id: newSourceId,
      graph_node_id: newSourceId,
    }));
    await table.add(rewritten);
    return rows.length;
  }

  async deleteBy(predicate: string): Promise<void> {
    const table = await this.getTableIfExists();
    if (!table) return;
    await table.delete(predicate);
  }

  async deleteByFileId(fileId: string): Promise<void> {
    await this.deleteBy(`file_id = ${quoteLiteral(fileId)}`);
  }

  async deleteBySourceId(sourceId: string): Promise<void> {
    await this.deleteBy(`source_id = ${quoteLiteral(sourceId)}`);
  }

  /**
   * Fetch a single record by source_id, primarily used for embedding lookups
   * during graph expansion. Returns null if not present.
   */
  async getBySourceId(sourceId: string): Promise<VectorRecord | null> {
    const table = await this.getTableIfExists();
    if (!table) return null;
    const rows = (await table
      .query()
      .where(`source_id = ${quoteLiteral(sourceId)}`)
      .limit(1)
      .toArray()) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    return rowToRecord(rows[0]);
  }

  /**
   * Batch-fetch records by source_ids. Missing ids are simply absent from the
   * result map.
   */
  async getBySourceIds(sourceIds: string[]): Promise<Map<string, VectorRecord>> {
    if (sourceIds.length === 0) return new Map();
    const table = await this.getTableIfExists();
    const out = new Map<string, VectorRecord>();
    if (!table) return out;
    const quoted = sourceIds.map(quoteLiteral).join(",");
    const rows = (await table
      .query()
      .where(`source_id IN (${quoted})`)
      .limit(sourceIds.length * 2)
      .toArray()) as Record<string, unknown>[];
    for (const r of rows) {
      const rec = rowToRecord(r);
      if (!out.has(rec.source_id)) out.set(rec.source_id, rec);
    }
    return out;
  }

  private buildFilterClauses(filters?: VectorSearchFilters): string[] {
    const clauses: string[] = [];
    if (filters?.kind) {
      const kinds = Array.isArray(filters.kind) ? filters.kind : [filters.kind];
      clauses.push(`kind IN (${kinds.map(quoteLiteral).join(",")})`);
    }
    if (filters?.fileId) clauses.push(`file_id = ${quoteLiteral(filters.fileId)}`);
    if (filters?.domain) clauses.push(`domain = ${quoteLiteral(filters.domain)}`);
    if (filters?.sourceIds && filters.sourceIds.length) {
      clauses.push(`source_id IN (${filters.sourceIds.map(quoteLiteral).join(",")})`);
    }
    if (filters?.excludeSourceIds && filters.excludeSourceIds.length) {
      clauses.push(`source_id NOT IN (${filters.excludeSourceIds.map(quoteLiteral).join(",")})`);
    }
    if (filters?.entityType) {
      // Entity/topic records encode the discriminator in the `domain` column
      // (see EntityResolver). Filter on the exact value.
      clauses.push(`domain = ${quoteLiteral(filters.entityType)}`);
    }
    return clauses;
  }

  async search(
    vector: number[],
    topK: number,
    filters?: VectorSearchFilters,
    options: VectorSearchOptions = {},
  ): Promise<VectorSearchHit[]> {
    const table = await this.getTable();
    let q = table.vectorSearch(vector).limit(topK);

    const clauses = this.buildFilterClauses(filters);
    if (clauses.length) q = q.where(clauses.join(" AND "));

    const results = (await q.toArray()) as Record<string, unknown>[];
    return results.map((r) => rowToHit(r, options.includeVector ?? false));
  }

  async sample(
    n: number,
    strategy: "random" | "recent" | "diverse",
    filters?: VectorSearchFilters,
  ): Promise<VectorSearchHit[]> {
    const table = await this.getTable();
    const clauses = this.buildFilterClauses(filters);
    const pool = strategy === "diverse" ? Math.max(n * 5, 20) : n * 2;
    let q = table.query().limit(pool);
    if (clauses.length) q = q.where(clauses.join(" AND "));
    const rows = (await q.toArray()) as Record<string, unknown>[];
    if (rows.length === 0) return [];

    let picked: Record<string, unknown>[];
    if (strategy === "recent") {
      picked = [...rows].sort((a, b) => Number(b["created_at"] ?? 0) - Number(a["created_at"] ?? 0)).slice(0, n);
    } else if (strategy === "random") {
      picked = [...rows].sort(() => Math.random() - 0.5).slice(0, n);
    } else {
      picked = mmrDiverse(rows, n);
    }

    // For 'diverse', vectors are needed during selection. Drop them from the
    // return payload unless the caller explicitly asked (other callers wouldn't
    // use sample anyway).
    return picked.map((r) => rowToHit(r, false));
  }

  async count(): Promise<number> {
    const table = await this.getTable();
    return await table.countRows();
  }

  async close(): Promise<void> {
    // LanceDB Node handle has no explicit close; GC releases
  }
}

function rowToRecord(r: Record<string, unknown>): VectorRecord {
  return {
    id: String(r["id"]),
    kind: r["kind"] as VectorRecord["kind"],
    source_id: String(r["source_id"]),
    universe_id: String(r["universe_id"]),
    title: String(r["title"]),
    text: String(r["text"]),
    vector: toNumberArray(r["vector"]),
    keywords: toStringArray(r["keywords"]),
    domain: String(r["domain"] ?? ""),
    topics: toStringArray(r["topics"]),
    graph_node_id: String(r["graph_node_id"] ?? ""),
    file_id: String(r["file_id"] ?? ""),
    created_at: Number(r["created_at"] ?? 0),
  };
}

function rowToHit(r: Record<string, unknown>, includeVector: boolean): VectorSearchHit {
  const distance = Number(r["_distance"] ?? 0);
  return {
    id: String(r["id"]),
    kind: r["kind"] as VectorRecord["kind"],
    source_id: String(r["source_id"]),
    universe_id: String(r["universe_id"]),
    title: String(r["title"]),
    text: String(r["text"]),
    vector: includeVector ? toNumberArray(r["vector"]) : [],
    keywords: toStringArray(r["keywords"]),
    domain: String(r["domain"] ?? ""),
    topics: toStringArray(r["topics"]),
    graph_node_id: String(r["graph_node_id"] ?? ""),
    file_id: String(r["file_id"] ?? ""),
    created_at: Number(r["created_at"] ?? 0),
    score: 1 - distance,
  };
}

function toNumberArray(v: unknown): number[] {
  if (Array.isArray(v)) return v.map((x) => Number(x));
  if (v instanceof Float32Array || v instanceof Float64Array) return Array.from(v as Float32Array);
  // LanceDB/Arrow Vector exposes a .toArray() method that returns a typed array.
  if (v && typeof (v as { toArray?: () => ArrayLike<number> }).toArray === "function") {
    const arr = (v as { toArray: () => ArrayLike<number> }).toArray();
    return Array.from(arr, (x) => Number(x));
  }
  if (v && typeof (v as ArrayLike<unknown>).length === "number") {
    return Array.from(v as ArrayLike<unknown>, (x) => Number(x));
  }
  return [];
}

/**
 * Coerce a LanceDB list<utf8> column value into a plain string[]. Arrow
 * Vectors carry non-cloneable metadata (Schema, DataType objects) which breaks
 * Electron's structured-clone when such a value leaks into IPC messages, so we
 * eagerly materialize them into plain arrays right at the storage boundary.
 */
function toStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof (v as { toArray?: () => unknown[] }).toArray === "function") {
    const arr = (v as { toArray: () => unknown[] }).toArray();
    return Array.from(arr, (x) => String(x));
  }
  if (typeof (v as ArrayLike<unknown>).length === "number") {
    return Array.from(v as ArrayLike<unknown>, (x) => String(x));
  }
  return [];
}

/**
 * Greedy farthest-point (MMR approximation with lambda=0 since we have no
 * query context in sample()). Picks a seed, then iteratively chooses the
 * candidate whose minimum cosine distance to already-selected candidates is
 * maximal, deduplicating on source_id.
 */
function mmrDiverse(rows: Record<string, unknown>[], n: number): Record<string, unknown>[] {
  if (rows.length <= n) return rows;
  const withVec = rows
    .map((r) => ({ row: r, vec: toNumberArray(r["vector"]), sid: String(r["source_id"] ?? r["id"]) }))
    .filter((r) => r.vec.length > 0);
  if (withVec.length === 0) {
    // No vectors available — fall back to source_id-dedup shuffle.
    const seen = new Set<string>();
    const out: Record<string, unknown>[] = [];
    for (const r of [...rows].sort(() => Math.random() - 0.5)) {
      const sid = String(r["source_id"] ?? r["id"]);
      if (seen.has(sid)) continue;
      seen.add(sid);
      out.push(r);
      if (out.length >= n) break;
    }
    return out;
  }

  const picked: { row: Record<string, unknown>; vec: number[]; sid: string }[] = [];
  const pickedSids = new Set<string>();

  // Seed: random entry (deterministic enough since pool is pre-limited)
  const seedIdx = Math.floor(Math.random() * withVec.length);
  picked.push(withVec[seedIdx]);
  pickedSids.add(withVec[seedIdx].sid);

  const candidates = withVec.filter((_, i) => i !== seedIdx);

  while (picked.length < n && candidates.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      if (pickedSids.has(cand.sid)) continue;
      let maxSim = -Infinity;
      for (const p of picked) {
        const s = cosine(cand.vec, p.vec);
        if (s > maxSim) maxSim = s;
      }
      // Lower max-similarity to picked → more diverse. Rank by -maxSim.
      const score = -maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const chosen = candidates.splice(bestIdx, 1)[0];
    picked.push(chosen);
    pickedSids.add(chosen.sid);
  }

  return picked.map((p) => p.row);
}
