import type {
  AgentMemoryEntry,
  AppSettings,
  ChatMessage,
  ChatSummary,
  DocumentContent,
  DocumentExcerpt,
  FolderMount,
  GraphSnapshot,
  IndexedFile,
  ModelInfo,
  ProviderConfig,
  Universe,
  UniverseStats,
} from "@shared/types";

export interface RagraphApi {
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
    testProvider(config: Pick<ProviderConfig, "baseUrl" | "apiKey">): Promise<{ ok: boolean; message: string }>;
    fetchModels(config: Pick<ProviderConfig, "baseUrl" | "apiKey">): Promise<ModelInfo[]>;
  };
  universes: {
    list(): Promise<Universe[]>;
    create(input: { name: string; description?: string; color?: string }): Promise<string>;
    update(id: string, patch: Partial<Universe>): Promise<void>;
    delete(id: string): Promise<void>;
    stats(id: string): Promise<UniverseStats>;
  };
  mounts: {
    list(universeId: string): Promise<FolderMount[]>;
    create(input: { universeId: string; path: string; includeGlobs?: string[]; excludeGlobs?: string[] }): Promise<string>;
    update(id: string, patch: Partial<FolderMount>): Promise<void>;
    delete(id: string): Promise<void>;
    rescan(id: string): Promise<void>;
    pickFolder(): Promise<string | null>;
  };
  files: {
    list(universeId: string, filter?: { status?: string | null; search?: string }): Promise<IndexedFile[]>;
    reingest(fileId: string): Promise<void>;
    remove(fileId: string): Promise<void>;
    open(fileId: string): Promise<void>;
    reveal(fileId: string): Promise<void>;
  };
  chat: {
    list(universeId: string | null): Promise<ChatSummary[]>;
    create(input: { universeId: string | null; title?: string }): Promise<string>;
    rename(id: string, title: string): Promise<void>;
    delete(id: string): Promise<void>;
    messages(chatId: string): Promise<ChatMessage[]>;
    send(input: { chatId: string; content: string; attachments?: Array<{ name: string; path: string; mime: string; kind: "image" | "file" }> }): Promise<{ messageId: string; text: string }>;
    stop(chatId: string): Promise<void>;
    branch(messageId: string): Promise<string | null>;
  };
  graph: {
    overview(universeId: string): Promise<GraphSnapshot>;
    neighborhood(universeId: string, nodeId: string, depth?: number): Promise<GraphSnapshot>;
    search(universeId: string, query: string): Promise<unknown>;
    node(universeId: string, nodeId: string): Promise<unknown>;
    path(universeId: string, a: string, b: string, maxHops?: number): Promise<unknown>;
    consolidate(universeId: string): Promise<{ ok: boolean }>;
    cancelConsolidation(universeId: string): Promise<{ ok: boolean }>;
  };
  memory: {
    list(universeId: string): Promise<AgentMemoryEntry[]>;
    update(id: string, patch: Partial<AgentMemoryEntry>): Promise<void>;
    delete(id: string): Promise<void>;
  };
  documents: {
    getExcerpt(universeId: string, sourceId: string): Promise<DocumentExcerpt | null>;
    readOriginal(fileId: string): Promise<DocumentContent | null>;
  };
  events: {
    onIngestion(cb: (payload: unknown) => void): () => void;
    onChatChunk(cb: (payload: unknown) => void): () => void;
    onChatToolCall(cb: (payload: unknown) => void): () => void;
    onChatDone(cb: (payload: unknown) => void): () => void;
    onChatError(cb: (payload: unknown) => void): () => void;
    onUniverseChanged(cb: (payload: unknown) => void): () => void;
    onGraphConsolidation(cb: (payload: unknown) => void): () => void;
  };
}

declare global {
  interface Window {
    api: RagraphApi;
  }
}

export const api: RagraphApi = window.api;
