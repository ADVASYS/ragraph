import { useTranslation } from "react-i18next";
import { Settings as SettingsIcon } from "lucide-react";
import { AgentSettingsForm, GraphSettingsForm, IngestionSettings, LanguageSelect, ProviderForm } from "./ProviderForm";

export function SettingsScreen() {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2.5">
            <SettingsIcon className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold tracking-tight">{t("settings.title")}</h1>
          </div>
          <LanguageSelect />
        </div>
        <div className="space-y-6">
          <ProviderForm />
          <IngestionSettings />
          <AgentSettingsForm />
          <GraphSettingsForm />
        </div>
      </div>
    </div>
  );
}
