import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Trash2, Pencil, X, Save } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Badge, Card } from "@/components/ui/misc";
import { formatDate } from "@/lib/utils";
import type { AgentMemoryEntry } from "@shared/types";

export function MemoryView({ universeId }: { universeId: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  const { data: entries = [] } = useQuery({
    queryKey: ["memory", universeId],
    queryFn: () => api.memory.list(universeId),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => api.memory.update(id, { content }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["memory", universeId] });
      setEditingId(null);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.memory.delete(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["memory", universeId] }),
  });

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto p-6">
        <div className="flex items-center gap-2 mb-4">
          <Brain className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">{t("memory.title")}</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-6">{t("memory.subtitle")}</p>

        {entries.length === 0 ? (
          <Card className="p-10 text-center">
            <div className="text-sm text-muted-foreground">{t("memory.empty")}</div>
          </Card>
        ) : (
          <div className="space-y-3">
            {entries.map((m: AgentMemoryEntry) => (
              <Card key={m.id} className="p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{t(`memory.kinds.${m.kind}`)}</Badge>
                    <span className="text-[11px] text-muted-foreground">{formatDate(m.createdAt, i18n.language)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {editingId === m.id ? (
                      <>
                        <Button size="icon-sm" variant="ghost" onClick={() => updateMutation.mutate({ id: m.id, content: editContent })}>
                          <Save className="h-4 w-4" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => setEditingId(null)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingId(m.id);
                            setEditContent(m.content);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(t("common.delete") + "?")) deleteMutation.mutate(m.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {editingId === m.id ? (
                  <Textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={4} />
                ) : (
                  <>
                    <div className="text-sm whitespace-pre-wrap">{m.content}</div>
                    {m.reason && (
                      <div className="text-xs text-muted-foreground mt-2 italic">{m.reason}</div>
                    )}
                  </>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
