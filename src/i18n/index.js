import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { enUS, zhCN as chineseDateLocale } from "date-fns/locale";
import zhCN from "./locales/zh-CN.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };

export const LANGUAGE_STORAGE_KEY = "asv.language";

export function normalizeLanguage(value) {
  return value === "en" ? "en" : "zh-CN";
}

function readLanguage() {
  try {
    return normalizeLanguage(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "zh-CN";
  }
}

export const i18n = createInstance();
// Bundled dictionaries initialize synchronously, before the first React render.
// Chinese source phrases are keys; punctuation must not act as key separators.
i18n.use(initReactI18next).init({
  resources: { "zh-CN": { translation: zhCN }, en: { translation: en } },
  lng: readLanguage(),
  fallbackLng: "zh-CN",
  supportedLngs: ["zh-CN", "en"],
  load: "currentOnly",
  initImmediate: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export function getLanguage() {
  return normalizeLanguage(i18n.resolvedLanguage);
}

export function getDateLocale() {
  return getLanguage() === "en" ? enUS : chineseDateLocale;
}

export function t(key, values) {
  return i18n.t(key, values);
}

function updateDocumentLanguage() {
  if (typeof document !== "undefined") document.documentElement.lang = getLanguage();
}
i18n.on("languageChanged", updateDocumentLanguage);
updateDocumentLanguage();

export async function setLanguage(language) {
  const next = normalizeLanguage(language);
  await i18n.changeLanguage(next);
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    // Language switching also works when browser storage is unavailable.
  }
}
