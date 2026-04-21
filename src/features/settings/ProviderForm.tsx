import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Loader2, Wand2, Globe2, KeyRound, Server, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label, Switch, Card, Separator } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useApp } from "@/app/store";
import type { AppSettings, ModelInfo, ProviderConfig } from "@shared/types";

interface ProviderFormProps {
  onComplete?: () => void;
  compact?: boolean;
}

export function ProviderForm({ onComplete, compact }: ProviderFormProps) {
  const { t } = useTranslation();
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const queryClient = useQueryClient();

  const [config, setConfig] = useState<ProviderConfig>(() => ({
    baseUrl: settings?.provider?.baseUrl ?? "https://api.openai.com/v1",
    apiKey: settings?.provider?.apiKey ?? "",
    chatModel: settings?.provider?.chatModel ?? "",
    visionModel: settings?.provider?.visionModel ?? "",
    embeddingMode: settings?.provider?.embeddingMode ?? "local",
    embeddingModel: settings?.provider?.embeddingModel ?? "text-embedding-3-small",
    embeddingBaseUrl: settings?.provider?.embeddingBaseUrl ?? settings?.provider?.baseUrl ?? "",
    embeddingApiKey: settings?.provider?.embeddingApiKey ?? settings?.provider?.apiKey ?? "",
  }));
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);

  const testMutation = useMutation({
    mutationFn: () => api.settings.testProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey }),
    onSuccess: (res) => setStatus(res),
  });

  const fetchMutation = useMutation({
    mutationFn: async () => {
      const list = await api.settings.fetchModels({ baseUrl: config.baseUrl, apiKey: config.apiKey });
      setModels(list);
      if (list.length && !config.chatModel) setConfig((c) => ({ ...c, chatModel: list[0].id }));
      return list;
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const patch: Partial<AppSettings> = {
        provider: config,
        onboardingComplete: true,
      };
      return await api.settings.update(patch);
    },
    onSuccess: (s) => {
      setSettings(s);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success(t("settings.saved"));
      onComplete?.();
    },
  });

  const update = (patch: Partial<ProviderConfig>) => setConfig((c) => ({ ...c, ...patch }));

  return (
    <div className={compact ? "space-y-4" : "space-y-6"}>
      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-semibold flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" /> {t("settings.provider.title")}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t("settings.provider.description")}
            </div>
          </div>
          <StatusPill status={status} />
        </div>

        <div className="grid grid-cols-1 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Globe2 className="h-3.5 w-3.5" /> {t("settings.provider.baseUrl")}
            </Label>
            <Input
              className="mt-1.5"
              value={config.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
            <p className="text-[11px] text-muted-foreground mt-1">{t("settings.provider.baseUrlHint")}</p>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" /> {t("settings.provider.apiKey")}
            </Label>
            <Input
              className="mt-1.5 font-mono"
              type="password"
              value={config.apiKey}
              onChange={(e) => update({ apiKey: e.target.value })}
              placeholder="sk-…"
            />
            <p className="text-[11px] text-muted-foreground mt-1">{t("settings.provider.apiKeyHint")}</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!config.baseUrl || !config.apiKey || testMutation.isPending}
              onClick={() => testMutation.mutate()}
            >
              {testMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {t("settings.provider.test")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!config.baseUrl || !config.apiKey || fetchMutation.isPending}
              onClick={() => fetchMutation.mutate()}
            >
              {fetchMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {t("settings.provider.fetch")}
            </Button>
          </div>
        </div>

        {models.length > 0 && (
          <>
            <Separator />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">{t("settings.provider.chatModel")}</Label>
                <Select value={config.chatModel} onValueChange={(v) => update({ chatModel: v })}>
                  <SelectTrigger className="mt-1.5">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("settings.provider.visionModel")}</Label>
                <Select value={config.visionModel ?? ""} onValueChange={(v) => update({ visionModel: v || null })}>
                  <SelectTrigger className="mt-1.5">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card className="p-5 space-y-4">
        <div>
          <div className="text-sm font-semibold">{t("settings.provider.embedding.mode")}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{t("settings.provider.embedding.hint")}</div>
        </div>
        <div className="flex gap-2">
          {(["local", "remote"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => update({ embeddingMode: mode })}
              className={`flex-1 rounded-lg border px-3 py-2.5 text-sm text-left transition-colors ${
                config.embeddingMode === mode
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border hover:bg-secondary"
              }`}
            >
              <div className="font-medium">{t(`settings.provider.embedding.${mode}`)}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {mode === "local" ? "multilingual-e5-small · 384d · on device" : "OpenAI-compatible /embeddings"}
              </div>
            </button>
          ))}
        </div>

        {config.embeddingMode === "remote" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">{t("settings.provider.embedding.remoteBaseUrl")}</Label>
              <Input
                className="mt-1.5"
                value={config.embeddingBaseUrl ?? ""}
                onChange={(e) => update({ embeddingBaseUrl: e.target.value })}
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("settings.provider.embedding.remoteApiKey")}</Label>
              <Input
                className="mt-1.5 font-mono"
                type="password"
                value={config.embeddingApiKey ?? ""}
                onChange={(e) => update({ embeddingApiKey: e.target.value })}
              />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs text-muted-foreground">{t("settings.provider.embedding.remoteModel")}</Label>
              <Input
                className="mt-1.5"
                value={config.embeddingModel ?? ""}
                onChange={(e) => update({ embeddingModel: e.target.value })}
                placeholder="text-embedding-3-small"
              />
            </div>
          </div>
        )}
      </Card>

      <div className="flex justify-end">
        <Button
          size="lg"
          onClick={() => saveMutation.mutate()}
          disabled={!config.baseUrl || !config.apiKey || !config.chatModel || saveMutation.isPending}
        >
          {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("settings.save")}
        </Button>
      </div>
    </div>
  );
}

export function IngestionSettings() {
  const { t } = useTranslation();
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);

  if (!settings) return null;

  return (
    <Card className="p-5 space-y-4">
      <div className="text-sm font-semibold">{t("settings.ingestion.title")}</div>
      <div className="flex items-center justify-between">
        <div>
          <Label>{t("settings.ingestion.autoIngest")}</Label>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t("settings.ingestion.autoIngestHint")}</p>
        </div>
        <Switch
          checked={settings.autoIngest}
          onCheckedChange={async (v) => {
            const next = await api.settings.update({ autoIngest: v });
            setSettings(next);
          }}
        />
      </div>
      <div>
        <Label>{t("settings.ingestion.concurrency")}</Label>
        <div className="mt-2 flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={8}
            value={settings.concurrency}
            onChange={async (e) => {
              const next = await api.settings.update({ concurrency: Number(e.target.value) });
              setSettings(next);
            }}
            className="flex-1 accent-indigo-600"
          />
          <div className="w-6 text-center text-sm font-medium">{settings.concurrency}</div>
        </div>
      </div>
    </Card>
  );
}

export function AgentSettingsForm() {
  const { t } = useTranslation();
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);

  if (!settings) return null;

  const agent = settings.agent;

  const update = async (patch: Partial<typeof agent>) => {
    const next = await api.settings.update({ agent: { ...agent, ...patch } });
    setSettings(next);
  };

  return (
    <Card className="p-5 space-y-4">
      <div>
        <div className="text-sm font-semibold">{t("settings.agent.title")}</div>
        <p className="text-[11px] text-muted-foreground mt-0.5">{t("settings.agent.description")}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NumberSliderField
          label={t("settings.agent.maxSteps")}
          hint={t("settings.agent.maxStepsHint")}
          value={agent.maxSteps}
          min={1}
          max={32}
          step={1}
          onChange={(v) => update({ maxSteps: v })}
        />
        <NumberSliderField
          label={t("settings.agent.toolTimeout")}
          hint={t("settings.agent.toolTimeoutHint")}
          value={agent.toolTimeoutMs}
          min={0}
          max={120_000}
          step={1000}
          onChange={(v) => update({ toolTimeoutMs: v })}
        />
        <NumberSliderField
          label={t("settings.agent.maxSources")}
          hint={t("settings.agent.maxSourcesHint")}
          value={agent.maxSources}
          min={5}
          max={200}
          step={5}
          onChange={(v) => update({ maxSources: v })}
        />
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label>{t("settings.agent.loopDetection")}</Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">{t("settings.agent.loopDetectionHint")}</p>
          </div>
          <Switch
            checked={agent.loopDetection}
            onCheckedChange={(v) => void update({ loopDetection: v })}
          />
        </div>
      </div>
    </Card>
  );
}

export function GraphSettingsForm() {
  const { t } = useTranslation();
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const [consolidating, setConsolidating] = useState(false);

  if (!settings) return null;

  const graph = settings.graph;

  const update = async (patch: Partial<typeof graph>) => {
    const next = await api.settings.update({ graph: { ...graph, ...patch } });
    setSettings(next);
  };

  const consolidateAll = async () => {
    setConsolidating(true);
    try {
      const list = await api.universes.list();
      for (const u of list) {
        await api.graph.consolidate(u.id);
      }
      toast.success(t("settings.saved"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConsolidating(false);
    }
  };

  return (
    <Card className="p-5 space-y-4">
      <div>
        <div className="text-sm font-semibold">{t("settings.graph.title")}</div>
        <p className="text-[11px] text-muted-foreground mt-0.5">{t("settings.graph.description")}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label>{t("settings.graph.hybrid")}</Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">{t("settings.graph.hybridHint")}</p>
          </div>
          <Switch checked={graph.hybridEnabled} onCheckedChange={(v) => void update({ hybridEnabled: v })} />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label>{t("settings.graph.expansion")}</Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">{t("settings.graph.expansionHint")}</p>
          </div>
          <Switch
            checked={graph.graphExpansionEnabled}
            onCheckedChange={(v) => void update({ graphExpansionEnabled: v })}
          />
        </div>
        <NumberSliderField
          label={t("settings.graph.expansionDepth")}
          value={graph.graphExpansionDepth}
          min={0}
          max={2}
          step={1}
          onChange={(v) => update({ graphExpansionDepth: v })}
        />
        <NumberSliderField
          label={t("settings.graph.expansionWeight")}
          value={graph.graphExpansionWeight}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => update({ graphExpansionWeight: Number(v.toFixed(2)) })}
        />
        <NumberSliderField
          label={t("settings.graph.entityMerge")}
          hint={t("settings.graph.entityMergeHint")}
          value={graph.entityMergeThreshold}
          min={0.5}
          max={1}
          step={0.01}
          onChange={(v) => update({ entityMergeThreshold: Number(v.toFixed(2)) })}
        />
        <NumberSliderField
          label={t("settings.graph.topicMerge")}
          value={graph.topicMergeThreshold}
          min={0.5}
          max={1}
          step={0.01}
          onChange={(v) => update({ topicMergeThreshold: Number(v.toFixed(2)) })}
        />
        <NumberSliderField
          label={t("settings.graph.referenceMatch")}
          hint={t("settings.graph.referenceMatchHint")}
          value={graph.referenceMatchThreshold}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => update({ referenceMatchThreshold: Number(v.toFixed(2)) })}
        />
      </div>
      <Separator />
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">{t("settings.graph.consolidateHint")}</p>
        <Button variant="outline" size="sm" disabled={consolidating} onClick={consolidateAll}>
          {consolidating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("settings.graph.consolidate")}
        </Button>
      </div>
    </Card>
  );
}

interface NumberFieldProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

function NumberSliderField({ label, hint, value, min, max, step, onChange }: NumberFieldProps) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-2 flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 accent-indigo-600"
        />
        <div className="w-16 text-right text-sm font-medium tabular-nums">
          {step < 1 ? value.toFixed(2) : value}
        </div>
      </div>
      {hint ? <p className="text-[11px] text-muted-foreground mt-1">{hint}</p> : null}
    </div>
  );
}

function StatusPill({ status }: { status: { ok: boolean; message: string } | null }) {
  if (!status) return null;
  return (
    <div
      className={`flex items-center gap-1.5 text-xs font-medium ${
        status.ok ? "text-emerald-700" : "text-rose-700"
      }`}
    >
      {status.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      <span className="truncate max-w-[220px]">{status.message}</span>
    </div>
  );
}

export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  return (
    <div className="flex items-center gap-3">
      <Label className="text-sm">{t("settings.language")}</Label>
      <Select
        value={settings?.language ?? "en"}
        onValueChange={async (v) => {
          await i18n.changeLanguage(v);
          const next = await api.settings.update({ language: v as AppSettings["language"] });
          setSettings(next);
        }}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="en">English</SelectItem>
          <SelectItem value="de">Deutsch</SelectItem>
          <SelectItem value="fr">Français</SelectItem>
          <SelectItem value="es">Español</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function DescriptionNote({ children }: { children: React.ReactNode }) {
  return <Textarea rows={2}>{children}</Textarea>;
}
