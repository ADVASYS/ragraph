import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../../shared/ipc";

type Invoker = <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;
const invoke: Invoker = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const listeners = new Map<string, Set<(payload: unknown) => void>>();

const ensureListener = (channel: string) => {
  if (!listeners.has(channel)) {
    listeners.set(channel, new Set());
    ipcRenderer.on(channel, (_ev, payload) => {
      listeners.get(channel)?.forEach((cb) => cb(payload));
    });
  }
  return listeners.get(channel)!;
};

const on = (channel: string, cb: (payload: unknown) => void) => {
  const set = ensureListener(channel);
  set.add(cb);
  return () => set.delete(cb);
};

const api = {
  settings: {
    get: () => invoke(IPC.Settings.Get),
    update: (patch: unknown) => invoke(IPC.Settings.Update, patch),
    testProvider: (config: unknown) => invoke(IPC.Settings.TestProvider, config),
    fetchModels: (config: unknown) => invoke(IPC.Settings.FetchModels, config),
  },
  universes: {
    list: () => invoke(IPC.Universe.List),
    create: (input: unknown) => invoke(IPC.Universe.Create, input),
    update: (id: string, patch: unknown) => invoke(IPC.Universe.Update, id, patch),
    delete: (id: string) => invoke(IPC.Universe.Delete, id),
    stats: (id: string) => invoke(IPC.Universe.Stats, id),
  },
  mounts: {
    list: (universeId: string) => invoke(IPC.Mount.List, universeId),
    create: (input: unknown) => invoke(IPC.Mount.Create, input),
    update: (id: string, patch: unknown) => invoke(IPC.Mount.Update, id, patch),
    delete: (id: string) => invoke(IPC.Mount.Delete, id),
    rescan: (id: string) => invoke(IPC.Mount.Rescan, id),
    pickFolder: () => invoke(IPC.Mount.PickFolder),
  },
  webSources: {
    list: (universeId: string) => invoke(IPC.WebSource.List, universeId),
    create: (input: unknown) => invoke(IPC.WebSource.Create, input),
    update: (id: string, patch: unknown) => invoke(IPC.WebSource.Update, id, patch),
    delete: (id: string) => invoke(IPC.WebSource.Delete, id),
    rescan: (id: string) => invoke(IPC.WebSource.Rescan, id),
    cancelScan: (id: string) => invoke(IPC.WebSource.CancelScan, id),
    testUrl: (url: string) => invoke(IPC.WebSource.TestUrl, url),
  },
  files: {
    list: (universeId: string, filter?: unknown) => invoke(IPC.Files.List, universeId, filter),
    reingest: (fileId: string) => invoke(IPC.Files.Reingest, fileId),
    remove: (fileId: string) => invoke(IPC.Files.Remove, fileId),
    open: (fileId: string) => invoke(IPC.Files.Open, fileId),
    reveal: (fileId: string) => invoke(IPC.Files.RevealInFolder, fileId),
  },
  chat: {
    list: (universeId: string | null) => invoke(IPC.Chat.List, universeId),
    create: (input: unknown) => invoke(IPC.Chat.Create, input),
    rename: (id: string, title: string) => invoke(IPC.Chat.Rename, id, title),
    delete: (id: string) => invoke(IPC.Chat.Delete, id),
    messages: (chatId: string) => invoke(IPC.Chat.Messages, chatId),
    send: (input: unknown) => invoke(IPC.Chat.Send, input),
    stop: (chatId: string) => invoke(IPC.Chat.Stop, chatId),
    branch: (messageId: string) => invoke(IPC.Chat.Branch, messageId),
  },
  graph: {
    overview: (universeId: string, filter?: unknown) => invoke(IPC.Graph.Overview, universeId, filter),
    neighborhood: (universeId: string, nodeId: string, depth?: number) =>
      invoke(IPC.Graph.Neighborhood, universeId, nodeId, depth),
    search: (universeId: string, query: string) => invoke(IPC.Graph.Search, universeId, query),
    node: (universeId: string, nodeId: string) => invoke(IPC.Graph.Node, universeId, nodeId),
    path: (universeId: string, a: string, b: string, maxHops?: number) =>
      invoke(IPC.Graph.Path, universeId, a, b, maxHops),
    consolidate: (universeId: string) => invoke(IPC.Graph.Consolidate, universeId),
    cancelConsolidation: (universeId: string) => invoke(IPC.Graph.CancelConsolidation, universeId),
  },
  memory: {
    list: (universeId: string) => invoke(IPC.Memory.List, universeId),
    update: (id: string, patch: unknown) => invoke(IPC.Memory.Update, id, patch),
    delete: (id: string) => invoke(IPC.Memory.Delete, id),
  },
  documents: {
    getExcerpt: (universeId: string, sourceId: string) =>
      invoke(IPC.Documents.GetExcerpt, universeId, sourceId),
    readOriginal: (fileId: string) => invoke(IPC.Documents.ReadOriginal, fileId),
  },
  events: {
    onIngestion: (cb: (payload: unknown) => void) => on(IPC.Events.IngestionProgress, cb),
    onChatChunk: (cb: (payload: unknown) => void) => on(IPC.Events.ChatChunk, cb),
    onChatToolCall: (cb: (payload: unknown) => void) => on(IPC.Events.ChatToolCall, cb),
    onChatDone: (cb: (payload: unknown) => void) => on(IPC.Events.ChatDone, cb),
    onChatError: (cb: (payload: unknown) => void) => on(IPC.Events.ChatError, cb),
    onUniverseChanged: (cb: (payload: unknown) => void) => on(IPC.Events.UniverseChanged, cb),
    onGraphConsolidation: (cb: (payload: unknown) => void) => on(IPC.Events.GraphConsolidation, cb),
    onWebCrawl: (cb: (payload: unknown) => void) => on(IPC.Events.WebCrawlProgress, cb),
  },
};

contextBridge.exposeInMainWorld("api", api);

export type RagraphApi = typeof api;
