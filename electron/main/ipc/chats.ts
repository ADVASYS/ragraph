import { ipcMain } from "electron";
import { nanoid } from "nanoid";
import { readFile } from "node:fs/promises";
import { IPC } from "../../../shared/ipc";
import type { AppContext } from "../services/AppContext";
import type {
  Attachment,
  ChatMessage,
  ChatSummary,
  SourceRef,
  ToolInvocation,
} from "../../../shared/types";
import type { CoreMessage } from "ai";
import { runAgent } from "../core/rag/Agent";

interface SendInput {
  chatId: string;
  content: string;
  attachments?: Array<{ name: string; path: string; mime: string; kind: "image" | "file" }>;
}

const activeControllers = new Map<string, AbortController>();

export function registerChatHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.Chat.List, (_e, universeId: string | null): ChatSummary[] => {
    const rows = ctx.meta.db
      .prepare(
        `SELECT c.id, c.universe_id as universeId, c.title, c.created_at as createdAt, c.updated_at as updatedAt,
                (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) as messageCount
         FROM chats c
         WHERE ${universeId ? "c.universe_id = ?" : "c.universe_id IS NULL"}
         ORDER BY c.updated_at DESC`,
      )
      .all(...(universeId ? [universeId] : [])) as ChatSummary[];
    return rows;
  });

  ipcMain.handle(IPC.Chat.Create, (_e, input: { universeId: string | null; title?: string }) => {
    const id = nanoid();
    const now = Date.now();
    ctx.meta.db
      .prepare(
        "INSERT INTO chats (id, universe_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, input.universeId, input.title || "New chat", now, now);
    return id;
  });

  ipcMain.handle(IPC.Chat.Rename, (_e, id: string, title: string) => {
    ctx.meta.db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), id);
  });

  ipcMain.handle(IPC.Chat.Delete, (_e, id: string) => {
    ctx.meta.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  });

  ipcMain.handle(IPC.Chat.Messages, (_e, chatId: string): ChatMessage[] => {
    const msgs = ctx.meta.db
      .prepare(
        `SELECT id, chat_id as chatId, role, content, reasoning, tool_calls as toolCalls, sources, created_at as createdAt
         FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
      )
      .all(chatId) as Array<Omit<ChatMessage, "toolCalls" | "sources" | "attachments"> & { toolCalls: string | null; sources: string | null }>;

    const result: ChatMessage[] = msgs.map((m) => ({
      id: m.id,
      chatId: m.chatId,
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      toolCalls: m.toolCalls ? (JSON.parse(m.toolCalls) as ToolInvocation[]) : [],
      sources: m.sources ? (JSON.parse(m.sources) as SourceRef[]) : [],
      createdAt: m.createdAt,
      attachments: [],
    }));

    for (const m of result) {
      const atts = ctx.meta.db
        .prepare(
          "SELECT id, kind, mime, name, path, size FROM attachments WHERE message_id = ?",
        )
        .all(m.id) as Attachment[];
      m.attachments = atts;
    }

    return result;
  });

  ipcMain.handle(IPC.Chat.Send, async (_e, input: SendInput) => {
    const chat = ctx.meta.db
      .prepare("SELECT id, universe_id as universeId FROM chats WHERE id = ?")
      .get(input.chatId) as { id: string; universeId: string | null } | undefined;
    if (!chat) throw new Error("Chat not found");

    const llm = ctx.getLLM();
    if (!llm) throw new Error("No LLM provider configured");

    const now = Date.now();
    const userMessageId = nanoid();
    ctx.meta.db
      .prepare(
        "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
      )
      .run(userMessageId, input.chatId, input.content, now);

    for (const att of input.attachments ?? []) {
      ctx.meta.db
        .prepare(
          "INSERT INTO attachments (id, message_id, kind, mime, name, path, size) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(nanoid(), userMessageId, att.kind, att.mime, att.name, att.path, 0);
    }

    const history = ctx.meta.db
      .prepare(
        `SELECT id, role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
      )
      .all(input.chatId) as Array<{ id: string; role: string; content: string }>;

    const universes = chat.universeId
      ? [await ctx.getUniverseStores(chat.universeId)]
      : await ctx.getAllUniverseStores();
    const bundles = universes.filter(Boolean).map((u) => ({ id: u!.id, name: u!.name, graph: u!.graph, vectors: u!.vectors }));

    const lastUserAttachments = input.attachments ?? [];
    const imageParts = await Promise.all(
      lastUserAttachments
        .filter((a) => a.kind === "image")
        .map(async (a) => ({ type: "image" as const, image: await readFile(a.path) })),
    );

    const messages: CoreMessage[] = history.map((m, idx) => {
      if (idx === history.length - 1 && m.role === "user" && imageParts.length) {
        return {
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...imageParts,
          ],
        } as CoreMessage;
      }
      return { role: m.role as "user" | "assistant" | "system", content: m.content };
    });

    const assistantMessageId = nanoid();
    ctx.meta.db
      .prepare(
        "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'assistant', '', ?)",
      )
      .run(assistantMessageId, input.chatId, Date.now());

    const controller = new AbortController();
    activeControllers.set(input.chatId, controller);

    let fullText = "";
    const toolCalls: ToolInvocation[] = [];

    const appSettings = ctx.getSettings();

    await runAgent({
      messages,
      universes: bundles,
      embedder: ctx.getEmbedder(),
      llm,
      language: appSettings.language,
      signal: controller.signal,
      budget: {
        maxSteps: appSettings.agent.maxSteps,
        toolTimeoutMs: appSettings.agent.toolTimeoutMs,
        maxSources: appSettings.agent.maxSources,
        loopDetection: appSettings.agent.loopDetection,
      },
      retrieval: {
        hybridEnabled: appSettings.graph.hybridEnabled,
        graphExpansionEnabled: appSettings.graph.graphExpansionEnabled,
        graphExpansionDepth: appSettings.graph.graphExpansionDepth,
        graphExpansionWeight: appSettings.graph.graphExpansionWeight,
      },
      saveAgentMemory: async ({ universeId, kind, content, reason, links }) => {
        const id = nanoid();
        ctx.meta.db
          .prepare(
            "INSERT INTO agent_memory (id, universe_id, kind, content, reason, strength, created_at) VALUES (?, ?, ?, ?, ?, 1.0, ?)",
          )
          .run(id, universeId, kind, content, reason, Date.now());
        const stores = await ctx.getUniverseStores(universeId);
        if (stores) {
          try {
            await stores.graph.saveAgentNote(id, content, reason, links);
          } catch {
            // tables may not be present yet
          }
          try {
            const vec = (await ctx.getEmbedder().embed([content], "passage"))[0];
            await stores.vectors.upsertMany([
              {
                id: `vec_mem_${id}`,
                kind: "agent_note",
                source_id: id,
                universe_id: universeId,
                title: kind,
                text: content,
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
        return { id };
      },
      recallAgentMemory: async ({ universeId, query, topK }) => {
        const stores = await ctx.getUniverseStores(universeId);
        if (!stores) return [];
        const vec = (await ctx.getEmbedder().embed([query], "query"))[0];
        const hits = await stores.vectors.search(vec, topK, { kind: "agent_note" });
        return hits.map((h) => ({ id: h.source_id, content: h.text, kind: h.title, score: h.score }));
      },
      onTextDelta: (delta) => {
        fullText += delta;
        ctx.emit(IPC.Events.ChatChunk, { chatId: input.chatId, messageId: assistantMessageId, delta });
      },
      onToolCall: (inv) => {
        const idx = toolCalls.findIndex((t) => t.id === inv.id);
        if (idx >= 0) toolCalls[idx] = inv;
        else toolCalls.push(inv);
        ctx.emit(IPC.Events.ChatToolCall, { chatId: input.chatId, messageId: assistantMessageId, invocation: inv });
      },
      onFinish: ({ text, sources }) => {
        ctx.meta.db
          .prepare(
            "UPDATE messages SET content = ?, tool_calls = ?, sources = ? WHERE id = ?",
          )
          .run(text, JSON.stringify(toolCalls), JSON.stringify(sources), assistantMessageId);
        ctx.meta.db
          .prepare("UPDATE chats SET updated_at = ? WHERE id = ?")
          .run(Date.now(), input.chatId);
        ctx.emit(IPC.Events.ChatDone, { chatId: input.chatId, messageId: assistantMessageId, text, sources, toolCalls });

        const chatRow = ctx.meta.db
          .prepare("SELECT title FROM chats WHERE id = ?")
          .get(input.chatId) as { title: string } | undefined;
        if (chatRow && (chatRow.title === "New chat" || !chatRow.title.trim())) {
          const candidate = input.content.split(/\n/)[0].slice(0, 60).trim() || "New chat";
          ctx.meta.db
            .prepare("UPDATE chats SET title = ? WHERE id = ?")
            .run(candidate, input.chatId);
        }
      },
      onError: (err) => {
        ctx.meta.db
          .prepare("UPDATE messages SET content = ? WHERE id = ?")
          .run(`Error: ${err.message}`, assistantMessageId);
        ctx.emit(IPC.Events.ChatError, { chatId: input.chatId, messageId: assistantMessageId, message: err.message });
      },
    });

    activeControllers.delete(input.chatId);
    return { messageId: assistantMessageId, text: fullText };
  });

  ipcMain.handle(IPC.Chat.Stop, (_e, chatId: string) => {
    const c = activeControllers.get(chatId);
    if (c) c.abort();
    activeControllers.delete(chatId);
  });

  ipcMain.handle(IPC.Chat.Branch, (_e, messageId: string) => {
    const msg = ctx.meta.db.prepare("SELECT chat_id as chatId FROM messages WHERE id = ?").get(messageId) as
      | { chatId: string }
      | undefined;
    if (!msg) return null;
    const chat = ctx.meta.db
      .prepare("SELECT universe_id as universeId, title FROM chats WHERE id = ?")
      .get(msg.chatId) as { universeId: string | null; title: string } | undefined;
    if (!chat) return null;
    const newId = nanoid();
    const now = Date.now();
    ctx.meta.db
      .prepare("INSERT INTO chats (id, universe_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(newId, chat.universeId, `${chat.title} (branch)`, now, now);
    const prior = ctx.meta.db
      .prepare(
        `SELECT id, role, content, tool_calls as toolCalls, sources, created_at as createdAt
         FROM messages WHERE chat_id = ? AND created_at <= (SELECT created_at FROM messages WHERE id = ?) ORDER BY created_at ASC`,
      )
      .all(msg.chatId, messageId) as Array<{ id: string; role: string; content: string; toolCalls: string | null; sources: string | null; createdAt: number }>;
    const insert = ctx.meta.db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, tool_calls, sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const m of prior) {
      insert.run(nanoid(), newId, m.role, m.content, m.toolCalls, m.sources, m.createdAt);
    }
    return newId;
  });
}
