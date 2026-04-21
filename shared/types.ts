/**
 * Shared types used across the main and renderer processes.
 * Keep free from runtime dependencies so both environments can import safely.
 */

export type Language = "en" | "de" | "fr" | "es";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  visionModel?: string | null;
  embeddingMode: "local" | "remote";
  embeddingModel?: string | null;
  embeddingBaseUrl?: string | null;
  embeddingApiKey?: string | null;
}

export interface AgentSettings {
  /** Maximum number of reasoning/tool steps per agent turn. */
  maxSteps: number;
  /** Per-tool execution timeout in milliseconds (0 disables the timeout). */
  toolTimeoutMs: number;
  /** Maximum sources kept in the chat's citation list. */
  maxSources: number;
  /** Enable detection of repeating tool calls and abort the turn with a notice. */
  loopDetection: boolean;
}

export interface GraphSettings {
  /** Enable hybrid (BM25 + Vector) retrieval fusion in vectorSearch. */
  hybridEnabled: boolean;
  /** Enable graph-expansion of the top fused hits. */
  graphExpansionEnabled: boolean;
  /** Hop depth for graph expansion (0..2). */
  graphExpansionDepth: number;
  /** Global weight used when boosting scores during graph expansion. */
  graphExpansionWeight: number;
  /** Cosine threshold above which two entities are merged during resolution. */
  entityMergeThreshold: number;
  /** Cosine threshold above which two topics are considered equivalent. */
  topicMergeThreshold: number;
  /** Cosine threshold for cross-document REFERENCES_DOC edges. */
  referenceMatchThreshold: number;
}

export interface AppSettings {
  language: Language;
  provider: ProviderConfig | null;
  onboardingComplete: boolean;
  concurrency: number;
  autoIngest: boolean;
  agent: AgentSettings;
  graph: GraphSettings;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxSteps: 12,
  toolTimeoutMs: 30_000,
  maxSources: 40,
  loopDetection: true,
};

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  hybridEnabled: true,
  graphExpansionEnabled: true,
  graphExpansionDepth: 1,
  graphExpansionWeight: 0.4,
  entityMergeThreshold: 0.88,
  topicMergeThreshold: 0.82,
  referenceMatchThreshold: 0.72,
};

export interface Universe {
  id: string;
  name: string;
  description: string | null;
  color: string;
  createdAt: number;
  updatedAt: number;
  stats?: UniverseStats;
}

export interface UniverseStats {
  documents: number;
  entities: number;
  topics: number;
  chunks: number;
  lastSyncAt: number | null;
}

export interface FolderMount {
  id: string;
  universeId: string;
  path: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  enabled: boolean;
  lastScanAt: number | null;
}

export type FileStatus =
  | "pending"
  | "processing"
  | "indexed"
  | "failed"
  | "stale"
  | "deleted";

export interface IndexedFile {
  id: string;
  universeId: string;
  mountId: string;
  absPath: string;
  relPath: string;
  mtime: number;
  size: number;
  hash: string | null;
  status: FileStatus;
  error: string | null;
  ingestedAt: number | null;
}

export interface ChatSummary {
  id: string;
  universeId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface SourceRef {
  id: string;
  kind: "doc_summary" | "chunk" | "entity" | "topic" | "agent_note";
  title: string;
  universeId: string;
  universeName?: string;
  fileId?: string | null;
  filePath?: string | null;
  graphNodeId?: string | null;
  snippet?: string;
  score?: number;
}

export interface ToolInvocation {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: ChatRole;
  content: string;
  reasoning?: string;
  toolCalls?: ToolInvocation[];
  sources?: SourceRef[];
  attachments?: Attachment[];
  createdAt: number;
}

export interface Attachment {
  id: string;
  kind: "image" | "file";
  mime: string;
  name: string;
  path: string;
  size: number;
}

export interface AgentMemoryEntry {
  id: string;
  universeId: string;
  kind: "note" | "insight" | "preference" | "fact";
  content: string;
  reason: string | null;
  strength: number;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface IngestionProgress {
  universeId: string;
  fileId: string;
  relPath: string;
  status: FileStatus;
  phase: "parse" | "chunk" | "analyze" | "embed" | "graph" | "done" | "error";
  percent: number;
  /** Current step within the phase (1-based), e.g. analyze slice 2 / 5 or embed batch 3 / 8. */
  step?: number;
  /** Total steps within the phase when known. */
  total?: number;
  /** Page count reported by the parser (PDFs). */
  pages?: number;
  /** Extracted character count after parsing. */
  chars?: number;
  message?: string;
}

export interface ModelInfo {
  id: string;
  created?: number;
  ownedBy?: string;
}

export interface GraphNodeDTO {
  id: string;
  label: string;
  type: "Document" | "Entity" | "Topic" | "Domain" | "Keyword" | "Chunk" | "AgentNote";
  properties: Record<string, unknown>;
}

export interface GraphEdgeDTO {
  id: string;
  source: string;
  target: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface GraphSnapshot {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
}

/**
 * Location of an excerpt within its original file. Everything the viewer needs
 * to jump to — and highlight — the exact passage that supports a citation.
 */
export interface DocumentExcerpt {
  /** The sourceId that was resolved (passthrough for the caller). */
  sourceId: string;
  kind: "chunk" | "document";
  fileId: string;
  absPath: string;
  relPath: string | null;
  mime: string;
  /** Document-level metadata (title for the panel header). */
  title: string;
  /** Heading path leading to the chunk (most specific last). Empty for doc summaries. */
  heading: string[];
  /** Inclusive char offset into the normalized document text. */
  startOffset: number | null;
  /** Exclusive char offset into the normalized document text. */
  endOffset: number | null;
  /** 1-based first page for paged formats (PDF). */
  pageStart: number | null;
  pageEnd: number | null;
  /** The exact excerpt text from the graph store (trimmed to its own-content range). */
  excerpt: string;
  /** Extra characters before / after the excerpt for contextual display. */
  contextBefore: string;
  contextAfter: string;
}

/**
 * Raw/derived content of an original file suitable for rendering in the
 * source viewer. Binary formats (PDF) are returned as base64 so the renderer
 * can feed them into pdf.js; text and markdown are returned as UTF-8 strings.
 */
export interface DocumentContent {
  fileId: string;
  absPath: string;
  mime: string;
  encoding: "utf8" | "base64";
  /** Only set when encoding = "utf8". The canonical LF-normalized text. */
  text?: string;
  /** Only set when encoding = "base64". */
  data?: string;
  /** Total byte size of the original file on disk. */
  size: number;
}
