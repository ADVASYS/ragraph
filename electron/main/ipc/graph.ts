import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type { AppContext } from "../services/AppContext";

export function registerGraphHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.Graph.Overview, async (_e, universeId: string) => {
    const s = await ctx.getUniverseStores(universeId);
    if (!s) return { nodes: [], edges: [] };
    return await s.graph.overview(200);
  });

  ipcMain.handle(IPC.Graph.Neighborhood, async (_e, universeId: string, nodeId: string, depth = 1) => {
    const s = await ctx.getUniverseStores(universeId);
    if (!s) return { nodes: [], edges: [] };
    return await s.graph.neighborhood(nodeId, depth);
  });

  ipcMain.handle(IPC.Graph.Search, async (_e, universeId: string, query: string) => {
    const s = await ctx.getUniverseStores(universeId);
    if (!s) return [];
    const needle = query.toLowerCase();
    const [docs, entities, topics, domains] = await Promise.all([
      s.graph.listTopics(200).then((l) => l.filter((x) => x.name.toLowerCase().includes(needle))),
      s.graph.listEntities(200).then((l) => l.filter((x) => x.name.toLowerCase().includes(needle))),
      s.graph.listTopics(200),
      s.graph.listDomains(),
    ]);
    return {
      topics: topics.filter((x) => x.name.toLowerCase().includes(needle)).map((x) => ({ ...x, kind: "Topic" })),
      entities: entities.map((x) => ({ ...x, kind: "Entity" })),
      domains: domains.filter((x) => x.name.toLowerCase().includes(needle)).map((x) => ({ ...x, kind: "Domain" })),
      docs,
    };
  });

  ipcMain.handle(IPC.Graph.Node, async (_e, universeId: string, nodeId: string) => {
    const s = await ctx.getUniverseStores(universeId);
    if (!s) return null;
    if (nodeId.startsWith("doc:")) return await s.graph.getDocumentSummary(nodeId);
    if (nodeId.startsWith("chunk:")) return await s.graph.getChunk(nodeId);
    return null;
  });

  ipcMain.handle(IPC.Graph.Path, async (_e, universeId: string, fromId: string, toId: string, maxHops = 4) => {
    const s = await ctx.getUniverseStores(universeId);
    if (!s) return null;
    return await s.graph.findPath(fromId, toId, maxHops);
  });

  ipcMain.handle(IPC.Graph.Consolidate, async (_e, universeId: string) => {
    await ctx.runConsolidation(universeId);
    return { ok: true };
  });

  ipcMain.handle(IPC.Graph.CancelConsolidation, async (_e, universeId: string) => {
    ctx.cancelConsolidation(universeId);
    return { ok: true };
  });
}
