import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type { AppContext } from "../services/AppContext";
import type { AgentMemoryEntry } from "../../../shared/types";

export function registerMemoryHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.Memory.List, (_e, universeId: string): AgentMemoryEntry[] => {
    return ctx.meta.db
      .prepare(
        `SELECT id, universe_id as universeId, kind, content, reason, strength, created_at as createdAt, last_used_at as lastUsedAt
         FROM agent_memory WHERE universe_id = ? ORDER BY created_at DESC`,
      )
      .all(universeId) as AgentMemoryEntry[];
  });

  ipcMain.handle(IPC.Memory.Update, async (_e, id: string, patch: Partial<AgentMemoryEntry>) => {
    ctx.meta.db
      .prepare(
        "UPDATE agent_memory SET content = COALESCE(?, content), reason = COALESCE(?, reason), strength = COALESCE(?, strength) WHERE id = ?",
      )
      .run(patch.content ?? null, patch.reason ?? null, patch.strength ?? null, id);
    const row = ctx.meta.db
      .prepare("SELECT universe_id as universeId, content FROM agent_memory WHERE id = ?")
      .get(id) as { universeId: string; content: string } | undefined;
    if (row) {
      const stores = await ctx.getUniverseStores(row.universeId);
      if (stores) {
        try {
          const vec = (await ctx.getEmbedder().embed([row.content]))[0];
          await stores.vectors.upsertMany([
            {
              id: `vec_mem_${id}`,
              kind: "agent_note",
              source_id: id,
              universe_id: row.universeId,
              title: "note",
              text: row.content,
              vector: vec,
              keywords: [],
              domain: "",
              topics: [],
              graph_node_id: id,
              file_id: "",
              created_at: Date.now(),
            },
          ]);
        } catch {
          // best-effort
        }
      }
    }
  });

  ipcMain.handle(IPC.Memory.Delete, async (_e, id: string) => {
    const row = ctx.meta.db
      .prepare("SELECT universe_id as universeId FROM agent_memory WHERE id = ?")
      .get(id) as { universeId: string } | undefined;
    ctx.meta.db.prepare("DELETE FROM agent_memory WHERE id = ?").run(id);
    if (row) {
      const stores = await ctx.getUniverseStores(row.universeId);
      if (stores) {
        try {
          await stores.graph.removeAgentNote(id);
        } catch {
          // best-effort
        }
        try {
          await stores.vectors.deleteBySourceId(id);
        } catch {
          // best-effort
        }
      }
    }
  });
}
