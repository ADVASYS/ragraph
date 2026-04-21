import { Eye, FileText, Hash, StickyNote, Tag } from "lucide-react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useApp } from "@/app/store";
import type { SourceRef } from "@shared/types";
import { cn, truncate } from "@/lib/utils";

const ICONS: Record<SourceRef["kind"], React.ReactNode> = {
  doc_summary: <FileText className="h-3 w-3" />,
  chunk: <FileText className="h-3 w-3" />,
  entity: <Tag className="h-3 w-3" />,
  topic: <Hash className="h-3 w-3" />,
  agent_note: <StickyNote className="h-3 w-3" />,
};

export function SourceChip({ source }: { source: SourceRef }) {
  const setActiveSource = useApp((s) => s.setActiveSource);
  const activeSource = useApp((s) => s.activeSource);
  const isActive = activeSource?.id === source.id;

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            onClick={() => setActiveSource(source)}
            className={cn(
              "group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
              isActive
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border bg-white text-foreground/80 hover:border-primary/40 hover:bg-primary/5 hover:text-primary",
            )}
          >
            {ICONS[source.kind]}
            <span className="max-w-[180px] truncate">{truncate(source.title, 36)}</span>
            {source.universeName && (
              <span className="hidden sm:inline text-[10px] text-muted-foreground">· {source.universeName}</span>
            )}
            <Eye className="h-3 w-3 opacity-60 group-hover:opacity-100" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="max-w-sm z-50 rounded-xl bg-zinc-900 text-white px-3 py-2 text-xs shadow-lg"
            side="top"
            sideOffset={6}
          >
            <div className="font-semibold mb-1">{source.title}</div>
            {source.snippet && <div className="text-zinc-300 line-clamp-5">{source.snippet}</div>}
            <div className="mt-1.5 text-[10px] text-zinc-400">Click to show exact excerpt</div>
            <Tooltip.Arrow className="fill-zinc-900" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
