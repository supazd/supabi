import { locales, type Locale } from '@supabi/ui'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { enUS } from './en-US'
import { zhCN } from './zh-CN'

const storageKey = 'supabi.locale'

function isLocale(value: string | null | undefined): value is Locale {
  return locales.includes(value as Locale)
}

/** Saved choice first, then the browser's language, then Chinese. */
export function detectLocale(): Locale {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(storageKey)
  } catch {
    // storage can be unavailable (private mode, embedded frames)
  }
  if (isLocale(saved)) return saved
  for (const language of navigator.languages ?? [navigator.language]) {
    if (isLocale(language)) return language
    const sameLanguage = locales.find((l) => l.split('-')[0] === language.split('-')[0])
    if (sameLanguage) return sameLanguage
  }
  return 'zh-CN'
}

export function saveLocale(locale: Locale) {
  try {
    localStorage.setItem(storageKey, locale)
  } catch {
    // see detectLocale
  }
}

void i18n.use(initReactI18next).init({
  resources: { 'zh-CN': { translation: zhCN }, 'en-US': { translation: enUS } },
  lng: detectLocale(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false }, // React escapes already
})

export default i18n
