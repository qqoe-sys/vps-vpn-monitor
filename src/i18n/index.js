'use strict';
// Переводы. Один и тот же файл работает в двух местах:
//  - в главном процессе (Node.js): require('../i18n') — словари подключаются через require;
//  - в окне (песочница без Node.js): <script src="../i18n/ru.js">, en.js, затем этот файл,
//    словари лежат в window.I18N_DICTS, а API — в window.I18N.
//
// t('ключ', { name: 'x' }) берёт строку текущего языка и подставляет {name}.
// Нет строки в текущем языке — берём английскую, нет и её — показываем сам ключ
// (так забытый перевод сразу виден, а не превращается в пустое место).

(function init(root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const dicts = isNode ? { ru: require('./ru'), en: require('./en') } : root.I18N_DICTS;
  const api = factory(dicts);
  if (isNode) module.exports = api;
  else root.I18N = api;
}(typeof self !== 'undefined' ? self : this, (dicts) => {
  const LANGS = ['ru', 'en'];
  const LOCALES = { ru: 'ru-RU', en: 'en-US' };
  const FALLBACK = 'en';
  // По умолчанию русский: на нём написаны тесты и прежние версии программы.
  let current = 'ru';

  function normalize(lang) {
    const short = String(lang ?? '').toLowerCase().slice(0, 2);
    return LANGS.includes(short) ? short : null;
  }

  function setLang(lang) {
    current = normalize(lang) ?? FALLBACK;
    return current;
  }

  const getLang = () => current;
  const locale = () => LOCALES[current];

  // Язык по системе: русская Windows → ru, любая другая → en.
  const fromSystem = (systemLocale) => (normalize(systemLocale) === 'ru' ? 'ru' : 'en');

  function lookup(lang, key) {
    const d = dicts[lang];
    return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
  }

  // lang — необязательный явный язык (например, язык сайта подписок, а не программы).
  function tr(lang, key, params) {
    const s = lookup(lang, key) ?? lookup(FALLBACK, key) ?? key;
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])));
  }

  const t = (key, params) => tr(current, key, params);
  const has = (key) => lookup(current, key) !== undefined || lookup(FALLBACK, key) !== undefined;

  // Серверные скрипты печатают не текст, а коды: @E:код|арг0|арг1.
  // Переводим их в текст текущего языка; неизвестный код показываем как есть.
  const SERVER_CODE = /@E:([a-z0-9_]+)((?:\|[^|\n@]*)*)/g;
  function translateServer(text) {
    return String(text ?? '').replace(SERVER_CODE, (m, code, rest) => {
      const key = `srv.${code}`;
      if (!has(key)) return m;
      const args = rest ? rest.slice(1).split('|') : [];
      return t(key, Object.fromEntries(args.map((a, i) => [i, a])));
    });
  }

  return { LANGS, t, tr, setLang, getLang, locale, fromSystem, has, translateServer, dicts };
}));
