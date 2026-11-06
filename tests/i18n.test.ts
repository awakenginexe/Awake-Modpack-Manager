import { describe, expect, it } from 'vitest';
import { catalogs, normalizeLocale, translate } from '../src/i18n';
import { en } from '../src/i18n/en';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  it('every locale has every key, non-empty, with the same placeholders', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(catalog)) {
        expect(text.trim(), `${locale}.${key}`).not.toBe('');
        expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(en[key as keyof typeof en]));
      }
    }
  });

  it('normalizes OS locale codes like the Launcher', () => {
    expect(normalizeLocale('th_TH')).toBe('th');
    expect(normalizeLocale('zh-Hant-HK')).toBe('zh-TW');
    expect(normalizeLocale('zh_CN')).toBe('zh-CN');
    expect(normalizeLocale('fr-FR')).toBe('en');
  });

  it('interpolates parameters', () => {
    expect(translate('en', 'selectedCount', { count: 3 })).toBe('3 selected');
    expect(translate('zh-CN', 'apply', { count: 2 })).toContain('2');
  });
});
