import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { Globe, Settings as SettingsIcon, Telescope, Plus } from "lucide-react";
import { useApp } from "@/app/store";
import { api } from "@/lib/api";
import { useState } from "react";
import { CreateUniverseDialog } from "@/features/universes/CreateUniverseDialog";

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useApp((s) => s.commandOpen);
  const setOpen = useApp((s) => s.setCommandOpen);
  const setRoute = useApp((s) => s.setRoute);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: universes = [] } = useQuery({
    queryKey: ["universes"],
    queryFn: () => api.universes.list(),
  });

  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <>
      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label={t("nav.commandPalette")}
        className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      >
        <div className="fixed inset-0 bg-zinc-900/40 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
        <div className="relative w-full max-w-xl mx-4 rounded-2xl bg-white shadow-2xl border border-border overflow-hidden">
          <Command.Input
            placeholder={t("nav.commandPalette") + "…"}
            className="w-full px-4 py-3.5 text-sm outline-none border-b border-border"
          />
          <Command.List className="max-h-[420px] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-4 text-sm text-muted-foreground">
              {t("common.loading")}
            </Command.Empty>
            <Command.Group heading={t("nav.universes")} className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold px-2 pt-2 pb-1">
              <Command.Item
                onSelect={go(() => setCreateOpen(true))}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer aria-selected:bg-primary/10 aria-selected:text-primary"
              >
                <Plus className="h-4 w-4" /> {t("universe.new")}
              </Command.Item>
              {universes.map((u) => (
                <Command.Item
                  key={u.id}
                  onSelect={go(() => setRoute({ name: "universe", universeId: u.id, tab: "chat" }))}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer aria-selected:bg-primary/10 aria-selected:text-primary"
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: u.color }} />
                  {u.name}
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group heading={t("nav.commandPalette")} className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold px-2 pt-2 pb-1">
              <Command.Item
                onSelect={go(() => setRoute({ name: "global" }))}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer aria-selected:bg-primary/10 aria-selected:text-primary"
              >
                <Globe className="h-4 w-4" /> {t("nav.globalChat")}
              </Command.Item>
              <Command.Item
                onSelect={go(() => setRoute({ name: "universes" }))}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer aria-selected:bg-primary/10 aria-selected:text-primary"
              >
                <Telescope className="h-4 w-4" /> {t("nav.universes")}
              </Command.Item>
              <Command.Item
                onSelect={go(() => setRoute({ name: "settings" }))}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer aria-selected:bg-primary/10 aria-selected:text-primary"
              >
                <SettingsIcon className="h-4 w-4" /> {t("nav.settings")}
              </Command.Item>
            </Command.Group>
          </Command.List>
        </div>
      </Command.Dialog>
      <CreateUniverseDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
