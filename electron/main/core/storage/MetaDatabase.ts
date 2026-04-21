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

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        universe_id TEXT NOT NULL REFERENCES universes(id) ON DELETE CASCADE,
        mount_id TEXT NOT NULL REFERENCES folder_mounts(id) ON DELETE CASCADE,
        abs_path TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT,
        status TEXT NOT NULL,
        error TEXT,
        ingested_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_files_unique_path
        ON files(universe_id, abs_path);
      CREATE INDEX IF NOT EXISTS idx_files_status ON files(universe_id, status);

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

  close(): void {
    this.db.close();
  }
}
