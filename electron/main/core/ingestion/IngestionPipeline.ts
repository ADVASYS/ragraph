import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import PQueue from "p-queue";
import { nanoid } from "nanoid";
import log from "electron-log/main.js";
import type { GraphStore, EntityInput, TopicInput, RelationInput } from "../storage/GraphStore";
import type { VectorStore, VectorRecord } from "../storage/VectorStore";
import type { Embedder } from "../providers/Embedder";
import type { LLMProviderHandle } from "../providers/LLMProvider";
import type { IngestionProgress, FileStatus } from "../../../../shared/types";
import { parseFile, type PageOffset } from "./Parser";
import { chunkText, type Chunk } from "./Chunker";
import { analyzeDocument, type AnalyzerGraphContext } from "./Analyzer";
import { EntityResolver, type ResolverOptions } from "../knowledge/EntityResolver";

export interface UniverseIngestionStores {
  universeId: string;
  graph: GraphStore;
  vectors: VectorStore;
}

export interface IngestionFileRecord {
  id: string;
  universeId: string;
  absPath: string;
  relPath: string;
  mtime: number;
  size: number;
  hash: string | null;
  status: FileStatus;
}

export interface IngestionCallbacks {
  onProgress: (progress: IngestionProgress) => void;
  updateFile: (fileId: string, patch: Partial<IngestionFileRecord> & { status?: FileStatus; error?: string | null }) => void;
  removeFileRecord: (fileId: string) => void;
  /**
   * Invoked once the document is fully persisted. Allows the caller to bump
   * consolidation counters and schedule background jobs.
   */
  onDocumentIngested?: (info: { universeId: string; fileId: string }) => void;
}

export interface IngestionTuning {
  resolver?: ResolverOptions;
  /**
   * Minimum combined score (RRF+cosine) a reference candidate must reach to be
   * linked via REFERENCES_DOC. Default 0.2 (purely relative; RRF scores are
   * small so this is deliberately loose and filtered again by the second-pass
   * rerank).
   */
  referenceMatchThreshold?: number;
  /** Max existing entities surfaced to the analyzer as graph context. Default 25. */
  analyzerContextMaxEntities?: number;
  /** Max existing topics surfaced to the analyzer as graph context. Default 15. */
  analyzerContextMaxTopics?: number;
}

/**
 * Orchestrates parsing, analysis, chunking, entity resolution, graph merge and
 * vector upsert. Concurrency is controlled by a bounded queue to avoid
 * flooding the LLM endpoint. The pipeline is fully framework-independent —
 * no Electron imports leak into this module.
 */
export class IngestionPipeline {
  private queue: PQueue;

  constructor(
    private readonly stores: Map<string, UniverseIngestionStores>,
    private readonly embedder: Embedder,
    private readonly llm: () => LLMProviderHandle | null,
    private readonly callbacks: IngestionCallbacks,
    concurrency = 2,
    private readonly tuning: IngestionTuning = {},
  ) {
    this.queue = new PQueue({ concurrency });
  }

  setConcurrency(n: number): void {
    this.queue.concurrency = Math.max(1, Math.min(8, n));
  }

  setTuning(tuning: IngestionTuning): void {
    Object.assign(this.tuning, tuning);
  }

  async hashFile(absPath: string): Promise<string> {
    const buf = await readFile(absPath);
    return createHash("sha256").update(buf).digest("hex");
  }

  async ingestFile(file: IngestionFileRecord): Promise<void> {
    await this.queue.add(() => this.runIngest(file));
  }

  async removeFile(file: IngestionFileRecord): Promise<void> {
    const stores = this.stores.get(file.universeId);
    if (!stores) return;
    this.emit({ universeId: file.universeId, fileId: file.id, relPath: file.relPath, status: "deleted", phase: "graph", percent: 50 });
    await stores.graph.removeDocument(`doc:${file.id}`);
    await stores.vectors.deleteByFileId(file.id);
    this.callbacks.removeFileRecord(file.id);
    this.emit({ universeId: file.universeId, fileId: file.id, relPath: file.relPath, status: "deleted", phase: "done", percent: 100 });
  }

  private emit(progress: IngestionProgress): void {
    this.callbacks.onProgress(progress);
  }

  private async runIngest(file: IngestionFileRecord): Promise<void> {
    const stores = this.stores.get(file.universeId);
    if (!stores) return;
    const llm = this.llm();
    if (!llm) {
      this.callbacks.updateFile(file.id, { status: "failed", error: "No LLM provider configured" });
      this.emit({ universeId: file.universeId, fileId: file.id, relPath: file.relPath, status: "failed", phase: "error", percent: 0, message: "No LLM provider" });
      return;
    }

    const base = {
      universeId: file.universeId,
      fileId: file.id,
      relPath: file.relPath,
    };

    const runStart = Date.now();
    log.info("ingest.start", { fileId: file.id, relPath: file.relPath, size: file.size, universeId: file.universeId });

    try {
      this.callbacks.updateFile(file.id, { status: "processing", error: null });
      this.emit({ ...base, status: "processing", phase: "parse", percent: 2 });
      const parseStart = Date.now();
      const parsed = await parseFile(file.absPath);

      if (!parsed.text || parsed.text.trim().length < 20) {
        this.callbacks.updateFile(file.id, { status: "failed", error: "Empty or too short" });
        this.emit({ ...base, status: "failed", phase: "error", percent: 0, message: "Empty document" });
        log.warn("ingest.empty", { fileId: file.id, relPath: file.relPath });
        return;
      }

      const pages = typeof parsed.metadata.pages === "number" ? parsed.metadata.pages : undefined;
      const chars = parsed.text.length;
      log.info("ingest.parse done", { fileId: file.id, pages, chars, ms: Date.now() - parseStart });
      this.emit({ ...base, status: "processing", phase: "parse", percent: 10, pages, chars });

      this.emit({ ...base, status: "processing", phase: "chunk", percent: 15, pages, chars });
      const chunks = chunkText(parsed.text);
      // Normalize the text the exact same way the chunker does and rebase
      // parser page offsets onto that normalized stream. Without this the
      // chunk offsets (normalized) would mismatch the page ranges (raw) for
      // any CRLF-authored PDF page text.
      const normalizedText = parsed.text.replace(/\r\n?/g, "\n");
      const normalizedPageOffsets = rebasePageOffsets(parsed.pageOffsets, parsed.text, normalizedText);
      const chunkPages = chunks.map((c) => resolvePageRange(c, normalizedPageOffsets));
      log.info("ingest.chunk done", { fileId: file.id, chunks: chunks.length });
      this.emit({ ...base, status: "processing", phase: "chunk", percent: 20, pages, chars, total: chunks.length });

      // Build the graph context BEFORE the analyzer runs so the model reuses
      // canonical entity / topic names from the existing universe instead of
      // emitting parallel surface variants. This is cheap: one preview
      // embedding + two filtered vector queries.
      const graphContext = await this.buildAnalyzerContext({
        graph: stores.graph,
        vectors: stores.vectors,
        title: parsed.title,
        text: parsed.text,
      });

      const analyzeStart = Date.now();
      this.emit({ ...base, status: "processing", phase: "analyze", percent: 25, pages, chars });
      const analysis = await analyzeDocument(llm, parsed.title, parsed.text, (ap) => {
        if (ap.phase === "summarize") {
          const pct = 25 + Math.floor((ap.step / Math.max(1, ap.total)) * 30);
          this.emit({
            ...base,
            status: "processing",
            phase: "analyze",
            percent: pct,
            step: ap.step,
            total: ap.total,
            pages,
            chars,
            message: "summarize",
          });
        } else {
          const pct = 55 + Math.floor((ap.step / Math.max(1, ap.total)) * 30);
          this.emit({
            ...base,
            status: "processing",
            phase: "analyze",
            percent: pct,
            step: ap.step,
            total: ap.total,
            pages,
            chars,
            message: "structure",
          });
        }
      }, graphContext);
      log.info("ingest.analyze done", { fileId: file.id, ms: Date.now() - analyzeStart, topics: analysis.topics.length, entities: analysis.entities.length });

      await stores.graph.removeDocument(`doc:${file.id}`);
      await stores.vectors.deleteByFileId(file.id);

      const resolver = new EntityResolver(stores.graph, stores.vectors, this.embedder, file.universeId, this.tuning.resolver);
      const entityInputs: EntityInput[] = analysis.entities.map((e) => ({
        name: e.name,
        type: e.type,
        description: e.description ?? null,
      }));
      const topicInputs: TopicInput[] = analysis.topics.map((t) => ({ name: t, description: "" }));
      const resolution = await resolver.resolve(entityInputs, topicInputs);

      const embedStart = Date.now();
      this.emit({ ...base, status: "processing", phase: "embed", percent: 86, pages, chars, step: 0, total: chunks.length });

      const records: VectorRecord[] = [];
      const summaryEmbedding = (await this.embedder.embed(
        [`${analysis.title}\n\n${analysis.summary}\nkeywords: ${analysis.keywords.join(", ")}`],
        "passage",
      ))[0];
      const docId = `doc:${file.id}`;
      records.push({
        id: `vec_summary_${file.id}`,
        kind: "doc_summary",
        source_id: docId,
        universe_id: file.universeId,
        title: analysis.title,
        text: analysis.summary,
        vector: summaryEmbedding,
        keywords: analysis.keywords,
        domain: analysis.domain,
        topics: analysis.topics,
        graph_node_id: docId,
        file_id: file.id,
        created_at: Date.now(),
      });

      const chunkIds: string[] = [];
      const chunkTexts = chunks.map((c) => c.text);
      if (chunkTexts.length) {
        const batchSize = 16;
        const vectors: number[][] = [];
        for (let i = 0; i < chunkTexts.length; i += batchSize) {
          const batch = chunkTexts.slice(i, i + batchSize);
          const embs = await this.embedder.embed(batch, "passage");
          vectors.push(...embs);
          const done = i + batch.length;
          const pct = 86 + Math.floor((done / chunkTexts.length) * 8);
          this.emit({
            ...base,
            status: "processing",
            phase: "embed",
            percent: pct,
            step: done,
            total: chunkTexts.length,
            pages,
            chars,
          });
        }
        chunks.forEach((chunk, idx) => {
          const cid = `chunk:${file.id}:${idx}`;
          chunkIds.push(cid);
          records.push({
            id: `vec_chunk_${file.id}_${idx}`,
            kind: "chunk",
            source_id: cid,
            universe_id: file.universeId,
            title: `${analysis.title} — part ${idx + 1}`,
            text: chunk.text,
            vector: vectors[idx],
            keywords: analysis.keywords,
            domain: analysis.domain,
            topics: analysis.topics,
            graph_node_id: cid,
            file_id: file.id,
            created_at: Date.now(),
          });
        });
      }

      log.info("ingest.embed done", { fileId: file.id, ms: Date.now() - embedStart, chunks: chunks.length });
      this.emit({ ...base, status: "processing", phase: "graph", percent: 95, pages, chars, total: chunks.length });

      const relations: RelationInput[] = (analysis.relations ?? []).map((r) => ({
        srcName: r.src,
        dstName: r.dst,
        kind: r.type,
        ...(r.type === "related" && r.predicate ? { predicate: r.predicate } : {}),
        note: r.note,
      }));

      await stores.graph.writeAnalysis({
        documentId: docId,
        fileId: file.id,
        title: analysis.title,
        path: file.absPath,
        mime: parsed.mime,
        summary: analysis.summary,
        domain: analysis.domain,
        topics: resolution.topics.map((t) => ({ id: t.id, name: t.name, description: t.description ?? "" })),
        entities: resolution.entities.map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          description: e.description ?? "",
          aliases: e.aliases,
        })),
        keywords: analysis.keywords,
        references: analysis.references,
        chunks: chunks.map((c, idx) => ({
          id: `chunk:${file.id}:${idx}`,
          text: c.text,
          position: idx,
          vectorId: `vec_chunk_${file.id}_${idx}`,
          heading: c.heading,
          startOffset: c.startOffset,
          endOffset: c.endOffset,
          pageStart: chunkPages[idx]?.pageStart,
          pageEnd: chunkPages[idx]?.pageEnd,
        })),
        relations,
      });

      const allRecords = [...records, ...resolution.newVectorRecords, ...resolution.updatedVectorRecords];
      await stores.vectors.upsertMany(allRecords);
      await resolver.syncFts(resolution);

      // Cross-document reference matcher. Best-effort: ignores errors so a
      // failure here never prevents the document from being marked indexed.
      try {
        await this.linkReferences({
          documentId: docId,
          universeId: file.universeId,
          graph: stores.graph,
          vectors: stores.vectors,
          references: analysis.references,
        });
      } catch (err) {
        log.warn("ingest.references failed", { fileId: file.id, err: (err as Error).message });
      }

      this.callbacks.updateFile(file.id, { status: "indexed", error: null });
      this.emit({ ...base, status: "indexed", phase: "done", percent: 100, pages, chars, total: chunks.length });
      log.info("ingest.done", { fileId: file.id, relPath: file.relPath, ms: Date.now() - runStart });

      this.callbacks.onDocumentIngested?.({ universeId: file.universeId, fileId: file.id });
    } catch (err) {
      const message = (err as Error).message || String(err);
      this.callbacks.updateFile(file.id, { status: "failed", error: message });
      this.emit({ ...base, status: "failed", phase: "error", percent: 0, message });
      log.error("ingest.failed", { fileId: file.id, relPath: file.relPath, ms: Date.now() - runStart, error: message });
    }
  }

  /**
   * Surface a small set of existing canonical entities and topics to the
   * analyzer so it reuses them verbatim instead of producing parallel surface
   * variants. We compute a cheap preview embedding over the title + first
   * paragraphs and retrieve the most semantically similar entity / topic
   * records from the vector store. Errors are swallowed — a missing context is
   * strictly optional and must never block ingestion.
   */
  private async buildAnalyzerContext(args: {
    graph: GraphStore;
    vectors: VectorStore;
    title: string;
    text: string;
  }): Promise<AnalyzerGraphContext | undefined> {
    try {
      const maxEntities = this.tuning.analyzerContextMaxEntities ?? 25;
      const maxTopics = this.tuning.analyzerContextMaxTopics ?? 15;
      if (maxEntities <= 0 && maxTopics <= 0) return undefined;

      // Cheap preview: title plus the first ~1.5k characters. Enough to
      // capture the dominant entities / topics without embedding the full
      // document twice.
      const preview = `${args.title}\n\n${args.text.slice(0, 1500)}`;
      const embedding = (await this.embedder.embed([preview], "query"))[0];

      const [entityHits, topicHits] = await Promise.all([
        maxEntities > 0
          ? args.vectors.search(embedding, maxEntities * 2, { kind: "entity" })
          : Promise.resolve([]),
        maxTopics > 0
          ? args.vectors.search(embedding, maxTopics * 2, { kind: "topic" })
          : Promise.resolve([]),
      ]);

      const knownEntities: AnalyzerGraphContext["knownEntities"] = [];
      const seenEntity = new Set<string>();
      for (const h of entityHits) {
        if (knownEntities.length >= maxEntities) break;
        const node = await args.graph.getNode(h.source_id);
        const props = (node?.props as { name?: string; type?: string; aliases?: string[] } | undefined) ?? {};
        const name = props.name ?? h.title;
        if (!name || seenEntity.has(name.toLowerCase())) continue;
        seenEntity.add(name.toLowerCase());
        knownEntities.push({
          name,
          type: props.type ?? h.domain ?? "other",
          aliases: Array.isArray(props.aliases) ? props.aliases.slice(0, 5) : [],
        });
      }

      const knownTopics: AnalyzerGraphContext["knownTopics"] = [];
      const seenTopic = new Set<string>();
      for (const h of topicHits) {
        if (knownTopics.length >= maxTopics) break;
        const node = await args.graph.getNode(h.source_id);
        const props = (node?.props as { name?: string } | undefined) ?? {};
        const name = props.name ?? h.title;
        if (!name || seenTopic.has(name.toLowerCase())) continue;
        seenTopic.add(name.toLowerCase());
        knownTopics.push({ name });
      }

      if (knownEntities.length === 0 && knownTopics.length === 0) return undefined;
      log.info("ingest.context", { entities: knownEntities.length, topics: knownTopics.length });
      return { knownEntities, knownTopics };
    } catch (err) {
      log.warn("ingest.context failed", { error: (err as Error).message });
      return undefined;
    }
  }

  /**
   * For each bibliographic reference in the analyzer output, find the most
   * likely target Document within the same universe via hybrid FTS+vector
   * retrieval and link it with REFERENCES_DOC. Fully offline; uses only the
   * per-universe stores to respect universe isolation.
   */
  private async linkReferences(args: {
    documentId: string;
    universeId: string;
    graph: GraphStore;
    vectors: VectorStore;
    references: string[];
  }): Promise<void> {
    const threshold = this.tuning.referenceMatchThreshold ?? 0.2;
    for (const raw of args.references) {
      const ref = raw.trim();
      if (!ref || ref.length < 4) continue;
      const ftsHits = await args.graph.findDocumentByTitle(ref, 3);
      const embedding = (await this.embedder.embed([ref], "query"))[0];
      const vecHits = await args.vectors.search(embedding, 3, { kind: "doc_summary" });

      // Combine rank lists by RRF keyed on source_id.
      const scores = new Map<string, { sourceId: string; title: string; score: number }>();
      ftsHits.forEach((h, rank) => {
        const s = 1 / (60 + rank + 1);
        const prev = scores.get(h.sourceId);
        scores.set(h.sourceId, { sourceId: h.sourceId, title: h.title, score: (prev?.score ?? 0) + s });
      });
      vecHits.forEach((h, rank) => {
        const s = 1 / (60 + rank + 1);
        const prev = scores.get(h.source_id);
        scores.set(h.source_id, { sourceId: h.source_id, title: h.title, score: (prev?.score ?? 0) + s });
      });
      const candidates = Array.from(scores.values())
        .filter((c) => c.sourceId !== args.documentId)
        .sort((a, b) => b.score - a.score);
      if (candidates.length === 0) continue;
      const best = candidates[0];
      if (best.score < threshold) continue;

      // Use the GraphStore's public write path via direct SQL — we've already
      // guaranteed both nodes exist above.
      // The UNIQUE(rel, src, dst) constraint dedupes repeated references.
      args.graph.db
        .prepare(
          `INSERT INTO edges (rel, src, dst, props_json) VALUES ('REFERENCES_DOC', ?, ?, ?)
           ON CONFLICT(rel, src, dst) DO UPDATE SET props_json = excluded.props_json`,
        )
        .run(
          args.documentId,
          best.sourceId,
          JSON.stringify({ context: ref, confidence: Number(best.score.toFixed(3)) }),
        );
    }
  }
}

export function makeChunkBatchId(): string {
  return nanoid(10);
}

/**
 * Translate raw-text page offsets into normalized-text offsets. We walk the
 * raw text once, tracking how many characters we've emitted into the
 * normalized stream (CRLF → LF, CR → LF collapses 2 chars to 1). For each
 * page boundary we record the current normalized position.
 */
function rebasePageOffsets(pageOffsets: PageOffset[], raw: string, normalized: string): PageOffset[] {
  if (pageOffsets.length === 0) return [];
  if (raw === normalized) {
    // Trimming above can shift the first and last offsets by a few whitespace
    // characters; clamp defensively so no page extends past the actual text.
    return pageOffsets.map((p) => ({
      page: p.page,
      start: Math.max(0, Math.min(p.start, normalized.length)),
      end: Math.max(0, Math.min(p.end, normalized.length)),
    }));
  }

  const rawToNormalized = new Array<number>(raw.length + 1);
  let n = 0;
  for (let r = 0; r < raw.length; r++) {
    rawToNormalized[r] = n;
    const ch = raw[r];
    if (ch === "\r") {
      // \r\n collapses to \n (one char consumed in normalized). Lone \r also
      // becomes a single \n. Either way we advance normalized by 1 per \r
      // boundary; the following \n (if any) is consumed into the same \n.
      n += 1;
      if (raw[r + 1] === "\n") {
        r += 1;
        rawToNormalized[r] = n; // the \n itself maps to the already-emitted \n
      }
    } else {
      n += 1;
    }
  }
  rawToNormalized[raw.length] = n;

  return pageOffsets.map((p) => {
    const start = rawToNormalized[Math.min(Math.max(0, p.start), raw.length)] ?? 0;
    const end = rawToNormalized[Math.min(Math.max(0, p.end), raw.length)] ?? normalized.length;
    return {
      page: p.page,
      start: Math.min(start, normalized.length),
      end: Math.min(end, normalized.length),
    };
  });
}

/**
 * Map a chunk's character range onto the page range that covers it. Picks
 * every page whose [start,end) intersects the chunk range. Returns `undefined`
 * fields for formats without page metadata (markdown, html, text).
 */
function resolvePageRange(
  chunk: Chunk,
  pageOffsets: PageOffset[],
): { pageStart?: number; pageEnd?: number } {
  if (pageOffsets.length === 0) return {};
  let pageStart: number | undefined;
  let pageEnd: number | undefined;
  for (const p of pageOffsets) {
    const overlaps = p.start < chunk.endOffset && p.end > chunk.startOffset;
    if (!overlaps) continue;
    if (pageStart === undefined || p.page < pageStart) pageStart = p.page;
    if (pageEnd === undefined || p.page > pageEnd) pageEnd = p.page;
  }
  return { pageStart, pageEnd };
}
