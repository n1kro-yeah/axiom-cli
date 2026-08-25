import { en } from "./en.js";
import { ru } from "./ru.js";
import type { Dictionary } from "./en.js";

export type LanguageCode = "en" | "ru";

const DICTIONARIES: Record<LanguageCode, Dictionary> = {
  en,
  ru
};

export interface Translator {
  readonly language: LanguageCode;
  dict: Dictionary;
  t(template: string, vars?: Record<string, string | number>): string;
}

export function createTranslator(language: LanguageCode): Translator {
  return {
    language,
    get dict() {
      return DICTIONARIES[language];
    },
    t(template, vars) {
      if (!vars) return template;
      let out = template;
      for (const [key, value] of Object.entries(vars)) {
        out = out.split(`{${key}}`).join(String(value));
      }
      return out;
    }
  };
}

export function resolveLanguage(code: string | undefined): LanguageCode {
  if (!code) return "en";
  const normalized = code.toLowerCase();
  if (normalized.startsWith("ru")) return "ru";
  return "en";
}

export type { Dictionary };
export { en, ru };
