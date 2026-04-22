/**
 * Channel identifiers for typed IPC communication.
 * Grouped by domain for easier maintenance.
 */

export const IPC = {
  Settings: {
    Get: "settings:get",
    Update: "settings:update",
    TestProvider: "settings:test-provider",
    FetchModels: "settings:fetch-models",
  },
  Universe: {
    List: "universe:list",
    Create: "universe:create",
    Update: "universe:update",
    Delete: "universe:delete",
    Stats: "universe:stats",
  },
  Mount: {
    List: "mount:list",
    Create: "mount:create",
    Update: "mount:update",
    Delete: "mount:delete",
    Rescan: "mount:rescan",
    PickFolder: "mount:pick-folder",
  },
  WebSource: {
    List: "webSource:list",
    Create: "webSource:create",
    Update: "webSource:update",
    Delete: "webSource:delete",
    Rescan: "webSource:rescan",
    CancelScan: "webSource:cancel-scan",
    TestUrl: "webSource:test-url",
  },
  Files: {
    List: "files:list",
    Reingest: "files:reingest",
    Remove: "files:remove",
    Open: "files:open",
    RevealInFolder: "files:reveal",
  },
  Documents: {
    /** Resolve a SourceRef (chunk or doc) into its exact original excerpt. */
    GetExcerpt: "documents:get-excerpt",
    /** Stream-load the original file bytes / text (text formats return raw UTF-8). */
    ReadOriginal: "documents:read-original",
  },
  Chat: {
    List: "chat:list",
    Create: "chat:create",
    Rename: "chat:rename",
    Delete: "chat:delete",
    Messages: "chat:messages",
    Send: "chat:send",
    Stop: "chat:stop",
    Branch: "chat:branch",
  },
  Graph: {
    Overview: "graph:overview",
    Neighborhood: "graph:neighborhood",
    Search: "graph:search",
    Node: "graph:node",
    Path: "graph:path",
    Consolidate: "graph:consolidate",
    CancelConsolidation: "graph:cancel-consolidation",
  },
  Memory: {
    List: "memory:list",
    Update: "memory:update",
    Delete: "memory:delete",
  },
  Events: {
    IngestionProgress: "events:ingestion",
    ChatChunk: "events:chat-chunk",
    ChatToolCall: "events:chat-tool-call",
    ChatDone: "events:chat-done",
    ChatError: "events:chat-error",
    UniverseChanged: "events:universe-changed",
    GraphConsolidation: "events:graph-consolidation",
    WebCrawlProgress: "events:web-crawl",
  },
} as const;

export type IpcChannel = typeof IPC;
