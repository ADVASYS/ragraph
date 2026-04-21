import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useApp } from "./store";
import { AppLayout } from "./AppLayout";
import { OnboardingScreen } from "@/features/settings/OnboardingScreen";
import { UniversesScreen } from "@/features/universes/UniversesScreen";
import { UniverseScreen } from "@/features/universes/UniverseScreen";
import { GlobalChatScreen } from "@/features/chat/GlobalChatScreen";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { CommandPalette } from "@/features/commands/CommandPalette";

export function App() {
  const { i18n } = useTranslation();
  const route = useApp((s) => s.route);
  const setRoute = useApp((s) => s.setRoute);
  const setSettings = useApp((s) => s.setSettings);
  const queryClient = useQueryClient();

  const { data: settings, isSuccess } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.settings.get(),
  });

  useEffect(() => {
    if (isSuccess && settings) {
      setSettings(settings);
      void i18n.changeLanguage(settings.language);
      if (!settings.onboardingComplete || !settings.provider) {
        setRoute({ name: "onboarding" });
      } else if (route.name === "onboarding") {
        setRoute({ name: "universes" });
      }
    }
  }, [isSuccess, settings, setSettings, setRoute, i18n, route.name]);

  useEffect(() => {
    const offs = [
      api.events.onUniverseChanged(() => {
        void queryClient.invalidateQueries({ queryKey: ["universes"] });
      }),
      api.events.onIngestion(() => {
        void queryClient.invalidateQueries({ queryKey: ["files"] });
        void queryClient.invalidateQueries({ queryKey: ["universes"] });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [queryClient]);

  if (!settings) return null;

  if (route.name === "onboarding") return <OnboardingScreen />;

  return (
    <AppLayout>
      {route.name === "universes" && <UniversesScreen />}
      {route.name === "universe" && <UniverseScreen key={route.universeId} route={route} />}
      {route.name === "global" && <GlobalChatScreen route={route} />}
      {route.name === "settings" && <SettingsScreen />}
      <CommandPalette />
    </AppLayout>
  );
}
