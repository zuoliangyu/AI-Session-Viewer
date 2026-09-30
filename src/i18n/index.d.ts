import type { i18n as I18n } from "i18next";
import type { Locale } from "date-fns";

export type Language = "zh-CN" | "en";
export const LANGUAGE_STORAGE_KEY: string;
export const i18n: I18n;
export function normalizeLanguage(value: unknown): Language;
export function getLanguage(): Language;
export function getDateLocale(): Locale;
export function t(key: string, values?: Record<string, unknown>): string;
export function setLanguage(language: Language): Promise<void>;
