import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, MessageSquare, Trash2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { MessagesList } from "./MessagesList";
import { MessageComposer } from "./MessageComposer";
import { SourcesPanel } from "./SourcesPanel";
import { useChatStream } from "./useChatStream";
import { useApp } from "@/app/store";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@shared/types";

interface ChatViewProps {
  universeId: string | null;
  chatId?: string;
}

export function ChatView({ universeId }: ChatViewProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  const { data: chats = [] } = useQuery({
    queryKey: ["chats", universeId],
    queryFn: () => api.chat.list(universeId),
  });

  useEffect(() => {
    if (!activeChatId && chats.length) setActiveChatId(chats[0].id);
  }, [chats, activeChatId]);

  // Drop any selected source when the user switches chats — stale IDs would
  // just show a "not found" state in the viewer.
  const setActiveSource = useApp((s) => s.setActiveSource);
  useEffect(() => {
    setActiveSource(null);
  }, [activeChatId, setActiveSource]);

  const createMutation = useMutation({
    mutationFn: () => api.chat.create({ universeId, title: "New chat" }),
    onSuccess: (id) => {
      void queryClient.invalidateQueries({ queryKey: ["chats", universeId] });
      setActiveChatId(id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.chat.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["chats", universeId] });
      setActiveChatId(null);
    },
  });

  const { data: messages = [] } = useQuery({
    queryKey: ["messages", activeChatId],
    queryFn: () => (activeChatId ? api.chat.messages(activeChatId) : Promise.resolve([])),
    enabled: !!activeChatId,
  });

  const {
    streamingText,
    streamingToolCalls,
    sources,
    isStreaming,
    startSend,
    stop,
  } = useChatStream(activeChatId, universeId);

  const composedMessages: ChatMessage[] = React.useMemo(() => {
    if (!isStreaming && !streamingText) return messages;
    return [
      ...messages,
      {
        id: "__streaming__",
        chatId: activeChatId ?? "",
        role: "assistant",
        content: streamingText,
        toolCalls: streamingToolCalls,
        sources,
        createdAt: Date.now(),
        attachments: [],
      } as ChatMessage,
    ];
  }, [messages, streamingText, streamingToolCalls, sources, isStreaming, activeChatId]);

  return (
    <div className="h-full flex">
      <aside className="w-[240px] flex-shrink-0 border-r border-border/60 bg-white/40 flex flex-col">
        <div className="p-3">
          <Button className="w-full" size="sm" onClick={() => createMutation.mutate()}>
            <Plus className="h-4 w-4" /> {t("chat.newChat")}
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          {chats.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm",
                activeChatId === c.id ? "bg-primary/10 text-primary" : "hover:bg-secondary",
              )}
              onClick={() => setActiveChatId(c.id)}
            >
              <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
              <div className="flex-1 truncate text-[13px]">{c.title}</div>
              <button
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(t("common.delete") + "?")) deleteMutation.mutate(c.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex-1 flex min-w-0">
        <div className="flex-1 flex flex-col min-w-0">
          {activeChatId ? (
            <>
              <MessagesList messages={composedMessages} isStreaming={isStreaming} />
              <MessageComposer
                disabled={!activeChatId}
                isStreaming={isStreaming}
                onSend={(content, attachments) => startSend(content, attachments)}
                onStop={stop}
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center p-8">
              <div className="max-w-md">
                <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <MessageSquare className="h-6 w-6 text-primary" />
                </div>
                <div className="text-base font-medium">{t("chat.empty")}</div>
                <Button className="mt-4" onClick={() => createMutation.mutate()}>
                  {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {t("chat.newChat")}
                </Button>
              </div>
            </div>
          )}
        </div>
        <SourcesPanel messages={composedMessages} />
      </div>
    </div>
  );
}
