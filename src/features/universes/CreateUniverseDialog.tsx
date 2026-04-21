import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { useApp } from "@/app/store";

const PALETTE = ["#6366f1", "#8b5cf6", "#ec4899", "#f43f5e", "#f97316", "#eab308", "#14b8a6", "#06b6d4", "#0ea5e9", "#64748b"];

export function CreateUniverseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const setRoute = useApp((s) => s.setRoute);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(PALETTE[0]);

  const mutation = useMutation({
    mutationFn: () => api.universes.create({ name: name.trim(), description: description.trim(), color }),
    onSuccess: (id) => {
      void queryClient.invalidateQueries({ queryKey: ["universes"] });
      onOpenChange(false);
      setName("");
      setDescription("");
      setColor(PALETTE[0]);
      setRoute({ name: "universe", universeId: id, tab: "documents" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("universe.create")}</DialogTitle>
          <DialogDescription>{t("universe.emptyHint")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-1">
          <div>
            <Label>{t("universe.name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Research · Notes · Design …" className="mt-1.5" autoFocus />
          </div>
          <div>
            <Label>{t("universe.description")}</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="mt-1.5" />
          </div>
          <div>
            <Label>{t("universe.color")}</Label>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110"
                  style={{ backgroundColor: c, borderColor: color === c ? "#111" : "transparent" }}
                />
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            {t("universe.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
