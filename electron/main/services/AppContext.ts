import { app, BrowserWindow, safeStorage } from "electron";
import log from "electron-log/main.js";
import { nanoid } from "nanoid";
import { join } from "node:path";
import { StoragePaths } from "../core/storage/paths";
import { MetaDatabase } from "../core/storage/MetaDatabase";
import { GraphStore } from "../core/storage/GraphStore";
import { VectorStore } from "../core/storage/VectorStore";
import { createEmbedder, type Embedder } from "../core/providers/Embedder";
import { buildLLM, type LLMProviderHandle } from "../core/providers/LLMProvider";
import { IngestionPipeline, type IngestionFileRecord, type UniverseIngestionStores } from "../core/ingestion/IngestionPipeline";
import { MountWatcher, type WatcherEvent } from "../core/ingestion/Watcher";
import { GraphConsolidator, type ConsolidationProgress } from "../core/knowledge/GraphConsolidator";
import { WebCrawler, type WebCrawlerRepository, type WebFileRow, type WebPageRow, removeCachedFile } from "../core/ingestion/web/WebCrawler";
import { WebScheduler } from "../core/ingestion/web/WebScheduler";
import { IPC } from "../../../shared/ipc";
import {
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_GRAPH_SETTINGS,
  type AppSettings,
  type FileStatus,
  type IngestionProgress,
  type ProviderConfig,
  type AgentSettings,
  type GraphSettings,
  type WebCrawlProgress,
  type WebSource,
  type WebSourceScope,
  type WebSourceStatus,
} from "../../../shared/types";

/** How many ingested documents trigger a consolidation run per universe. */
const CONSOLIDATION_DOC_THRESHOLD = 10;

export interface UniverseStores extends UniverseIngestionStores {
  id: string;
  name: string;
}

/**
 * Central long-lived orchestrator owned by the main process. Manages all
 * persistent resources (DBs, watchers, embedder) and exposes high-level
 * operations to IPC handlers.
 */
export class AppContext {
  private window: BrowserWindow | null = null;
  private watchers = new Map<string, MountWatcher>();
  private universeStoresCache = new Map<string, UniverseStores>();
  private settingsCache: AppSettings;
  private _embedder: Embedder | null = null;
  private _llm: LLMProviderHandle | null = null;
  public readonly ingestion: IngestionPipeline;
  private consolidationRuns = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private consolidationQueue = new Map<string, boolean>();
  private webCrawlers = new Map<string, WebCrawler>();
  private webQueued = new Set<string>();
  private webScheduler: WebScheduler | null = null;
  private readonly webRepo: WebCrawlerRepository;

  private constructor(
    public readonly paths: StoragePaths,
    public readonly meta: MetaDatabase,
  ) {
    this.settingsCache = this.loadSettings();
    this.webRepo = this.createWebRepository();
    this.ingestion = new IngestionPipeline(
      this.universeStoresCache,
      this.getEmbedder(),
      () => this.getLLM(),
      {
        onProgress: (p) => this.emit(IPC.Events.IngestionProgress, p),
        updateFile: (fileId, patch) => this.patchFile(fileId, patch),
        removeFileRecord: (fileId) => this.meta.db.prepare("DELETE FROM files WHERE id = ?").run(fileId),
        onDocumentIngested: (info) => this.onDocumentIngested(info),
      },
      this.settingsCache.concurrency,
      {
        resolver: {
          entityMergeThreshold: this.settingsCache.graph.entityMergeThreshold,
          topicMergeThreshold: this.settingsCache.graph.topicMergeThreshold,
        },
        referenceMatchThreshold: this.settingsCache.graph.referenceMatchThreshold,
      },
    );
  }

  static async create(): Promise<AppContext> {
    const paths = new StoragePaths(join(app.getPath("userData"), "ragraph"));
    const meta = new MetaDatabase(paths.metaDb);
    const ctx = new AppContext(paths, meta);
    await ctx.boot();
    return ctx;
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
  }

  emit(channel: string, payload: unknown): void {
    if (!this.window || this.window.isDestroyed()) return;
    // Electron's IPC uses structured clone which rejects values it cannot
    // serialize (Arrow Vectors from LanceDB, class instances with Symbols,
    // Proxies, etc.). A JSON round-trip is a cheap, deterministic way to turn
    // any payload into a clone-safe tree and makes the whole channel robust
    // against future tools/stores that surface exotic types. We still keep the
    // raw payload if it's already a primitive for minimal overhead.
    let safe: unknown = payload;
    if (payload !== null && typeof payload === "object") {
      try {
        safe = JSON.parse(JSON.stringify(payload));
      } catch {
        safe = { error: "unserializable_payload" };
      }
    }
    try {
      this.window.webContents.send(channel, safe);
    } catch (err) {
      log.warn("ipc.emit_failed", { channel, error: (err as Error).message });
    }
  }

  private async boot(): Promise<void> {
    try {
      await this.startAllWatchers();
    } catch (err) {
      log.error("Failed to start watchers", err);
    }
    try {
      this.webScheduler = new WebScheduler(() => this.webSchedulerTick());
      this.webScheduler.start();
    } catch (err) {
      log.error("Failed to start web scheduler", err);
    }
  }

  getSettings(): AppSettings {
    return this.settingsCache;
  }

  private loadSettings(): AppSettings {
    const rows = this.meta.db.prepare("SELECT key, value, encrypted FROM settings").all() as {
      key: string;
      value: string;
      encrypted: number;
    }[];
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.encrypted && safeStorage.isEncryptionAvailable()) {
        try {
          map.set(r.key, safeStorage.decryptString(Buffer.from(r.value, "base64")));
        } catch {
          map.set(r.key, "");
        }
      } else {
        map.set(r.key, r.value);
      }
    }
    const providerRaw = map.get("provider");
    const agentRaw = map.get("agent");
    const graphRaw = map.get("graph");
    const parsedAgent = agentRaw ? safeJson<Partial<AgentSettings>>(agentRaw) : null;
    const parsedGraph = graphRaw ? safeJson<Partial<GraphSettings>>(graphRaw) : null;
    return {
      language: (map.get("language") as AppSettings["language"]) || "en",
      provider: providerRaw ? (JSON.parse(providerRaw) as ProviderConfig) : null,
      onboardingComplete: map.get("onboardingComplete") === "true",
      concurrency: Number(map.get("concurrency") ?? 2) || 2,
      autoIngest: (map.get("autoIngest") ?? "true") === "true",
      agent: { ...DEFAULT_AGENT_SETTINGS, ...(parsedAgent ?? {}) },
      graph: { ...DEFAULT_GRAPH_SETTINGS, ...(parsedGraph ?? {}) },
    };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = { ...this.settingsCache, ...patch };
    this.settingsCache = next;
    const write = (key: string, value: string, encrypt = false) => {
      let stored = value;
      let encrypted = 0;
      if (encrypt && safeStorage.isEncryptionAvailable()) {
        stored = safeStorage.encryptString(value).toString("base64");
        encrypted = 1;
      }
      this.meta.db
        .prepare("INSERT OR REPLACE INTO settings (key, value, encrypted) VALUES (?, ?, ?)")
        .run(key, stored, encrypted);
    };
    write("language", next.language);
    write("onboardingComplete", String(next.onboardingComplete));
    write("concurrency", String(next.concurrency));
    write("autoIngest", String(next.autoIngest));
    write("agent", JSON.stringify(next.agent));
    write("graph", JSON.stringify(next.graph));
    if (next.provider) {
      write("provider", JSON.stringify(next.provider), true);
    } else {
      this.meta.db.prepare("DELETE FROM settings WHERE key = 'provider'").run();
    }

    this._llm = null;
    this._embedder = null;
    this.ingestion.setConcurrency(next.concurrency);
    this.ingestion.setTuning({
      resolver: {
        entityMergeThreshold: next.graph.entityMergeThreshold,
        topicMergeThreshold: next.graph.topicMergeThreshold,
      },
      referenceMatchThreshold: next.graph.referenceMatchThreshold,
    });
    return next;
  }

  getEmbedder(): Embedder {
    if (!this._embedder) {
      this._embedder = createEmbedder(this.settingsCache.provider, this.paths.modelsRoot);
    }
    return this._embedder;
  }

  getLLM(): LLMProviderHandle | null {
    if (!this._llm && this.settingsCache.provider) {
      this._llm = buildLLM(this.settingsCache.provider);
    }
    return this._llm;
  }

  async getUniverseStores(universeId: string): Promise<UniverseStores | null> {
    const cached = this.universeStoresCache.get(universeId);
    if (cached) return cached;
    const row = this.meta.db.prepare("SELECT id, name FROM universes WHERE id = ?").get(universeId) as
      | { id: string; name: string }
      | undefined;
    if (!row) return null;
    const graph = new GraphStore(this.paths.graphDb(universeId));
    await graph.whenReady();
    const vectors = new VectorStore(
      this.paths.lanceDb(universeId),
      `vec_${universeId}`,
      this.getEmbedder().dimension,
    );
    const stores: UniverseStores = { id: universeId, universeId, name: row.name, graph, vectors };
    this.universeStoresCache.set(universeId, stores);
    return stores;
  }

  async getAllUniverseStores(): Promise<UniverseStores[]> {
    const rows = this.meta.db.prepare("SELECT id FROM universes ORDER BY created_at").all() as { id: string }[];
    const out: UniverseStores[] = [];
    for (const r of rows) {
      const s = await this.getUniverseStores(r.id);
      if (s) out.push(s);
    }
    return out;
  }

  patchFile(fileId: string, patch: Record<string, unknown>): void {
    const fieldMap: Array<[keyof typeof patch | string, string]> = [
      ["status", "status"],
      ["error", "error"],
      ["hash", "hash"],
      ["mtime", "mtime"],
      ["size", "size"],
      ["ingestedAt", "ingested_at"],
    ];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, column] of fieldMap) {
      if (key in patch) {
        sets.push(`${column} = ?`);
        vals.push((patch as Record<string, unknown>)[key as string]);
      }
    }
    if (!sets.length) return;
    vals.push(fileId);
    this.meta.db
      .prepare(`UPDATE files SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals);
  }

  async startAllWatchers(): Promise<void> {
    const mounts = this.meta.db
      .prepare("SELECT id, universe_id as universeId, path, exclude_globs as excludeGlobs, enabled FROM folder_mounts WHERE enabled = 1")
      .all() as { id: string; universeId: string; path: string; excludeGlobs: string; enabled: number }[];
    for (const m of mounts) {
      await this.startMountWatcher({
        id: m.id,
        universeId: m.universeId,
        path: m.path,
        excludeGlobs: JSON.parse(m.excludeGlobs || "[]"),
      });
    }
  }

  async startMountWatcher(mount: { id: string; universeId: string; path: string; excludeGlobs: string[] }): Promise<void> {
    if (this.watchers.has(mount.id)) return;
    await this.getUniverseStores(mount.universeId);
    const watcher = new MountWatcher(
      { mountId: mount.id, universeId: mount.universeId, root: mount.path, excludeGlobs: mount.excludeGlobs },
      (ev) => this.handleWatcherEvent(mount, ev),
    );
    watcher.start();
    this.watchers.set(mount.id, watcher);
  }

  async stopMountWatcher(mountId: string): Promise<void> {
    const w = this.watchers.get(mountId);
    if (w) {
      await w.stop();
      this.watchers.delete(mountId);
    }
  }

  private isSupportedFile(relPath: string): boolean {
    const lower = relPath.toLowerCase();
    return /\.(pdf|docx|md|markdown|mdx|html?|txt|log|csv|tsv|ini|env|ts|tsx|js|jsx|py|rs|go|java|c|cpp|cs|rb|php|sh|ps1|lua|kt|swift|sql|ya?ml|json|toml|xml|css|scss)$/i.test(lower)
      || !/\.[^.]+$/.test(lower);
  }

  private async handleWatcherEvent(mount: { id: string; universeId: string }, ev: WatcherEvent): Promise<void> {
    try {
      if (!this.settingsCache.autoIngest) return;
      if (!this.isSupportedFile(ev.relPath)) return;
      // Drop events from watchers that have since been stopped. Chokidar can still
      // flush queued callbacks between stop() and the DB DELETE of the mount row.
      if (!this.watchers.has(mount.id)) return;

      if (ev.kind === "unlink") {
        const row = this.meta.db
          .prepare("SELECT id, universe_id as universeId FROM files WHERE universe_id = ? AND abs_path = ?")
          .get(mount.universeId, ev.absPath) as { id: string; universeId: string } | undefined;
        if (row) {
          await this.ingestion.removeFile({
            id: row.id,
            universeId: row.universeId,
            absPath: ev.absPath,
            relPath: ev.relPath,
            mtime: 0,
            size: 0,
            hash: null,
            status: "deleted",
          });
        }
        return;
      }

      const existing = this.meta.db
        .prepare("SELECT id, mtime, hash, status FROM files WHERE universe_id = ? AND abs_path = ?")
        .get(mount.universeId, ev.absPath) as { id: string; mtime: number; hash: string | null; status: string } | undefined;

      let fileId: string;
      let hash: string;
      try {
        hash = await this.ingestion.hashFile(ev.absPath);
      } catch {
        return;
      }

      if (existing) {
        if (existing.hash === hash && existing.status === "indexed") return;
        fileId = existing.id;
        this.meta.db
          .prepare("UPDATE files SET mtime = ?, size = ?, hash = ?, status = 'pending' WHERE id = ?")
          .run(ev.mtime, ev.size, hash, fileId);
      } else {
        // Re-check that both parents still exist just before the INSERT — the user may have
        // deleted the mount or universe while this event was being processed, which would
        // otherwise trigger a FOREIGN KEY constraint failure.
        const stillValid = this.meta.db
          .prepare(
            `SELECT 1 FROM folder_mounts fm
             JOIN universes u ON u.id = fm.universe_id
             WHERE fm.id = ? AND fm.universe_id = ?`,
          )
          .get(mount.id, mount.universeId);
        if (!stillValid) return;

        fileId = nanoid();
        this.meta.db
          .prepare(
            `INSERT INTO files (id, universe_id, mount_id, abs_path, rel_path, mtime, size, hash, status, error, ingested_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
          )
          .run(fileId, mount.universeId, mount.id, ev.absPath, ev.relPath, ev.mtime, ev.size, hash);
      }

      const record: IngestionFileRecord = {
        id: fileId,
        universeId: mount.universeId,
        absPath: ev.absPath,
        relPath: ev.relPath,
        mtime: ev.mtime,
        size: ev.size,
        hash,
        status: "pending",
      };
      await this.ingestion.ingestFile(record);
    } catch (err) {
      // Never let a watcher event escape as an unhandled rejection — log and keep going.
      log.error("handleWatcherEvent failed", { mountId: mount.id, path: ev.absPath, kind: ev.kind }, err);
    }
  }

  async rescanMount(mountId: string): Promise<void> {
    const m = this.meta.db
      .prepare("SELECT id, universe_id as universeId, path, exclude_globs as excludeGlobs FROM folder_mounts WHERE id = ?")
      .get(mountId) as { id: string; universeId: string; path: string; excludeGlobs: string } | undefined;
    if (!m) return;
    await this.stopMountWatcher(mountId);
    await this.startMountWatcher({
      id: m.id,
      universeId: m.universeId,
      path: m.path,
      excludeGlobs: JSON.parse(m.excludeGlobs || "[]"),
    });
  }

  /**
   * Called from the ingestion pipeline after a document has been fully
   * written. Increments the per-universe doc counter and kicks off a
   * consolidation run once the threshold is reached.
   */
  private onDocumentIngested(info: { universeId: string; fileId: string }): void {
    const row = this.meta.db
      .prepare(
        `INSERT INTO consolidation_state (universe_id, docs_since_last_run, last_run_at)
         VALUES (?, 1, NULL)
         ON CONFLICT(universe_id) DO UPDATE SET docs_since_last_run = docs_since_last_run + 1
         RETURNING docs_since_last_run`,
      )
      .get(info.universeId) as { docs_since_last_run: number } | undefined;
    const counter = row?.docs_since_last_run ?? 0;
    if (counter >= CONSOLIDATION_DOC_THRESHOLD) {
      void this.runConsolidation(info.universeId).catch((err) =>
        log.warn("consolidation trigger failed", { universeId: info.universeId, err }),
      );
    }
  }

  /**
   * Public entry point for both automatic (threshold) and manual
   * consolidation runs. Coalesces concurrent requests per universe: if a
   * run is already in progress, queues a single follow-up and otherwise
   * returns the existing promise.
   */
  async runConsolidation(universeId: string): Promise<void> {
    const existing = this.consolidationRuns.get(universeId);
    if (existing) {
      this.consolidationQueue.set(universeId, true);
      return existing.promise;
    }
    const stores = await this.getUniverseStores(universeId);
    if (!stores) return;

    const controller = new AbortController();
    const run = (async () => {
      try {
        const consolidator = new GraphConsolidator(stores.graph, stores.vectors);
        await consolidator.run(
          universeId,
          (p: ConsolidationProgress) => this.emit(IPC.Events.GraphConsolidation, p),
          controller.signal,
        );
        this.meta.db
          .prepare(
            `UPDATE consolidation_state SET docs_since_last_run = 0, last_run_at = ? WHERE universe_id = ?`,
          )
          .run(Date.now(), universeId);
      } finally {
        this.consolidationRuns.delete(universeId);
        if (this.consolidationQueue.delete(universeId)) {
          // A further ingest arrived during the run — schedule one more pass.
          void this.runConsolidation(universeId).catch((err) =>
            log.warn("consolidation re-run failed", { universeId, err }),
          );
        }
      }
    })();
    this.consolidationRuns.set(universeId, { controller, promise: run });
    return run;
  }

  cancelConsolidation(universeId: string): void {
    this.consolidationRuns.get(universeId)?.controller.abort();
  }

  // ----------------------------------------------------------------------
  // Web sources
  // ----------------------------------------------------------------------

  listWebSources(universeId: string): WebSource[] {
    const rows = this.meta.db
      .prepare(
        `SELECT id, universe_id as universeId, url, scope, max_depth as maxDepth, max_pages as maxPages,
                same_origin as sameOrigin, include_patterns as includePatterns, exclude_patterns as excludePatterns,
                refresh_interval_hours as refreshIntervalHours, enabled, status, last_scan_at as lastScanAt,
                next_scan_at as nextScanAt, error, created_at as createdAt, updated_at as updatedAt
         FROM web_sources WHERE universe_id = ? ORDER BY created_at`,
      )
      .all(universeId) as WebSourceRow[];
    return rows.map((r) => this.rowToWebSource(r));
  }

  getWebSource(sourceId: string): WebSource | null {
    const row = this.meta.db
      .prepare(
        `SELECT id, universe_id as universeId, url, scope, max_depth as maxDepth, max_pages as maxPages,
                same_origin as sameOrigin, include_patterns as includePatterns, exclude_patterns as excludePatterns,
                refresh_interval_hours as refreshIntervalHours, enabled, status, last_scan_at as lastScanAt,
                next_scan_at as nextScanAt, error, created_at as createdAt, updated_at as updatedAt
         FROM web_sources WHERE id = ?`,
      )
      .get(sourceId) as WebSourceRow | undefined;
    return row ? this.rowToWebSource(row) : null;
  }

  createWebSource(input: {
    universeId: string;
    url: string;
    scope: WebSourceScope;
    maxDepth: number;
    maxPages: number;
    sameOrigin: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
    refreshIntervalHours?: number | null;
  }): string {
    const id = nanoid();
    const now = Date.now();
    this.meta.db
      .prepare(
        `INSERT INTO web_sources
           (id, universe_id, url, scope, max_depth, max_pages, same_origin, include_patterns, exclude_patterns,
            refresh_interval_hours, enabled, status, last_scan_at, next_scan_at, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'idle', NULL, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.universeId,
        input.url,
        input.scope,
        input.maxDepth,
        input.maxPages,
        input.sameOrigin ? 1 : 0,
        JSON.stringify(input.includePatterns ?? []),
        JSON.stringify(input.excludePatterns ?? []),
        input.refreshIntervalHours && input.refreshIntervalHours > 0 ? input.refreshIntervalHours : null,
        now,
        now,
        now,
      );
    return id;
  }

  updateWebSource(id: string, patch: Partial<WebSource>): void {
    const existing = this.getWebSource(id);
    if (!existing) return;
    const fields: Array<[keyof WebSource, string, (v: unknown) => unknown]> = [
      ["url", "url", (v) => v],
      ["scope", "scope", (v) => v],
      ["maxDepth", "max_depth", (v) => v],
      ["maxPages", "max_pages", (v) => v],
      ["sameOrigin", "same_origin", (v) => (v ? 1 : 0)],
      ["includePatterns", "include_patterns", (v) => JSON.stringify(v ?? [])],
      ["excludePatterns", "exclude_patterns", (v) => JSON.stringify(v ?? [])],
      ["refreshIntervalHours", "refresh_interval_hours", (v) => (v && (v as number) > 0 ? v : null)],
      ["enabled", "enabled", (v) => (v ? 1 : 0)],
    ];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, column, transform] of fields) {
      if (key in patch) {
        sets.push(`${column} = ?`);
        vals.push(transform(patch[key]));
      }
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    vals.push(Date.now());
    vals.push(id);
    this.meta.db.prepare(`UPDATE web_sources SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  async deleteWebSource(id: string): Promise<void> {
    const source = this.getWebSource(id);
    if (!source) return;
    const crawler = this.webCrawlers.get(id);
    if (crawler) {
      crawler.abort();
      this.webCrawlers.delete(id);
    }

    const files = this.meta.db
      .prepare(
        "SELECT id, universe_id as universeId, abs_path as absPath, rel_path as relPath FROM files WHERE web_source_id = ?",
      )
      .all(id) as Array<{ id: string; universeId: string; absPath: string; relPath: string }>;
    for (const f of files) {
      try {
        await this.ingestion.removeFile({
          id: f.id,
          universeId: f.universeId,
          absPath: f.absPath,
          relPath: f.relPath,
          mtime: 0,
          size: 0,
          hash: null,
          status: "deleted",
        });
      } catch (err) {
        log.warn("web.delete.removeFile failed", { fileId: f.id, err: (err as Error).message });
      }
      await removeCachedFile(f.absPath);
    }
    // ON DELETE CASCADE wipes web_pages + files rows referencing this source.
    this.meta.db.prepare("DELETE FROM web_sources WHERE id = ?").run(id);
  }

  async runWebCrawl(sourceId: string): Promise<void> {
    if (this.webCrawlers.has(sourceId)) return;
    const source = this.getWebSource(sourceId);
    if (!source || !source.enabled) return;
    await this.getUniverseStores(source.universeId);

    const crawler = new WebCrawler(source, {
      pipeline: this.ingestion,
      repo: this.webRepo,
      cacheDir: (uid, sid) => this.paths.webCacheDir(uid, sid),
      emitProgress: (p: WebCrawlProgress) => this.emit(IPC.Events.WebCrawlProgress, p),
    });
    this.webCrawlers.set(sourceId, crawler);
    try {
      await crawler.run();
    } finally {
      this.webCrawlers.delete(sourceId);
    }
  }

  cancelWebCrawl(sourceId: string): void {
    this.webCrawlers.get(sourceId)?.abort();
  }

  isWebCrawlRunning(sourceId: string): boolean {
    return this.webCrawlers.has(sourceId);
  }

  private async webSchedulerTick(): Promise<void> {
    const now = Date.now();
    const rows = this.meta.db
      .prepare(
        `SELECT id FROM web_sources
         WHERE enabled = 1 AND refresh_interval_hours IS NOT NULL AND refresh_interval_hours > 0
           AND (next_scan_at IS NULL OR next_scan_at <= ?)`,
      )
      .all(now) as Array<{ id: string }>;
    for (const r of rows) {
      if (this.webCrawlers.has(r.id) || this.webQueued.has(r.id)) continue;
      this.webQueued.add(r.id);
      void this.runWebCrawl(r.id)
        .catch((err) => log.warn("web.scheduler.run failed", { sourceId: r.id, err: (err as Error).message }))
        .finally(() => this.webQueued.delete(r.id));
    }
  }

  private rowToWebSource(row: WebSourceRow): WebSource {
    return {
      id: row.id,
      universeId: row.universeId,
      url: row.url,
      scope: row.scope as WebSourceScope,
      maxDepth: row.maxDepth,
      maxPages: row.maxPages,
      sameOrigin: Boolean(row.sameOrigin),
      includePatterns: safeJson<string[]>(row.includePatterns) ?? [],
      excludePatterns: safeJson<string[]>(row.excludePatterns) ?? [],
      refreshIntervalHours: row.refreshIntervalHours,
      enabled: Boolean(row.enabled),
      status: row.status as WebSourceStatus,
      lastScanAt: row.lastScanAt,
      nextScanAt: row.nextScanAt,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private createWebRepository(): WebCrawlerRepository {
    const db = this.meta.db;
    const mapPageRow = (r: WebPageDbRow): WebPageRow => ({
      id: r.id,
      sourceId: r.sourceId,
      universeId: r.universeId,
      url: r.url,
      normalizedUrl: r.normalizedUrl,
      httpStatus: r.httpStatus,
      contentHash: r.contentHash,
      etag: r.etag,
      lastModified: r.lastModified,
      fetchedAt: r.fetchedAt,
      depth: r.depth,
      fileId: r.fileId,
    });
    return {
      getPage: (sourceId, normalizedUrl) => {
        const row = db
          .prepare(
            `SELECT id, source_id as sourceId, universe_id as universeId, url, normalized_url as normalizedUrl,
                    http_status as httpStatus, content_hash as contentHash, etag, last_modified as lastModified,
                    fetched_at as fetchedAt, depth, file_id as fileId
             FROM web_pages WHERE source_id = ? AND normalized_url = ?`,
          )
          .get(sourceId, normalizedUrl) as WebPageDbRow | undefined;
        return row ? mapPageRow(row) : null;
      },
      upsertPage: (row) => {
        db.prepare(
          `INSERT INTO web_pages (id, source_id, universe_id, url, normalized_url, http_status, content_hash,
                                  etag, last_modified, fetched_at, depth, file_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_id, normalized_url) DO UPDATE SET
             url = excluded.url,
             http_status = excluded.http_status,
             content_hash = excluded.content_hash,
             etag = excluded.etag,
             last_modified = excluded.last_modified,
             fetched_at = excluded.fetched_at,
             depth = excluded.depth,
             file_id = excluded.file_id`,
        ).run(
          row.id,
          row.sourceId,
          row.universeId,
          row.url,
          row.normalizedUrl,
          row.httpStatus,
          row.contentHash,
          row.etag,
          row.lastModified,
          row.fetchedAt,
          row.depth,
          row.fileId,
        );
      },
      listPages: (sourceId) => {
        const rows = db
          .prepare(
            `SELECT id, source_id as sourceId, universe_id as universeId, url, normalized_url as normalizedUrl,
                    http_status as httpStatus, content_hash as contentHash, etag, last_modified as lastModified,
                    fetched_at as fetchedAt, depth, file_id as fileId
             FROM web_pages WHERE source_id = ?`,
          )
          .all(sourceId) as WebPageDbRow[];
        return rows.map(mapPageRow);
      },
      getFileByPath: (universeId, absPath) => {
        const row = db
          .prepare(
            `SELECT id, universe_id as universeId, web_source_id as webSourceId, abs_path as absPath,
                    rel_path as relPath, mtime, size, hash, status
             FROM files WHERE universe_id = ? AND abs_path = ?`,
          )
          .get(universeId, absPath) as WebFileDbRow | undefined;
        if (!row || !row.webSourceId) return null;
        return {
          id: row.id,
          universeId: row.universeId,
          webSourceId: row.webSourceId,
          absPath: row.absPath,
          relPath: row.relPath,
          mtime: row.mtime,
          size: row.size,
          hash: row.hash,
          status: row.status as FileStatus,
        };
      },
      insertFile: (row: WebFileRow) => {
        db.prepare(
          `INSERT INTO files (id, universe_id, mount_id, web_source_id, abs_path, rel_path, mtime, size, hash, status, error, ingested_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        ).run(
          row.id,
          row.universeId,
          row.webSourceId,
          row.absPath,
          row.relPath,
          row.mtime,
          row.size,
          row.hash,
          row.status,
        );
      },
      updateFile: (id: string, patch: Partial<WebFileRow>) => {
        const sets: string[] = [];
        const vals: unknown[] = [];
        const map: Array<[keyof WebFileRow, string]> = [
          ["mtime", "mtime"],
          ["size", "size"],
          ["hash", "hash"],
          ["status", "status"],
        ];
        for (const [key, column] of map) {
          if (key in patch) {
            sets.push(`${column} = ?`);
            vals.push(patch[key]);
          }
        }
        if (!sets.length) return;
        vals.push(id);
        db.prepare(`UPDATE files SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      },
      setSourceStatus: (sourceId, status, error) => {
        db.prepare(
          "UPDATE web_sources SET status = ?, error = ?, updated_at = ? WHERE id = ?",
        ).run(status, error, Date.now(), sourceId);
      },
      setSourceScanned: (sourceId, lastScanAt, nextScanAt) => {
        db.prepare(
          "UPDATE web_sources SET last_scan_at = ?, next_scan_at = ?, updated_at = ? WHERE id = ?",
        ).run(lastScanAt, nextScanAt, Date.now(), sourceId);
      },
    };
  }

  async dispose(): Promise<void> {
    for (const run of this.consolidationRuns.values()) run.controller.abort();
    this.consolidationRuns.clear();
    for (const c of this.webCrawlers.values()) c.abort();
    this.webCrawlers.clear();
    this.webScheduler?.stop();
    this.webScheduler = null;
    for (const w of this.watchers.values()) await w.stop();
    this.watchers.clear();
    for (const s of this.universeStoresCache.values()) {
      await s.graph.close();
      await s.vectors.close();
    }
    this.universeStoresCache.clear();
    this.meta.close();
  }
}

interface WebSourceRow {
  id: string;
  universeId: string;
  url: string;
  scope: string;
  maxDepth: number;
  maxPages: number;
  sameOrigin: number;
  includePatterns: string;
  excludePatterns: string;
  refreshIntervalHours: number | null;
  enabled: number;
  status: string;
  lastScanAt: number | null;
  nextScanAt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface WebPageDbRow {
  id: string;
  sourceId: string;
  universeId: string;
  url: string;
  normalizedUrl: string;
  httpStatus: number | null;
  contentHash: string | null;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number | null;
  depth: number;
  fileId: string | null;
}

interface WebFileDbRow {
  id: string;
  universeId: string;
  webSourceId: string | null;
  absPath: string;
  relPath: string;
  mtime: number;
  size: number;
  hash: string | null;
  status: string;
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
