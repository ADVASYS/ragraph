import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en, de, fr, es },
    fallbackLng: "en",
    supportedLngs: ["en", "de", "fr", "es"],
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });

export default i18n;
