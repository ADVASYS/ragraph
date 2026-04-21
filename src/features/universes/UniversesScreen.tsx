import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Plus, Telescope, FileText, Network, Binary, Clock } from "lucide-react";
import { motion } from "framer-motion";
import { api } from "@/lib/api";
import { useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/misc";
import { formatDate } from "@/lib/utils";
import { CreateUniverseDialog } from "./CreateUniverseDialog";

export function UniversesScreen() {
  const { t, i18n } = useTranslation();
  const setRoute = useApp((s) => s.setRoute);
  const [open, setOpen] = useState(false);
  const { data: universes = [] } = useQuery({
    queryKey: ["universes"],
    queryFn: () => api.universes.list(),
  });

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto px-8 py-10">
        <div className="flex items-end justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t("nav.universes")}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t("universe.emptyHint")}</p>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> {t("universe.new")}
          </Button>
        </div>

        {universes.length === 0 ? (
          <Card className="p-14 flex flex-col items-center text-center">
            <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
              <Telescope className="h-7 w-7 text-primary" />
            </div>
            <div className="text-base font-medium">{t("universe.empty")}</div>
            <div className="text-sm text-muted-foreground mt-1 max-w-sm">{t("universe.emptyHint")}</div>
            <Button className="mt-6" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> {t("universe.new")}
            </Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {universes.map((u, idx) => (
              <motion.button
                key={u.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: idx * 0.04 }}
                className="card-elevated text-left p-5 hover:border-primary/40 hover:shadow-md transition-all group"
                onClick={() => setRoute({ name: "universe", universeId: u.id, tab: "chat" })}
              >
                <div className="flex items-center gap-2 mb-3">
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: u.color }}
                  />
                  <div className="text-[15px] font-semibold tracking-tight flex-1 truncate">{u.name}</div>
                </div>
                {u.description && (
                  <p className="text-[13px] text-muted-foreground line-clamp-2 mb-4 min-h-[2.5rem]">
                    {u.description}
                  </p>
                )}
                <div className="grid grid-cols-4 gap-2 text-center">
                  <Stat icon={<FileText className="h-3.5 w-3.5" />} label={t("universe.stats.documents")} value={u.stats?.documents ?? 0} />
                  <Stat icon={<Binary className="h-3.5 w-3.5" />} label={t("universe.stats.entities")} value={u.stats?.entities ?? 0} />
                  <Stat icon={<Network className="h-3.5 w-3.5" />} label={t("universe.stats.topics")} value={u.stats?.topics ?? 0} />
                  <Stat icon={<Clock className="h-3.5 w-3.5" />} label={t("universe.stats.chunks")} value={u.stats?.chunks ?? 0} />
                </div>
                <div className="mt-4 pt-3 border-t border-border/60 text-[11px] text-muted-foreground flex items-center justify-between">
                  <span>{t("universe.stats.lastSync")}</span>
                  <span>{u.stats?.lastSyncAt ? formatDate(u.stats.lastSyncAt, i18n.language) : t("common.never")}</span>
                </div>
              </motion.button>
            ))}
          </div>
        )}
      </div>
      <CreateUniverseDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div className="bg-muted/50 rounded-lg py-2">
      <div className="flex items-center justify-center gap-1 text-muted-foreground">{icon}</div>
      <div className="text-sm font-semibold mt-0.5">{value}</div>
      <div className="text-[10px] text-muted-foreground leading-none">{label}</div>
    </div>
  );
}
