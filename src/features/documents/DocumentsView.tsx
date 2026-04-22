import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Folder,
  FolderPlus,
  Plus,
  RefreshCw,
  Search,
  ExternalLink,
  FolderOpen,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  File as FileIcon,
  Globe,
  Link as LinkIcon,
  Ban,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Card } from "@/components/ui/misc";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import type {
  FileStatus,
  IndexedFile,
  IngestionProgress,
  WebCrawlProgress,
  WebSource,
} from "@shared/types";
import { CreateWebSourceDialog } from "./CreateWebSourceDialog";

export function DocumentsView({ universeId }: { universeId: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<FileStatus | null>(null);
  const [search, setSearch] = useState("");
  const [progress, setProgress] = useState<Record<string, IngestionProgress>>({});
  const [webProgress, setWebProgress] = useState<Record<string, WebCrawlProgress>>({});
  const [webDialogOpen, setWebDialogOpen] = useState(false);

  const { data: mounts = [] } = useQuery({
    queryKey: ["mounts", universeId],
    queryFn: () => api.mounts.list(universeId),
  });

  const { data: webSources = [] } = useQuery({
    queryKey: ["webSources", universeId],
    queryFn: () => api.webSources.list(universeId),
  });

  const { data: files = [] } = useQuery({
    queryKey: ["files", universeId, statusFilter, search],
    queryFn: () => api.files.list(universeId, { status: statusFilter, search }),
  });

  useEffect(() => {
    const off = api.events.onIngestion((raw) => {
      const p = raw as IngestionProgress;
      if (p.universeId !== universeId) return;
      setProgress((prev) => ({ ...prev, [p.fileId]: p }));
      if (p.phase === "done" || p.phase === "error") {
        void queryClient.invalidateQueries({ queryKey: ["files", universeId] });
      }
    });
    return () => off();
  }, [universeId, queryClient]);

  useEffect(() => {
    const off = api.events.onWebCrawl((raw) => {
      const p = raw as WebCrawlProgress;
      if (p.universeId !== universeId) return;
      setWebProgress((prev) => ({ ...prev, [p.sourceId]: p }));
      if (p.phase === "done" || p.phase === "error") {
        void queryClient.invalidateQueries({ queryKey: ["webSources", universeId] });
        void queryClient.invalidateQueries({ queryKey: ["files", universeId] });
      }
    });
    return () => off();
  }, [universeId, queryClient]);

  const addMountMutation = useMutation({
    mutationFn: async () => {
      const path = await api.mounts.pickFolder();
      if (!path) return;
      return await api.mounts.create({ universeId, path });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mounts", universeId] });
      toast.success(t("documents.mounts") + " ✓");
    },
  });

  const removeMountMutation = useMutation({
    mutationFn: (id: string) => api.mounts.delete(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mounts", universeId] }),
  });

  const rescanMutation = useMutation({
    mutationFn: (id: string) => api.mounts.rescan(id),
    onSuccess: () => toast.success(t("documents.rescan") + " ✓"),
  });

  const reingestMutation = useMutation({
    mutationFn: (id: string) => api.files.reingest(id),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.files.remove(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["files", universeId] }),
  });

  const removeWebSourceMutation = useMutation({
    mutationFn: (id: string) => api.webSources.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webSources", universeId] });
      void queryClient.invalidateQueries({ queryKey: ["files", universeId] });
    },
  });

  const rescanWebSourceMutation = useMutation({
    mutationFn: (id: string) => api.webSources.rescan(id),
    onSuccess: () => toast.success(t("documents.webSources.rescanToast")),
  });

  const cancelWebScanMutation = useMutation({
    mutationFn: (id: string) => api.webSources.cancelScan(id),
  });

  return (
    <div className="h-full flex">
      <aside className="w-[320px] flex-shrink-0 border-r border-border/60 bg-white/40 p-4 space-y-5 overflow-y-auto">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              {t("documents.mounts")}
            </div>
            <Button size="icon-sm" variant="ghost" onClick={() => addMountMutation.mutate()}>
              <FolderPlus className="h-4 w-4" />
            </Button>
          </div>
          {mounts.length === 0 ? (
            <Card className="p-4 text-center">
              <Folder className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
              <div className="text-xs text-muted-foreground">{t("documents.emptyMounts")}</div>
              <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => addMountMutation.mutate()}>
                <Plus className="h-4 w-4" /> {t("documents.addMount")}
              </Button>
            </Card>
          ) : (
            <div className="space-y-2">
              {mounts.map((m) => (
                <Card key={m.id} className="p-3 text-xs">
                  <div className="flex items-start gap-2">
                    <Folder className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[11px] truncate" title={m.path}>
                        {m.path}
                      </div>
                      <div className="flex items-center gap-1 mt-2">
                        <Button size="icon-sm" variant="ghost" onClick={() => rescanMutation.mutate(m.id)}>
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(t("common.delete") + "?")) removeMountMutation.mutate(m.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              {t("documents.webSources.title")}
            </div>
            <Button size="icon-sm" variant="ghost" onClick={() => setWebDialogOpen(true)}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {webSources.length === 0 ? (
            <Card className="p-4 text-center">
              <Globe className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
              <div className="text-xs text-muted-foreground">{t("documents.webSources.empty")}</div>
              <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => setWebDialogOpen(true)}>
                <Plus className="h-4 w-4" /> {t("documents.webSources.addSource")}
              </Button>
            </Card>
          ) : (
            <div className="space-y-2">
              {webSources.map((source) => (
                <WebSourceCard
                  key={source.id}
                  source={source}
                  progress={webProgress[source.id]}
                  onRescan={() => rescanWebSourceMutation.mutate(source.id)}
                  onCancel={() => cancelWebScanMutation.mutate(source.id)}
                  onRemove={() => {
                    if (confirm(t("documents.webSources.deleteConfirm"))) {
                      removeWebSourceMutation.mutate(source.id);
                    }
                  }}
                  lang={i18n.language}
                />
              ))}
            </div>
          )}
        </section>
      </aside>

      <CreateWebSourceDialog open={webDialogOpen} onOpenChange={setWebDialogOpen} universeId={universeId} />

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 bg-white/40">
          <div className="relative flex-1 max-w-md">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              placeholder={t("documents.filters.search") as string}
            />
          </div>
          <div className="flex items-center gap-1">
            {(["pending", "processing", "indexed", "failed"] as FileStatus[]).map((s) => (
              <button
                key={s}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  statusFilter === s ? "bg-primary text-primary-foreground" : "hover:bg-secondary text-muted-foreground",
                )}
                onClick={() => setStatusFilter(statusFilter === s ? null : s)}
              >
                {t(`documents.status.${s}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {files.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              {t("documents.empty")}
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {files.map((f) => (
                <FileRow
                  key={f.id}
                  file={f}
                  progress={progress[f.id]}
                  onReingest={() => reingestMutation.mutate(f.id)}
                  onRemove={() => removeMutation.mutate(f.id)}
                  onOpen={() => api.files.open(f.id)}
                  onReveal={() => api.files.reveal(f.id)}
                  lang={i18n.language}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileRow({
  file,
  progress,
  onReingest,
  onRemove,
  onOpen,
  onReveal,
  lang,
}: {
  file: IndexedFile;
  progress?: IngestionProgress;
  onReingest: () => void;
  onRemove: () => void;
  onOpen: () => void;
  onReveal: () => void;
  lang: string;
}) {
  const { t } = useTranslation();
  const status = progress?.status ?? file.status;
  const isWeb = Boolean(file.webSourceId);
  const displayLabel = file.webUrl ?? file.relPath;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/40 transition-colors">
      {isWeb ? (
        <LinkIcon className="h-4 w-4 text-primary flex-shrink-0" />
      ) : (
        <FileIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate" title={displayLabel}>
          {displayLabel}
        </div>
        <div className="text-[11px] text-muted-foreground truncate">
          {formatBytes(file.size)} · {formatDate(file.ingestedAt ?? file.mtime, lang)}
        </div>
        {progress && progress.phase !== "done" && progress.phase !== "error" && (
          <ProgressBlock progress={progress} />
        )}
      </div>
      <StatusBadge status={status as FileStatus} />
      <div className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onOpen}
          title={isWeb ? t("documents.openUrl") : t("documents.open")}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
        {!isWeb && (
          <Button size="icon-sm" variant="ghost" onClick={onReveal} title={t("documents.reveal")}>
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" onClick={onReingest} title={t("documents.reingest")}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => {
            if (confirm(t("common.delete") + "?")) onRemove();
          }}
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>
    </div>
  );
}

function ProgressBlock({ progress }: { progress: IngestionProgress }) {
  const { t } = useTranslation();
  const phaseLabel = t(`documents.ingest.phase.${progress.phase}`);
  const detail = buildProgressDetail(progress, t);

  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/80">{phaseLabel}</span>
        <span className="tabular-nums">{detail}</span>
      </div>
      <div className="h-1 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${Math.max(2, Math.min(100, progress.percent))}%` }}
        />
      </div>
    </div>
  );
}

function buildProgressDetail(
  p: IngestionProgress,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (p.phase === "parse" && p.pages) {
    parts.push(t("documents.ingest.pages", { count: p.pages }));
  }
  if (p.phase === "chunk" && p.total) {
    parts.push(t("documents.ingest.chunks", { count: p.total }));
  }
  if (p.phase === "analyze" && p.step && p.total) {
    const label = p.message === "structure"
      ? t("documents.ingest.analyzeStructure")
      : t("documents.ingest.analyzeSlice", { step: p.step, total: p.total });
    parts.push(label);
  } else if (p.phase === "analyze" && p.message === "structure") {
    parts.push(t("documents.ingest.analyzeStructure"));
  }
  if (p.phase === "embed" && p.total) {
    parts.push(t("documents.ingest.embedStep", { step: p.step ?? 0, total: p.total }));
  }
  if (p.phase === "graph" && p.total) {
    parts.push(t("documents.ingest.graph"));
  }
  parts.push(`${p.percent}%`);
  return parts.join(" · ");
}

function WebSourceCard({
  source,
  progress,
  onRescan,
  onCancel,
  onRemove,
  lang,
}: {
  source: WebSource;
  progress?: WebCrawlProgress;
  onRescan: () => void;
  onCancel: () => void;
  onRemove: () => void;
  lang: string;
}) {
  const { t } = useTranslation();
  const active = progress && progress.phase !== "done" && progress.phase !== "error";
  const status = active ? "crawling" : source.status;
  const host = safeHost(source.url);
  const pct = progress
    ? Math.max(
        2,
        Math.min(
          100,
          Math.round(
            (progress.pagesFetched + progress.pagesSkipped + progress.pagesFailed) /
              Math.max(1, Math.min(progress.pagesDiscovered || progress.maxPages, progress.maxPages)) *
              100,
          ),
        ),
      )
    : 0;

  return (
    <Card className="p-3 text-xs">
      <div className="flex items-start gap-2">
        <Globe className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[12px] truncate" title={source.url}>
            {host}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground truncate" title={source.url}>
            {source.url}
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <Badge variant={status === "error" ? "danger" : status === "crawling" ? "default" : "secondary"} className="gap-1">
              {status === "crawling" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : status === "error" ? (
                <AlertCircle className="h-3 w-3" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              {t(`documents.webSources.status.${status}`)}
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              {t(`documents.webSources.scope.${source.scope}.badge`)}
            </span>
          </div>

          {active && progress && (
            <div className="mt-2 space-y-1">
              <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span className="font-medium text-foreground/80">{t(`documents.webSources.phase.${progress.phase}`)}</span>
                <span className="tabular-nums">
                  {progress.pagesFetched}/{Math.max(progress.pagesDiscovered, 1)}
                </span>
              </div>
              <div className="h-1 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
              {progress.currentUrl && (
                <div className="text-[10px] font-mono text-muted-foreground truncate" title={progress.currentUrl}>
                  {progress.currentUrl}
                </div>
              )}
            </div>
          )}

          {!active && source.lastScanAt && (
            <div className="text-[10px] text-muted-foreground mt-1.5">
              {t("documents.webSources.lastScan")}: {formatDate(source.lastScanAt, lang)}
            </div>
          )}
          {source.error && !active && (
            <div className="text-[10px] text-destructive mt-1 break-words">{source.error}</div>
          )}

          <div className="flex items-center gap-1 mt-2">
            {active ? (
              <Button size="icon-sm" variant="ghost" onClick={onCancel} title={t("documents.webSources.cancel")}>
                <Ban className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button size="icon-sm" variant="ghost" onClick={onRescan} title={t("documents.webSources.rescan")}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" onClick={onRemove} title={t("common.delete")}>
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function StatusBadge({ status }: { status: FileStatus }) {
  const { t } = useTranslation();
  const cfg = {
    pending: { icon: <Clock className="h-3 w-3" />, variant: "secondary" as const },
    processing: { icon: <Loader2 className="h-3 w-3 animate-spin" />, variant: "default" as const },
    indexed: { icon: <CheckCircle2 className="h-3 w-3" />, variant: "success" as const },
    failed: { icon: <AlertCircle className="h-3 w-3" />, variant: "danger" as const },
    stale: { icon: <Clock className="h-3 w-3" />, variant: "warning" as const },
    deleted: { icon: <Trash2 className="h-3 w-3" />, variant: "outline" as const },
  }[status];
  return (
    <Badge variant={cfg.variant} className="gap-1">
      {cfg.icon}
      {t(`documents.status.${status}`)}
    </Badge>
  );
}
