import { dialog, ipcMain } from "electron";
import { nanoid } from "nanoid";
import { IPC } from "../../../shared/ipc";
import type { AppContext } from "../services/AppContext";
import type { FolderMount } from "../../../shared/types";

interface CreateMountInput {
  universeId: string;
  path: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

export function registerMountHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.Mount.List, (_e, universeId: string): FolderMount[] => {
    interface MountRow {
      id: string;
      universeId: string;
      path: string;
      includeGlobs: string;
      excludeGlobs: string;
      enabled: number;
      lastScanAt: number | null;
    }
    const rows = ctx.meta.db
      .prepare(
        "SELECT id, universe_id as universeId, path, include_globs as includeGlobs, exclude_globs as excludeGlobs, enabled, last_scan_at as lastScanAt FROM folder_mounts WHERE universe_id = ?",
      )
      .all(universeId) as MountRow[];
    return rows.map((r) => ({
      id: r.id,
      universeId: r.universeId,
      path: r.path,
      includeGlobs: JSON.parse(r.includeGlobs || "[]") as string[],
      excludeGlobs: JSON.parse(r.excludeGlobs || "[]") as string[],
      enabled: Boolean(r.enabled),
      lastScanAt: r.lastScanAt,
    }));
  });

  ipcMain.handle(IPC.Mount.Create, async (_e, input: CreateMountInput) => {
    const id = nanoid();
    ctx.meta.db
      .prepare(
        `INSERT INTO folder_mounts (id, universe_id, path, include_globs, exclude_globs, enabled, last_scan_at)
         VALUES (?, ?, ?, ?, ?, 1, NULL)`,
      )
      .run(
        id,
        input.universeId,
        input.path,
        JSON.stringify(input.includeGlobs ?? []),
        JSON.stringify(input.excludeGlobs ?? []),
      );
    await ctx.startMountWatcher({
      id,
      universeId: input.universeId,
      path: input.path,
      excludeGlobs: input.excludeGlobs ?? [],
    });
    return id;
  });

  ipcMain.handle(IPC.Mount.Update, async (_e, id: string, patch: Partial<FolderMount>) => {
    const existing = ctx.meta.db
      .prepare("SELECT id, universe_id as universeId, path, exclude_globs as excludeGlobs FROM folder_mounts WHERE id = ?")
      .get(id) as { id: string; universeId: string; path: string; excludeGlobs: string } | undefined;
    if (!existing) throw new Error("Mount not found");

    ctx.meta.db
      .prepare(
        `UPDATE folder_mounts SET
          include_globs = COALESCE(?, include_globs),
          exclude_globs = COALESCE(?, exclude_globs),
          enabled = COALESCE(?, enabled)
         WHERE id = ?`,
      )
      .run(
        patch.includeGlobs ? JSON.stringify(patch.includeGlobs) : null,
        patch.excludeGlobs ? JSON.stringify(patch.excludeGlobs) : null,
        typeof patch.enabled === "boolean" ? (patch.enabled ? 1 : 0) : null,
        id,
      );
    await ctx.rescanMount(id);
  });

  ipcMain.handle(IPC.Mount.Delete, async (_e, id: string) => {
    await ctx.stopMountWatcher(id);
    ctx.meta.db.prepare("DELETE FROM folder_mounts WHERE id = ?").run(id);
  });

  ipcMain.handle(IPC.Mount.Rescan, async (_e, id: string) => {
    await ctx.rescanMount(id);
  });

  ipcMain.handle(IPC.Mount.PickFolder, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}
