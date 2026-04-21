import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Network, Files, Brain, Settings2, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/misc";
import { ChatView } from "@/features/chat/ChatView";
import { GraphBrowser } from "@/features/graph-browser/GraphBrowser";
import { DocumentsView } from "@/features/documents/DocumentsView";
import { MemoryView } from "@/features/memory/MemoryView";

export function UniverseScreen({
  route,
}: {
  route: { name: "universe"; universeId: string; tab: "chat" | "graph" | "documents" | "memory" | "settings"; chatId?: string };
}) {
  const { t } = useTranslation();
  const setRoute = useApp((s) => s.setRoute);
  const queryClient = useQueryClient();

  const { data: universes = [] } = useQuery({
    queryKey: ["universes"],
    queryFn: () => api.universes.list(),
  });
  const universe = universes.find((u) => u.id === route.universeId);

  const deleteMutation = useMutation({
    mutationFn: () => api.universes.delete(route.universeId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["universes"] });
      setRoute({ name: "universes" });
    },
  });

  if (!universe) return null;

  const tabs = [
    { id: "chat", icon: <MessageSquare className="h-4 w-4" />, label: t("universe.tabs.chat") },
    { id: "graph", icon: <Network className="h-4 w-4" />, label: t("universe.tabs.graph") },
    { id: "documents", icon: <Files className="h-4 w-4" />, label: t("universe.tabs.documents") },
    { id: "memory", icon: <Brain className="h-4 w-4" />, label: t("universe.tabs.memory") },
    { id: "settings", icon: <Settings2 className="h-4 w-4" />, label: t("universe.tabs.settings") },
  ] as const;

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-4 px-6 py-4 border-b border-border/60 bg-white/60 backdrop-blur-sm">
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: universe.color }} />
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold truncate">{universe.name}</div>
          {universe.description && (
            <div className="text-xs text-muted-foreground truncate">{universe.description}</div>
          )}
        </div>
        <Tabs
          value={route.tab}
          onValueChange={(v) =>
            setRoute({ name: "universe", universeId: route.universeId, tab: v as typeof route.tab })
          }
        >
          <TabsList>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                <span className="flex items-center gap-2">
                  {tab.icon}
                  {tab.label}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      <div className="flex-1 min-h-0 overflow-hidden">
        <Tabs value={route.tab} className="h-full flex flex-col">
          <TabsContent value="chat" className="flex-1 min-h-0 m-0">
            <ChatView key={`chat-${route.universeId}-${route.chatId ?? "new"}`} universeId={route.universeId} chatId={route.chatId} />
          </TabsContent>
          <TabsContent value="graph" className="flex-1 min-h-0 m-0">
            <GraphBrowser universeId={route.universeId} />
          </TabsContent>
          <TabsContent value="documents" className="flex-1 min-h-0 m-0">
            <DocumentsView universeId={route.universeId} />
          </TabsContent>
          <TabsContent value="memory" className="flex-1 min-h-0 m-0">
            <MemoryView universeId={route.universeId} />
          </TabsContent>
          <TabsContent value="settings" className="flex-1 min-h-0 overflow-auto m-0">
            <UniverseSettings universeId={route.universeId} onDelete={() => deleteMutation.mutate()} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function UniverseSettings({ universeId: _universeId, onDelete }: { universeId: string; onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="max-w-2xl mx-auto p-8">
      <div className="card-elevated p-6">
        <h3 className="text-base font-semibold mb-1">{t("common.delete")}</h3>
        <p className="text-sm text-muted-foreground mb-4">{t("universe.deleteConfirm")}</p>
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm(t("universe.deleteConfirm"))) onDelete();
          }}
        >
          <Trash2 className="h-4 w-4" /> {t("common.delete")}
        </Button>
      </div>
    </div>
  );
}
