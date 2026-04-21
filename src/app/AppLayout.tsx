import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Globe,
  Settings as SettingsIcon,
  Plus,
  Command as CommandIcon,
  Sparkles,
} from "lucide-react";
import { motion } from "framer-motion";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApp } from "./store";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/misc";
import { Badge } from "@/components/ui/misc";
import { CreateUniverseDialog } from "@/features/universes/CreateUniverseDialog";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const route = useApp((s) => s.route);
  const setRoute = useApp((s) => s.setRoute);
  const setCommandOpen = useApp((s) => s.setCommandOpen);
  const [createOpen, setCreateOpen] = React.useState(false);

  const { data: universes = [] } = useQuery({
    queryKey: ["universes"],
    queryFn: () => api.universes.list(),
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setCommandOpen]);

  const isActive = (check: () => boolean) => check();

  return (
    <div className="h-screen w-screen bg-gradient-to-br from-zinc-50 via-white to-indigo-50/30 flex overflow-hidden">
      <aside
        aria-label={t("nav.primary")}
        className="w-[272px] flex-shrink-0 border-r border-border/70 bg-white/60 backdrop-blur-sm flex flex-col"
      >
        <div className="px-4 pt-5 pb-3 flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-sm">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">{t("app.name")}</div>
            <div className="text-[11px] text-muted-foreground leading-tight">{t("app.tagline")}</div>
          </div>
        </div>

        <div className="px-3 space-y-1">
          <NavItem
            icon={<Globe className="h-4 w-4" />}
            label={t("nav.globalChat")}
            active={isActive(() => route.name === "global")}
            onClick={() => setRoute({ name: "global" })}
          />
          <NavItem
            icon={<CommandIcon className="h-4 w-4" />}
            label={t("nav.commandPalette")}
            kbd="⌘K"
            onClick={() => setCommandOpen(true)}
          />
        </div>

        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
            {t("nav.universes")}
          </div>
          <button
            type="button"
            className="h-6 w-6 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setCreateOpen(true)}
            title={t("universe.new")}
            aria-label={t("universe.new")}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 space-y-1 pb-2">
          {universes.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <div className="text-xs text-muted-foreground">{t("universe.empty")}</div>
            </div>
          ) : (
            universes.map((u) => {
              const active = route.name === "universe" && route.universeId === u.id;
              return (
                <button
                  key={u.id}
                  onClick={() => setRoute({ name: "universe", universeId: u.id, tab: "chat" })}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors group",
                    active ? "bg-primary/10 text-primary" : "hover:bg-secondary",
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full flex-shrink-0 shadow-sm"
                    style={{ backgroundColor: u.color }}
                  />
                  <span className="text-sm font-medium truncate flex-1">{u.name}</span>
                  {u.stats && u.stats.documents > 0 && (
                    <Badge variant={active ? "default" : "secondary"} className="text-[10px]">
                      {u.stats.documents}
                    </Badge>
                  )}
                </button>
              );
            })
          )}
        </div>

        <Separator />
        <div className="p-3">
          <NavItem
            icon={<SettingsIcon className="h-4 w-4" />}
            label={t("nav.settings")}
            active={isActive(() => route.name === "settings")}
            onClick={() => setRoute({ name: "settings" })}
          />
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-hidden">
        <motion.div
          key={keyForRoute(route)}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="h-full"
        >
          {children}
        </motion.div>
      </main>

      <CreateUniverseDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function keyForRoute(route: ReturnType<typeof useApp.getState>["route"]): string {
  if (route.name === "universe") return `u:${route.universeId}:${route.tab}`;
  if (route.name === "global") return `global:${route.chatId ?? ""}`;
  return route.name;
}

function NavItem({
  icon,
  label,
  active,
  kbd,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  kbd?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? "default" : "ghost"}
      className={cn("w-full justify-start h-9 px-2.5", active ? "" : "text-foreground")}
      onClick={onClick}
    >
      <span className="flex items-center gap-2.5 text-sm font-medium">
        {icon}
        {label}
      </span>
      {kbd && (
        <kbd className="ml-auto rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {kbd}
        </kbd>
      )}
    </Button>
  );
}
