import { ipcMain } from "electron";
import { nanoid } from "nanoid";
import { IPC } from "../../../shared/ipc";
import type { AppContext } from "../services/AppContext";
import type { Universe, UniverseStats } from "../../../shared/types";

export function registerUniverseHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.Universe.List, async (): Promise<Universe[]> => {
    const rows = ctx.meta.db
      .prepare(
        "SELECT id, name, description, color, created_at as createdAt, updated_at as updatedAt FROM universes ORDER BY created_at DESC",
      )
      .all() as Universe[];
    for (const u of rows) {
      u.stats = await computeStats(ctx, u.id);
    }
    return rows;
  });

  ipcMain.handle(IPC.Universe.Create, async (_e, input: { name: string; description?: string; color?: string }) => {
    const id = nanoid();
    const now = Date.now();
    ctx.meta.db
      .prepare(
        "INSERT INTO universes (id, name, description, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.name, input.description ?? null, input.color ?? "#6366f1", now, now);
    await ctx.getUniverseStores(id);
    ctx.emit(IPC.Events.UniverseChanged, { action: "create", id });
    return id;
  });

  ipcMain.handle(IPC.Universe.Update, (_e, id: string, patch: Partial<Universe>) => {
    const existing = ctx.meta.db.prepare("SELECT * FROM universes WHERE id = ?").get(id) as Universe | undefined;
    if (!existing) throw new Error("Universe not found");
    ctx.meta.db
      .prepare(
        "UPDATE universes SET name = COALESCE(?, name), description = COALESCE(?, description), color = COALESCE(?, color), updated_at = ? WHERE id = ?",
      )
      .run(patch.name ?? null, patch.description ?? null, patch.color ?? null, Date.now(), id);
    ctx.emit(IPC.Events.UniverseChanged, { action: "update", id });
  });

  ipcMain.handle(IPC.Universe.Delete, async (_e, id: string) => {
    const mounts = ctx.meta.db.prepare("SELECT id FROM folder_mounts WHERE universe_id = ?").all(id) as { id: string }[];
    for (const m of mounts) await ctx.stopMountWatcher(m.id);
    ctx.meta.db.prepare("DELETE FROM universes WHERE id = ?").run(id);
    ctx.emit(IPC.Events.UniverseChanged, { action: "delete", id });
  });

  ipcMain.handle(IPC.Universe.Stats, async (_e, id: string) => {
    return await computeStats(ctx, id);
  });
}

async function computeStats(ctx: AppContext, universeId: string): Promise<UniverseStats> {
  const stores = await ctx.getUniverseStores(universeId);
  const graphStats = stores ? await stores.graph.getStats() : { documents: 0, entities: 0, topics: 0, chunks: 0 };
  const row = ctx.meta.db
    .prepare("SELECT MAX(ingested_at) as last FROM files WHERE universe_id = ? AND status = 'indexed'")
    .get(universeId) as { last: number | null };
  return { ...graphStats, lastSyncAt: row.last ?? null };
}
