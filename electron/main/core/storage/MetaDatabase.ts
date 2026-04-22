import Database from "better-sqlite3";

/**
 * SQLite database for application metadata: settings, universes, mounts,
 * indexed files, chat history and agent memory. Lives in the app data dir.
 */
export class MetaDatabase {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    // Rewrite the `files` table BEFORE any of the new web-source statements
    // run, because the CREATE INDEX ... web_source_id below must find the
    // column. The pre-migration is a no-op on fresh DBs (no files table yet).
    this.migrateFilesForWebSources();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS universes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        color TEXT NOT NULL DEFAULT '#6366f1',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folder_mounts (
        id TEXT PRIMARY KEY,
        universe_id TEXT NOT NULL REFERENCES universes(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        include_globs TEXT NOT NULL DEFAULT '[]',
        exclude_globs TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_scan_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_mounts_universe ON folder_mounts(universe_id);

      CREATE TABLE IF NOT EXISTS web_sources (
        id TEXT PRIMARY KEY,
        universe_id TEXT NOT NULL REFERENCES universes(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'site',
        max_depth INTEGER NOT NULL DEFAULT 2,
        max_pages INTEGER NOT NULL DEFAULT 100,
        same_origin INTEGER NOT NULL DEFAULT 1,
        include_patterns TEXT NOT NULL DEFAULT '[]',
        exclude_patterns TEXT NOT NULL DEFAULT '[]',
        refresh_interval_hours INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle',
        last_scan_at INTEGER,
        next_scan_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_web_sources_universe ON web_sources(universe_id);
      CREATE INDEX IF NOT EXISTS idx_web_sources_next_scan ON web_sources(next_scan_at);

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        universe_id TEXT NOT NULL REFERENCES universes(id) ON DELETE CASCADE,
        mount_id TEXT REFERENCES folder_mounts(id) ON DELETE CASCADE,
        web_source_id TEXT REFERENCES web_sources(id) ON DELETE CASCADE,
        abs_path TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT,
        status TEXT NOT NULL,
        error TEXT,
        ingested_at INTEGER,
        CHECK (mount_id IS NOT NULL OR web_source_id IS NOT NULL)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_files_unique_path
        ON files(universe_id, abs_path);
      CREATE INDEX IF NOT EXISTS idx_files_status ON files(universe_id, status);
      CREATE INDEX IF NOT EXISTS idx_files_web_source ON files(web_source_id);

      CREATE TABLE IF NOT EXISTS web_pages (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES web_sources(id) ON DELETE CASCADE,
        universe_id TEXT NOT NULL REFERENCES universes(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        http_status INTEGER,
        content_hash TEXT,
        etag TEXT,
        last_modified TEXT,
        fetched_at INTEGER,
        depth INTEGER NOT NULL DEFAULT 0,
        file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
        UNIQUE(source_id, normalized_url)
      );
      CREATE INDEX IF NOT EXISTS idx_web_pages_source ON web_pages(source_id);

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        universe_id TEXT REFERENCES universes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chats_universe ON chats(universe_id);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        reasoning TEXT,
        tool_calls TEXT,
        sources TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        mime TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_memory (
        id TEXT PRIMARY KEY,
        universe_id TEXT NOT NULL REFERENCES universes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        reason TEXT,
        strength REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memory_universe ON agent_memory(universe_id);

      CREATE TABLE IF NOT EXISTS consolidation_state (
        universe_id TEXT PRIMARY KEY REFERENCES universes(id) ON DELETE CASCADE,
        docs_since_last_run INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER
      );
    `);
  }

  /**
   * Legacy DBs have `files.mount_id NOT NULL` and no `web_source_id` column.
   * Rewrite the table into the new shape (mount_id nullable + web_source_id +
   * CHECK constraint) in a single transaction so web-sourced files can share
   * the same pipeline.
   *
   * Runs before the main schema DDL so the new `CREATE INDEX … web_source_id`
   * statement finds the column. On a fresh database the `files` table does
   * not exist yet — the table_info probe returns no rows and we exit early.
   * SQLite accepts a forward FK reference to `web_sources` in `files_new`:
   * foreign-key integrity is only checked when rows are inserted/updated,
   * and `web_sources` is created immediately after this migration returns.
   */
  private migrateFilesForWebSources(): void {
    interface ColInfo { name: string; notnull: number; }
    const cols = this.db.prepare("PRAGMA table_info(files)").all() as ColInfo[];
    if (cols.length === 0) return; // fresh DB — nothing to rewrite.
    const hasWebSource = cols.some((c) => c.name === "web_source_id");
    const mountNotNull = cols.find((c) => c.name === "mount_id")?.notnull === 1;
    if (hasWebSource && !mountNotNull) return;

    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        CREATE TABLE files_new (
          id TEXT PRIMARY KEY,
          universe_id TEXT NOT NULL REFERENCES universes(id) ON DELETE CASCADE,
          mount_id TEXT REFERENCES folder_mounts(id) ON DELETE CASCADE,
          web_source_id TEXT REFERENCES web_sources(id) ON DELETE CASCADE,
          abs_path TEXT NOT NULL,
          rel_path TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL,
          hash TEXT,
          status TEXT NOT NULL,
          error TEXT,
          ingested_at INTEGER,
          CHECK (mount_id IS NOT NULL OR web_source_id IS NOT NULL)
        );
        INSERT INTO files_new (id, universe_id, mount_id, web_source_id, abs_path, rel_path, mtime, size, hash, status, error, ingested_at)
          SELECT id, universe_id, mount_id, NULL, abs_path, rel_path, mtime, size, hash, status, error, ingested_at FROM files;
        DROP TABLE files;
        ALTER TABLE files_new RENAME TO files;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_files_unique_path ON files(universe_id, abs_path);
        CREATE INDEX IF NOT EXISTS idx_files_status ON files(universe_id, status);
        CREATE INDEX IF NOT EXISTS idx_files_web_source ON files(web_source_id);
      `);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
