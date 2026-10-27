// This module stays independent of VS Code so Git and transport code can run alone.
const catalog = require('../../media/i18n.js') as {
  normalizeLocale(language?: string): string;
  createTranslator(language?: string): (key: string, ...values: unknown[]) => string;
};
let language = 'zh-cn';
let translate = catalog.createTranslator(language);
export function setLocale(value?: string): void { language = catalog.normalizeLocale(value); translate = catalog.createTranslator(language); }
export function getLocale(): string { return language; }
export function t(key: string, ...values: unknown[]): string { return translate(key, ...values); }
