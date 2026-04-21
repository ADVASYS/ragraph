# IPC contract

The main process and the renderer communicate exclusively through typed IPC channels. Channel identifiers live in [`shared/ipc.ts`](../shared/ipc.ts); payload and response types live in [`shared/types.ts`](../shared/types.ts). The renderer accesses the channels through `window.api`, which is injected by `electron/preload/index.ts` via `contextBridge`.

## Invariants

- Every request/response channel is registered with `ipcMain.handle`. One-way messages from renderer to main do **not** exist.
- Every payload shape is declared in `shared/types.ts` — no ad-hoc untyped objects cross the process boundary.
- Events flow only `main → renderer` and are subscribed via `api.events.on(channel, handler)`.
- Every handler wraps async work in a try/catch and converts errors into IPC rejections with a stable message.

## Channel reference

### Settings

| Channel | Request | Response |
| --- | --- | --- |
| `settings:get` | — | `AppSettings` |
| `settings:update` | `Partial<AppSettings>` | `AppSettings` |
| `settings:test-provider` | `ProviderConfig` | `{ ok: boolean; error?: string }` |
| `settings:fetch-models` | `ProviderConfig` | `ModelInfo[]` |

`settings:update` merges and persists via `safeStorage`. Changing the provider re-initializes the LLM and embedder caches in `AppContext`.

### Universes

| Channel | Purpose |
| --- | --- |
| `universe:list` | List universes with aggregate stats. |
| `universe:create` | Create a new universe (meta row + graph DB + LanceDB collection). |
| `universe:update` | Rename, re-color, re-describe. |
| `universe:delete` | Cascade delete graph, vectors, mounts, chats, messages, attachments. |
| `universe:stats` | Refresh `{ documents, chunks, topics, entities, lastSyncAt }`. |

### Mounts & files

- `mount:list`, `mount:create`, `mount:update`, `mount:delete`, `mount:rescan`, `mount:pick-folder`
- `files:list`, `files:reingest`, `files:remove`, `files:open`, `files:reveal`

`mount:pick-folder` opens an OS-native directory picker in the main process; the renderer cannot trigger dialog opens on its own.

### Documents (source viewer)

| Channel | Purpose |
| --- | --- |
| `documents:get-excerpt` | Resolve a `SourceRef` to an exact `DocumentExcerpt` (heading path, page, offsets, surrounding context). |
| `documents:read-original` | Stream the original file. PDFs return base64; text formats return UTF-8. |

### Chats & messages

- `chat:list`, `chat:create`, `chat:rename`, `chat:delete`
- `chat:messages` — paged list
- `chat:send` — enqueues a new user turn; the agent streams back via events.
- `chat:stop` — aborts the active turn for a chat.
- `chat:branch` — fork a chat at a message id.

### Graph & memory

- `graph:overview`, `graph:neighborhood`, `graph:search`, `graph:node`, `graph:path`
- `graph:consolidate`, `graph:cancel-consolidation`
- `memory:list`, `memory:update`, `memory:delete`

## Events (main → renderer)

Subscribed via `api.events.on(channel, handler)`:

| Channel | Payload | Meaning |
| --- | --- | --- |
| `events:ingestion` | `IngestionProgress` | Phase / percent / step / total for the currently ingesting file. |
| `events:chat-chunk` | `{ chatId, messageId, delta }` | Streaming text delta for the assistant message. |
| `events:chat-tool-call` | `ToolInvocation` | Tool input on start and tool output/error on completion. |
| `events:chat-done` | Final `ChatMessage` | Full message with collected `sources: SourceRef[]`. |
| `events:chat-error` | `{ chatId, messageId, message }` | Stream-level failure. |
| `events:universe-changed` | `{ universeId, kind }` | Invalidate renderer caches for the affected universe. |
| `events:graph-consolidation` | `{ universeId, phase, percent }` | Background consolidator progress. |

Renderer code typically wires these into TanStack Query via `queryClient.invalidateQueries` (for universe/file/graph events) and into the `useChatStream` hook (for chat events).

## Lifecycle of a chat turn

```text
Renderer                   Main                                 LLM / Tools
  │  chat:send                │
  │──────────────────────────▶│
  │                           │ runAgent(...)
  │                           │─────────────▶ streamText
  │                           │◀─────────────  onStepFinish ─── tools
  │   events:chat-tool-call   │─────────────▶
  │◀──────────────────────────│
  │   events:chat-chunk       │─────────────▶
  │◀──────────────────────────│
  │              …            │
  │   events:chat-done        │
  │◀──────────────────────────│
```

The renderer renders text deltas into the active assistant bubble, appends tool-call timelines as they arrive, and finalizes the message (with citation chips) on `chat-done`.

## Extending the contract

1. Add a channel identifier to `shared/ipc.ts`.
2. Add request/response types to `shared/types.ts`.
3. Implement the handler in `electron/main/ipc/<domain>.ts`.
4. Expose it in `electron/preload/index.ts` if it is meant for the renderer.
5. Add it to this document in the same PR.

Follow this order — skipping step 5 is how docs drift.
