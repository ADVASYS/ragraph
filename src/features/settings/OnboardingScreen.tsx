import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import { ProviderForm, LanguageSelect } from "./ProviderForm";
import { useApp } from "@/app/store";

export function OnboardingScreen() {
  const { t } = useTranslation();
  const setRoute = useApp((s) => s.setRoute);
  return (
    <div className="h-screen w-screen bg-gradient-to-br from-indigo-50 via-white to-violet-50 overflow-auto">
      <div className="max-w-3xl mx-auto px-8 py-14">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <div className="flex items-center gap-3 mb-6">
            <div className="h-11 w-11 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{t("onboarding.welcome")}</h1>
              <p className="text-sm text-muted-foreground">{t("onboarding.subtitle")}</p>
            </div>
          </div>

          <div className="mb-6 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{t("onboarding.providerIntro")}</p>
            <LanguageSelect />
          </div>

          <ProviderForm
            onComplete={() => {
              setRoute({ name: "universes" });
            }}
          />
        </motion.div>
      </div>
    </div>
  );
}
