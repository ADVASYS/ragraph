import { ipcMain, shell } from "electron";
import { IPC } from "../../../shared/ipc";
import type { AppContext } from "../services/AppContext";
import type { IndexedFile, FileStatus } from "../../../shared/types";

export function registerFileHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.Files.List, (_e, universeId: string, filter?: { status?: FileStatus | null; search?: string }) => {
    let sql = `SELECT id, universe_id as universeId, mount_id as mountId, abs_path as absPath, rel_path as relPath, mtime, size, hash, status, error, ingested_at as ingestedAt FROM files WHERE universe_id = ?`;
    const params: unknown[] = [universeId];
    if (filter?.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.search) {
      sql += " AND rel_path LIKE ?";
      params.push(`%${filter.search}%`);
    }
    sql += " ORDER BY rel_path";
    return ctx.meta.db.prepare(sql).all(...params) as IndexedFile[];
  });

  ipcMain.handle(IPC.Files.Reingest, async (_e, fileId: string) => {
    const row = ctx.meta.db
      .prepare(
        "SELECT id, universe_id as universeId, abs_path as absPath, rel_path as relPath, mtime, size, hash, status FROM files WHERE id = ?",
      )
      .get(fileId) as IndexedFile | undefined;
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
      .get(fileId) as IndexedFile | undefined;
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
    const row = ctx.meta.db.prepare("SELECT abs_path as absPath FROM files WHERE id = ?").get(fileId) as
      | { absPath: string }
      | undefined;
    if (row) await shell.openPath(row.absPath);
  });

  ipcMain.handle(IPC.Files.RevealInFolder, (_e, fileId: string) => {
    const row = ctx.meta.db.prepare("SELECT abs_path as absPath FROM files WHERE id = ?").get(fileId) as
      | { absPath: string }
      | undefined;
    if (row) shell.showItemInFolder(row.absPath);
  });
}
