import { ipcMain, shell } from "electron";
import { IPC } from "../../../shared/ipc";
import type { AppContext } from "../services/AppContext";
import type { IndexedFile, FileStatus } from "../../../shared/types";

interface FileRow {
  id: string;
  universeId: string;
  mountId: string | null;
  webSourceId: string | null;
  webUrl: string | null;
  absPath: string;
  relPath: string;
  mtime: number;
  size: number;
  hash: string | null;
  status: FileStatus;
  error: string | null;
  ingestedAt: number | null;
}

export function registerFileHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.Files.List, (_e, universeId: string, filter?: { status?: FileStatus | null; search?: string }) => {
    let sql = `SELECT f.id, f.universe_id as universeId, f.mount_id as mountId, f.web_source_id as webSourceId,
                      (SELECT wp.url FROM web_pages wp WHERE wp.file_id = f.id LIMIT 1) as webUrl,
                      f.abs_path as absPath, f.rel_path as relPath, f.mtime, f.size, f.hash, f.status, f.error,
                      f.ingested_at as ingestedAt
               FROM files f WHERE f.universe_id = ?`;
    const params: unknown[] = [universeId];
    if (filter?.status) {
      sql += " AND f.status = ?";
      params.push(filter.status);
    }
    if (filter?.search) {
      sql += " AND (f.rel_path LIKE ? OR EXISTS (SELECT 1 FROM web_pages wp WHERE wp.file_id = f.id AND wp.url LIKE ?))";
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    sql += " ORDER BY f.rel_path";
    return ctx.meta.db.prepare(sql).all(...params) as IndexedFile[];
  });

  ipcMain.handle(IPC.Files.Reingest, async (_e, fileId: string) => {
    const row = ctx.meta.db
      .prepare(
        "SELECT id, universe_id as universeId, abs_path as absPath, rel_path as relPath, mtime, size, hash, status FROM files WHERE id = ?",
      )
      .get(fileId) as FileRow | undefined;
    if (!row) return;
    ctx.meta.db.prepare("UPDATE files SET status = 'pending' WHERE id = ?").run(fileId);
    await ctx.ingestion.ingestFile({
      id: row.id,
      universeId: row.universeId,
      absPath: row.absPath,
      relPath: row.relPath,
      mtime: row.mtime,
      size: row.size,
      hash: row.hash,
      status: "pending",
    });
  });

  ipcMain.handle(IPC.Files.Remove, async (_e, fileId: string) => {
    const row = ctx.meta.db
      .prepare(
        "SELECT id, universe_id as universeId, abs_path as absPath, rel_path as relPath, mtime, size, hash FROM files WHERE id = ?",
      )
      .get(fileId) as FileRow | undefined;
    if (!row) return;
    await ctx.ingestion.removeFile({
      id: row.id,
      universeId: row.universeId,
      absPath: row.absPath,
      relPath: row.relPath,
      mtime: row.mtime,
      size: row.size,
      hash: row.hash,
      status: "deleted",
    });
  });

  ipcMain.handle(IPC.Files.Open, async (_e, fileId: string) => {
    const row = ctx.meta.db
      .prepare(
        "SELECT f.abs_path as absPath, (SELECT wp.url FROM web_pages wp WHERE wp.file_id = f.id LIMIT 1) as webUrl FROM files f WHERE f.id = ?",
      )
      .get(fileId) as { absPath: string; webUrl: string | null } | undefined;
    if (!row) return;
    // For web-sourced files we open the original URL in the user's browser
    // rather than the local markdown cache copy.
    if (row.webUrl) {
      await shell.openExternal(row.webUrl);
    } else {
      await shell.openPath(row.absPath);
    }
  });

  ipcMain.handle(IPC.Files.RevealInFolder, (_e, fileId: string) => {
    const row = ctx.meta.db.prepare("SELECT abs_path as absPath FROM files WHERE id = ?").get(fileId) as
      | { absPath: string }
      | undefined;
    if (row) shell.showItemInFolder(row.absPath);
  });
}
