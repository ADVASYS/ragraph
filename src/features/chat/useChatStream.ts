import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SourceRef, ToolInvocation } from "@shared/types";

export function useChatStream(chatId: string | null, universeId: string | null) {
  const [streamingText, setStreamingText] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolInvocation[]>([]);
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const queryClient = useQueryClient();
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    const offChunk = api.events.onChatChunk((raw) => {
      const payload = raw as { chatId: string; delta: string };
      if (payload.chatId !== chatId) return;
      setStreamingText((prev) => prev + payload.delta);
    });
    const offTool = api.events.onChatToolCall((raw) => {
      const payload = raw as { chatId: string; invocation: ToolInvocation };
      if (payload.chatId !== chatId) return;
      setStreamingToolCalls((prev) => {
        const idx = prev.findIndex((t) => t.id === payload.invocation.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = payload.invocation;
          return next;
        }
        return [...prev, payload.invocation];
      });
    });
    const offDone = api.events.onChatDone((raw) => {
      const payload = raw as { chatId: string; sources: SourceRef[] };
      if (payload.chatId !== chatId) return;
      setSources(payload.sources ?? []);
      setIsStreaming(false);
      activeRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ["messages", chatId] });
      void queryClient.invalidateQueries({ queryKey: ["chats", universeId] });
      setStreamingText("");
      setStreamingToolCalls([]);
    });
    const offError = api.events.onChatError((raw) => {
      const payload = raw as { chatId: string; message: string };
      if (payload.chatId !== chatId) return;
      setIsStreaming(false);
      activeRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ["messages", chatId] });
    });
    return () => {
      offChunk();
      offTool();
      offDone();
      offError();
    };
  }, [chatId, queryClient, universeId]);

  const startSend = useCallback(
    async (
      content: string,
      attachments?: Array<{ name: string; path: string; mime: string; kind: "image" | "file" }>,
    ) => {
      if (!chatId || isStreaming) return;
      setStreamingText("");
      setStreamingToolCalls([]);
      setSources([]);
      setIsStreaming(true);
      activeRef.current = chatId;
      try {
        await api.chat.send({ chatId, content, attachments });
      } catch (err) {
        setIsStreaming(false);
        activeRef.current = null;
      }
      void queryClient.invalidateQueries({ queryKey: ["messages", chatId] });
    },
    [chatId, isStreaming, queryClient],
  );

  const stop = useCallback(async () => {
    if (!chatId) return;
    await api.chat.stop(chatId);
    setIsStreaming(false);
  }, [chatId]);

  return { streamingText, streamingToolCalls, sources, isStreaming, startSend, stop };
}
