'use strict';
// Настройки программы (пока только язык): %APPDATA%\vps-monitor\settings.json.
// Повреждённый или чужой файл не роняет программу — берутся значения по умолчанию.

const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../i18n');

function loadSettings(file, systemLocale) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* файла нет или он повреждён */ }
  const lang = i18n.LANGS.includes(raw?.lang) ? raw.lang : i18n.fromSystem(systemLocale);
  return { lang };
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { loadSettings, saveSettings };
