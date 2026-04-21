import { create } from "zustand";
import type { AppSettings, SourceRef } from "@shared/types";

export type Route =
  | { name: "onboarding" }
  | { name: "universes" }
  | { name: "universe"; universeId: string; tab: "chat" | "graph" | "documents" | "memory" | "settings"; chatId?: string }
  | { name: "global"; chatId?: string }
  | { name: "settings" };

interface AppStore {
  route: Route;
  setRoute(route: Route): void;
  settings: AppSettings | null;
  setSettings(s: AppSettings | null): void;
  commandOpen: boolean;
  setCommandOpen(v: boolean): void;
  rightPanelOpen: boolean;
  setRightPanelOpen(v: boolean): void;
  /** The source currently focused in the source viewer panel. */
  activeSource: SourceRef | null;
  setActiveSource(source: SourceRef | null): void;
}

export const useApp = create<AppStore>((set) => ({
  route: { name: "onboarding" },
  setRoute: (route) => set({ route }),
  settings: null,
  setSettings: (settings) => set({ settings }),
  commandOpen: false,
  setCommandOpen: (v) => set({ commandOpen: v }),
  rightPanelOpen: true,
  setRightPanelOpen: (v) => set({ rightPanelOpen: v }),
  activeSource: null,
  setActiveSource: (source) => set({ activeSource: source, rightPanelOpen: source ? true : true }),
}));
