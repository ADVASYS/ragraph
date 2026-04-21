import { useTranslation } from "react-i18next";
import { Binary, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { cn, truncate } from "@/lib/utils";
import type { ChatMessage, SourceRef } from "@shared/types";
import { SourceViewer } from "./SourceViewer";

export function SourcesPanel({ messages }: { messages: ChatMessage[] }) {
  const { t } = useTranslation();
  const open = useApp((s) => s.rightPanelOpen);
  const setOpen = useApp((s) => s.setRightPanelOpen);
  const activeSource = useApp((s) => s.activeSource);
  const setActiveSource = useApp((s) => s.setActiveSource);

  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.sources && m.sources.length);
  const sources: SourceRef[] = last?.sources ?? [];
  const toolCalls = last?.toolCalls ?? [];

  // A broader panel when the viewer is active — the inline document renderer
  // needs real estate so the excerpt + context are legible.
  const width = !open ? "w-[44px]" : activeSource ? "w-[520px]" : "w-[320px]";

  return (
    <aside
      className={cn(
        "border-l border-border/60 bg-white/60 backdrop-blur-sm flex flex-col transition-all flex-shrink-0",
        width,
      )}
    >
      <div className="p-2 border-b border-border/50 flex items-center justify-between">
        {open && (
          <div className="px-2 text-xs uppercase tracking-wide text-muted-foreground font-semibold">
            {activeSource ? t("chat.sourceViewer.title", { defaultValue: "Source" }) : t("chat.sources")}
          </div>
        )}
        <Button size="icon-sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </Button>
      </div>

      {open && activeSource ? (
        <SourceViewer source={activeSource} />
      ) : open ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {sources.length === 0 ? (
            <div className="text-center text-xs text-muted-foreground py-10">
              {t("chat.empty")}
            </div>
          ) : (
            sources.map((s, idx) => (
              <button
                key={s.id}
                onClick={() => setActiveSource(s)}
                className="w-full text-left rounded-xl border border-border/70 bg-white hover:border-primary/40 hover:bg-primary/5 transition-colors px-3 py-2.5 group"
              >
                <div className="flex items-start gap-2">
                  <div className="h-6 w-6 flex-shrink-0 rounded bg-primary/10 text-primary flex items-center justify-center text-[11px] font-semibold">
                    {idx + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium truncate">{s.title}</div>
                    {s.universeName && (
                      <div className="text-[10px] text-muted-foreground">{s.universeName}</div>
                    )}
                    {s.snippet && (
                      <div className="text-[11px] text-muted-foreground mt-1 line-clamp-3">
                        {truncate(s.snippet, 200)}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}

          {toolCalls.length > 0 && (
            <div className="pt-3 mt-3 border-t border-border/60">
              <div className="px-1 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
                {t("chat.toolCalls")}
              </div>
              <div className="space-y-1">
                {toolCalls.map((tc) => (
                  <div key={tc.id} className="flex items-center gap-2 text-[11px] px-2 py-1 rounded bg-muted/50">
                    <Binary className="h-3 w-3 text-primary" />
                    <span className="font-mono">{tc.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
