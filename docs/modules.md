# Module development conventions

These rules keep the domain core reusable and testable while the Electron shell stays a thin delivery mechanism. They are **hard rules** for every contribution — CI will reject violations of §1 and §3.

## 1. Core independence (hard rule)

All code in `electron/main/core/**` MUST NOT import Electron or any IPC-facing module. Allowed imports:

- Node.js standard library (`node:fs`, `node:crypto`, `node:path`, `node:stream`, …).
- Database libraries: `better-sqlite3`, `@lancedb/lancedb`, `apache-arrow`.
- LLM / embedding libraries: `ai`, `@ai-sdk/openai-compatible`, `@huggingface/transformers`.
- Pure helpers: `nanoid`, `p-queue`, `zod`, parsers (`pdf-parse`, `mammoth`, `marked`, `gray-matter`, `node-html-parser`), `chokidar`.
- Types from `shared/`.

Integration with Electron — `app`, `safeStorage`, `ipcMain`, `BrowserWindow` — lives exclusively in `electron/main/services/AppContext.ts` and `electron/main/ipc/*.ts`.

**Why?** The core is unit-testable without Electron and can be reused from a CLI or server shell. Breaking this rule typically means a dependency on the lifecycle of the main process, which kills testability.

## 2. Features (renderer)

Each feature lives under `src/features/<name>/` and exposes:

- `<Feature>Screen.tsx` — top-level screen component (routed).
- `<Feature>View.tsx` — embeddable view (optional).
- `use<Feature>*.ts` — feature-local hooks.
- Feature-local sub-components kept in the same folder.

State management:

- **Server / async state** → `@tanstack/react-query`. Queries are keyed by universe id where applicable so cache invalidation on `events:universe-changed` is a one-liner.
- **Global UI state** → `zustand` in `src/app/store.ts`. Keep this store small; it is for UI concerns (active universe, sidebar collapse, theme), not for data that the server owns.
- **Local UI state** → component `useState` / `useReducer`. Do not push transient UI state into Zustand.

## 3. Shared types

- All cross-process DTOs live in `shared/types.ts`.
- All IPC channel identifiers live in `shared/ipc.ts`.
- No runtime side effects in the `shared/` folder — it must be safe to import from both main and renderer at the top level.

## 4. IPC contract

- Handlers live in `electron/main/ipc/<domain>.ts`.
- Use `ipcMain.handle` (request/response) only. One-way channels from renderer to main are forbidden.
- Events to the renderer use `ctx.emit(channel, payload)` and are subscribed via the preload `events` API.
- Every payload matches a type exported from `shared/types.ts`.
- When you add a channel, update [`ipc.md`](./ipc.md) in the same PR.

## 5. UI conventions

- **Icons from `lucide-react` only.** Never use text glyphs, unicode pictograms or emoji for UI affordances. If Lucide is missing an icon, add a Radix-style SVG component next to the feature.
- **i18n for every user-visible string.** Use `const { t } = useTranslation()` and `t("namespace.key")`. Add the key to all four locales in `src/i18n/locales/*.json` — partial translations are rejected in review.
- **Primitives from `src/components/ui/*`.** These are shadcn-style Radix wrappers. If you need a new primitive, keep it unstyled-first and compose with Tailwind classes.
- **Layout tokens.** Follow the 8pt grid (`p-1, p-2, p-3, p-4, p-6, p-8`). Radii are `rounded-md` / `rounded-lg` / `rounded-xl` / `rounded-2xl`. Colors come from the CSS variables in `src/styles/globals.css` — never hardcode hex values.
- **Animation.** Use `motion` from `framer-motion` for meaningful transitions (panel open, dialog enter, toast). Skip animations on dense lists and tables to keep perf high.
- **No placeholder content.** Every control must be wired to real IPC; mockups in the tree slow everyone down.

## 6. Error handling

- **Main process.** Async IPC handlers wrap their body in `try/catch` and throw structured errors. Background jobs (ingestion, consolidation) report errors through events, never unhandled rejections.
- **Renderer.** Mutations use TanStack Query with `onError: (err) => toast.error(err.message)`. Read errors surface as inline messages in the relevant feature, not as global toasts.
- **Ingestion.** Per-file failures are persisted (`files.status = 'failed'`, `files.error`) and emitted via `events:ingestion`. They do not block the queue.

## 7. Logging

- Main process: `electron-log/main.js`. Prefer structured calls: `log.warn("component.event", { key: value })`.
- Renderer: use `console.debug/info/warn/error`. `console.log` should be removed before merging.

## 8. Tests

- Core code ships with Vitest unit tests in `tests/unit/*.test.ts`.
- E2E smoke in `tests/e2e/` uses Playwright with the Electron driver.
- New domain logic in `electron/main/core/**` SHOULD come with a test; PRs that touch `GraphStore`, `EntityResolver`, `GraphConsolidator`, or `VectorStore` MUST update the corresponding test file.

## 9. Commit hygiene

- Small, focused commits. The subject line is imperative and < 72 chars.
- Docs change in the same commit as the code they describe.
- Schema migrations ship with migration SQL in `MetaDatabase` or `GraphStore` — never ad-hoc.

Follow these conventions and the codebase stays legible, swappable, and debuggable as the feature set grows.
