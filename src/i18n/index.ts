import { ref, watchEffect } from 'vue';
import { load, save } from '../domain/storage';
import { en, type Catalog, type MessageKey } from './en';
import { th } from './th';
import { zhCN } from './zh-CN';
import { zhTW } from './zh-TW';

export type { MessageKey };
/** Same locale set and codes as Awake Launcher. */
export type Locale = 'en' | 'th' | 'zh-CN' | 'zh-TW';
export const catalogs: Record<Locale, Catalog> = { en, th, 'zh-CN': zhCN, 'zh-TW': zhTW };
export const localeNames: Record<Locale, string> = { en: 'English', th: 'ไทย', 'zh-CN': '简体中文', 'zh-TW': '繁體中文' };

export function normalizeLocale(input: string): Locale {
  const value = input.replaceAll('_', '-').toLowerCase();
  if (value === 'th' || value.startsWith('th-')) return 'th';
  if (value.startsWith('zh')) return /(?:tw|hk|mo|hant)/.test(value) ? 'zh-TW' : 'zh-CN';
  return 'en';
}

export const locale = ref<Locale>(normalizeLocale(load('locale', typeof navigator === 'undefined' ? 'en' : navigator.language)));

watchEffect(() => {
  save('locale', locale.value);
  if (typeof document !== 'undefined') document.documentElement.lang = locale.value;
});

export function translate(loc: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  const text = catalogs[loc][key] ?? en[key];
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text;
}

export const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale.value, key, params);

export const formatNumber = (n: number) => new Intl.NumberFormat(locale.value).format(n);
export const formatDate = (iso: string) => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
