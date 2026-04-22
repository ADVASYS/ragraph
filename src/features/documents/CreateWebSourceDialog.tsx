import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Globe, Loader2, Link as LinkIcon, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label, Switch } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { WebPagePreview, WebSourceScope } from "@shared/types";
import { cn } from "@/lib/utils";

interface CreateWebSourceDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  universeId: string;
}

export function CreateWebSourceDialog({ open, onOpenChange, universeId }: CreateWebSourceDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<WebSourceScope>("site");
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxPages, setMaxPages] = useState(100);
  const [sameOrigin, setSameOrigin] = useState(true);
  const [refreshHours, setRefreshHours] = useState<string>("0");
  const [includeInput, setIncludeInput] = useState("");
  const [excludeInput, setExcludeInput] = useState("");
  const [preview, setPreview] = useState<WebPagePreview | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  const includePatterns = splitPatterns(includeInput);
  const excludePatterns = splitPatterns(excludeInput);

  const reset = () => {
    setUrl("");
    setScope("site");
    setMaxDepth(2);
    setMaxPages(100);
    setSameOrigin(true);
    setRefreshHours("0");
    setIncludeInput("");
    setExcludeInput("");
    setPreview(null);
    setUrlError(null);
  };

  const isValidUrl = /^https?:\/\/[^\s]+\.[^\s]+$/i.test(url.trim());

  const testMutation = useMutation({
    mutationFn: () => api.webSources.testUrl(url.trim()),
    onSuccess: (p) => {
      setPreview(p);
      setUrlError(null);
    },
    onError: (err: unknown) => {
      setPreview(null);
      setUrlError((err as Error).message || String(err));
    },
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.webSources.create({
        universeId,
        url: url.trim(),
        scope,
        maxDepth,
        maxPages,
        sameOrigin,
        includePatterns,
        excludePatterns,
        refreshIntervalHours: Number(refreshHours) > 0 ? Number(refreshHours) : null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webSources", universeId] });
      toast.success(t("documents.webSources.createdToast"));
      onOpenChange(false);
      reset();
    },
    onError: (err: unknown) => {
      toast.error((err as Error).message || String(err));
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-primary" />
            {t("documents.webSources.addSource")}
          </DialogTitle>
          <DialogDescription>{t("documents.webSources.addDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2 max-h-[65vh] overflow-y-auto pr-1">
          <div>
            <Label>{t("documents.webSources.url")}</Label>
            <div className="flex gap-2 mt-1.5">
              <div className="relative flex-1">
                <LinkIcon className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setPreview(null);
                    setUrlError(null);
                  }}
                  placeholder="https://example.com/docs"
                  className="pl-8"
                  autoFocus
                />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={!isValidUrl || testMutation.isPending}
                onClick={() => testMutation.mutate()}
              >
                {testMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                {t("documents.webSources.testUrl")}
              </Button>
            </div>
            {urlError && <p className="text-xs text-destructive mt-1.5">{urlError}</p>}
            {preview && (
              <div className="mt-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-xs space-y-1">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                  {t("documents.webSources.previewTitle")}
                </div>
                <div className="text-[13px] font-semibold">{preview.title}</div>
                {preview.byline && <div className="text-muted-foreground">{preview.byline}</div>}
                <div className="text-muted-foreground line-clamp-3">{preview.excerpt}</div>
                <div className="text-[10px] text-muted-foreground/80 pt-1 font-mono">
                  {preview.markdownLength.toLocaleString()} chars · {preview.lang ?? "—"}
                </div>
              </div>
            )}
          </div>

          <div>
            <Label>{t("documents.webSources.scope.label")}</Label>
            <div className="grid grid-cols-3 gap-2 mt-1.5">
              {(["single", "site", "sitemap"] as WebSourceScope[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-xs font-medium transition-colors text-left",
                    scope === s
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/60 hover:border-primary/40 hover:bg-muted/40",
                  )}
                >
                  <div className="font-semibold">{t(`documents.webSources.scope.${s}.label`)}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5 font-normal">
                    {t(`documents.webSources.scope.${s}.hint`)}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {scope !== "single" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t("documents.webSources.maxDepth")}</Label>
                <Input
                  type="number"
                  min={0}
                  max={5}
                  value={maxDepth}
                  onChange={(e) => setMaxDepth(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label>{t("documents.webSources.maxPages")}</Label>
                <Input
                  type="number"
                  min={1}
                  max={2000}
                  value={maxPages}
                  onChange={(e) => setMaxPages(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))}
                  className="mt-1.5"
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
            <div>
              <div className="text-sm font-medium">{t("documents.webSources.sameOrigin.label")}</div>
              <div className="text-[11px] text-muted-foreground">{t("documents.webSources.sameOrigin.hint")}</div>
            </div>
            <Switch checked={sameOrigin} onCheckedChange={setSameOrigin} />
          </div>

          <div>
            <Label>{t("documents.webSources.refresh.label")}</Label>
            <Select value={refreshHours} onValueChange={setRefreshHours}>
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">{t("documents.webSources.refresh.manual")}</SelectItem>
                <SelectItem value="24">{t("documents.webSources.refresh.daily")}</SelectItem>
                <SelectItem value="168">{t("documents.webSources.refresh.weekly")}</SelectItem>
                <SelectItem value="720">{t("documents.webSources.refresh.monthly")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div>
              <Label>{t("documents.webSources.includePatterns")}</Label>
              <Input
                value={includeInput}
                onChange={(e) => setIncludeInput(e.target.value)}
                placeholder="/docs/, /blog/"
                className="mt-1.5 font-mono text-xs"
              />
              <p className="text-[10px] text-muted-foreground mt-1">{t("documents.webSources.patternsHint")}</p>
            </div>
            <div>
              <Label>{t("documents.webSources.excludePatterns")}</Label>
              <Input
                value={excludeInput}
                onChange={(e) => setExcludeInput(e.target.value)}
                placeholder="\\.pdf$, /archive/"
                className="mt-1.5 font-mono text-xs"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={createMutation.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!isValidUrl || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("documents.webSources.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Accept comma- or newline-separated regex fragments; trim blanks. */
function splitPatterns(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
