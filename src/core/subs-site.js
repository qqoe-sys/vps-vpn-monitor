'use strict';
// Генератор сайта подписок: из списка людей и ключей входа собирает статические файлы
// и конфиг Caddy. Никакой программы на сервере: только готовые файлы.
//
// Структура сайта:
//   index.html            — нейтральная заглушка для всех, кто зашёл без кода
//   s/<код>/index.html    — страница человека (для браузера)
//   s/<код>/sub           — подписка: base64 от одной XHTTP-ссылки (для Happ)

const crypto = require('node:crypto');
const i18n = require('../i18n');
const QRCode = require('qrcode');
const { TOKEN_RE } = require('./subs-config');
const { linksFor } = require('./xray-keys');

// По этим словам в User-Agent узнаём VPN-клиенты. Тот же список — в Caddyfile.
const CLIENT_UA = 'happ|v2ray|xray|streisand|clash|sing-box|hiddify|shadowrocket|nekobox|v2box';
const CLIENT_UA_RE = new RegExp(CLIENT_UA, 'i');
const TOKEN_PART = '[A-Za-z0-9_-]{43}';
const PAGE_PATH_RE = new RegExp(`^/s/(${TOKEN_PART})/?$`);
const SUB_PATH_RE = new RegExp(`^/s/(${TOKEN_PART})/sub$`);

// Экранирование текста для HTML: имя человека и шаги инструкций вводятся вручную,
// и без экранирования «<script>» в имени выполнился бы на странице.
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function subUrl(subs, token) {
  const { domain, port } = subs.site;
  return `https://${domain}${port === 443 ? '' : `:${port}`}/s/${token}/`;
}

// Адрес для Happ: /sub всегда отдаёт подписку, не угадывая клиента по заголовкам
// (на деле Happ на Android приходил с заголовками браузера и получал HTML).
function happUrl(subs, token) {
  return `${subUrl(subs, token)}sub`;
}

function personLink(subs, inventory, entryServer, person) {
  const xhttp = linksFor(entryServer, inventory, person.key, 'firefox').find((l) => l.label === 'xhttp');
  if (!xhttp) return null;
  // Подпись после # видна в Happ как имя сервера: ставим название сервиса, а не имя ключа.
  return `${xhttp.url.split('#')[0]}#${encodeURIComponent(subs.site.title)}`;
}

// Имена ключей входа, которые можно выдать человеку: только с XHTTP-записью.
function xhttpKeys(inventory) {
  const tags = new Set(inventory.inbounds.filter((i) => i.net === 'xhttp').map((i) => i.tag));
  return inventory.keys.filter((k) => k.entries.some((e) => tags.has(e.tag))).map((k) => k.name);
}

function subscriptionBody(link) {
  return link ? Buffer.from(`${link}\n`).toString('base64') : '';
}

// HTTP-заголовки — только ASCII, поэтому кириллицу в названии кодируем; Happ понимает префикс base64:.
function profileTitleHeader(title) {
  return `base64:${Buffer.from(title).toString('base64')}`;
}

function classifyRequest(path, headers) {
  const sub = SUB_PATH_RE.exec(path);
  if (sub) return { kind: 'sub', token: sub[1] };
  const page = PAGE_PATH_RE.exec(path);
  if (!page) return { kind: 'stub' };
  const ua = headers['user-agent'] || '';
  const accept = headers.accept || '';
  if (CLIENT_UA_RE.test(ua) || !accept.includes('text/html')) return { kind: 'sub', token: page[1] };
  return { kind: 'page', token: page[1] };
}

const CSS = `:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#0f1115;color:#e6e8ec;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:24px;margin:0 0 4px}.muted{color:#8b93a1;font-size:14px}
.card{background:#171a21;border:1px solid #262b36;border-radius:14px;padding:18px;margin:16px 0}
.qr{background:#fff;border-radius:10px;padding:10px;width:220px;margin:0 auto 14px}.qr svg{display:block;width:100%;height:auto}
.btn{display:block;width:100%;text-align:center;padding:12px;border-radius:10px;border:0;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;margin-top:8px}
.primary{background:#3b82f6;color:#fff}.ghost{background:#232834;color:#e6e8ec}
code{display:block;word-break:break-all;background:#0b0d11;border-radius:8px;padding:10px;font-size:12px;color:#b9c0cc}
details{margin-top:8px}summary{cursor:pointer;padding:6px 0;font-weight:600}
ol{padding-left:20px;margin:8px 0}.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tabs label{padding:6px 12px;border-radius:999px;background:#232834;cursor:pointer;font-size:14px}
.os{display:none}input[name=os]{display:none}
#os-android:checked~.tabs label[for=os-android],#os-ios:checked~.tabs label[for=os-ios],#os-windows:checked~.tabs label[for=os-windows],#os-linux:checked~.tabs label[for=os-linux]{background:#3b82f6;color:#fff}
#os-android:checked~#p-android,#os-ios:checked~#p-ios,#os-windows:checked~#p-windows,#os-linux:checked~#p-linux{display:block}
.empty{text-align:center;font-size:20px;padding:32px 0}`;

const OS_LABELS = { android: 'Android', ios: 'iOS', windows: 'Windows', linux: 'Linux' };

// Язык сайта задаётся в настройках подписок (site.lang) и не зависит от языка программы.
const siteLang = (subs) => subs.site.lang ?? 'ru';

function head(title, lang) {
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${CSS}</style></head>`;
}

function appsBlock(apps, lang) {
  const radios = Object.keys(OS_LABELS).map((os, i) => `<input type="radio" name="os" id="os-${os}"${i === 0 ? ' checked' : ''}>`).join('');
  const tabs = Object.entries(OS_LABELS).map(([os, label]) => `<label for="os-${os}">${label}</label>`).join('');
  const panels = Object.keys(OS_LABELS).map((os) => {
    const app = apps[os];
    const steps = app.steps.map((s) => `<li>${esc(s)}</li>`).join('');
    return `<div class="os" id="p-${os}"><ol>${steps}</ol><a class="btn ghost" href="${esc(app.url)}" target="_blank" rel="noopener noreferrer">${esc(i18n.tr(lang, 'site.download', { app: app.name }))}</a></div>`;
  }).join('');
  return `<div class="card"><b>${esc(i18n.tr(lang, 'site.how'))}</b>${radios}<div class="tabs">${tabs}</div>${panels}</div>`;
}

function renderPage({ subs, person, link, url, qrSub, qrKey }) {
  const { title } = subs.site;
  const lang = siteLang(subs);
  const tx = (key) => esc(i18n.tr(lang, key));
  const intro = `<h1>${esc(title)}</h1><div class="muted">${esc(person.name)}</div>`;
  if (!link) {
    return `${head(title, lang)}<body><main>${intro}<div class="card empty">${tx('site.noKeys')}</div></main></body></html>`;
  }
  const copy = (id) => `<button class="btn ghost" type="button" data-copy="${id}">${tx('site.copy')}</button>`;
  // Диплинк Happ: открывает приложение и сразу добавляет подписку.
  const deeplink = `happ://add/${url}`;
  return `${head(title, lang)}<body><main>${intro}
<div class="card"><div class="qr">${qrSub}</div>
<a class="btn primary" href="${esc(deeplink)}">${tx('site.addHapp')}</a>
<code id="sub-url">${esc(url)}</code>${copy('sub-url')}</div>
${appsBlock(subs.apps, lang)}
<div class="card"><b>${tx('site.trouble')}</b>
<details><summary>${tx('site.manualKey')}</summary><div class="qr">${qrKey}</div><code id="key">${esc(link)}</code>${copy('key')}</details></div>
</main><script>${copyScript(lang)}</script>
</body></html>`;
}

// Единственный скрипт страницы — кнопки «Скопировать». Вынесен в функцию: его хеш нужен для CSP в Caddyfile.
function copyScript(lang) {
  const copied = JSON.stringify(i18n.tr(lang, 'site.copied')).replace(/</g, '\\u003c');
  return `document.querySelectorAll('[data-copy]').forEach(function(b){b.onclick=function(){
navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent).then(function(){b.textContent=${copied}})}})`;
}

// CSP страницы: ничего внешнего не грузим, скрипт разрешён только наш (по sha256), фреймы и формы запрещены.
function contentSecurityPolicy() {
  const hashes = i18n.LANGS.map((lang) => `'sha256-${crypto.createHash('sha256').update(copyScript(lang)).digest('base64')}'`);
  return `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src ${hashes.join(' ')}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

function renderStub(lang) {
  return `${head(i18n.tr(lang, 'site.welcome'), lang)}<body><main><div class="card empty">${esc(i18n.tr(lang, 'site.empty'))}</div></main></body></html>`;
}

const qrSvg = (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

async function buildSite(subs, inventory, entryServer) {
  const files = { 'index.html': renderStub(siteLang(subs)) };
  for (const person of subs.people) {
    if (!TOKEN_RE.test(person.token)) throw new Error(i18n.t('subs.badToken', { name: person.name }));
    const link = personLink(subs, inventory, entryServer, person);
    const url = happUrl(subs, person.token);
    const [qrSub, qrKey] = link ? await Promise.all([qrSvg(url), qrSvg(link)]) : ['', ''];
    files[`s/${person.token}/index.html`] = renderPage({ subs, person, link, url, qrSub, qrKey });
    files[`s/${person.token}/sub`] = subscriptionBody(link);
  }
  return { files, caddyfile: buildCaddyfile(subs), port: subs.site.port };
}

// Правила Caddy повторяют classifyRequest. Порядок handle важен: срабатывает первый подходящий.
// Журнала запросов нет (нет директивы log), листинга папок нет (нет browse).
function buildCaddyfile(subs) {
  const { domain, port, updateHours, title } = subs.site;
  const subHeaders = (re) => `		rewrite * /s/{re.${re}.1}/sub
		header Content-Type "text/plain; charset=utf-8"
		header Cache-Control no-store
		header profile-update-interval ${updateHours}
		header profile-title "${profileTitleHeader(title)}"
		file_server`;
  return `# Generated by VPS-VPN Monitor. Manual edits are overwritten on every publish.
${domain}:${port} {
	root * /var/www/vpsmon-sub/current
	tls {
		issuer acme {
			disable_tlsalpn_challenge
		}
	}
	header -Server
	header Referrer-Policy no-referrer
	header X-Robots-Tag "noindex, nofollow"
	header X-Content-Type-Options nosniff
	header Strict-Transport-Security "max-age=31536000"
	header Content-Security-Policy "${contentSecurityPolicy()}"

	@sub path_regexp tsub ^/s/(${TOKEN_PART})/sub$
	@clientua {
		path_regexp tua ^/s/(${TOKEN_PART})/?$
		header_regexp User-Agent (?i)(${CLIENT_UA})
	}
	@client {
		path_regexp tcl ^/s/(${TOKEN_PART})/?$
		not header Accept *text/html*
	}
	@page path_regexp tpg ^/s/(${TOKEN_PART})/?$

	handle @sub {
${subHeaders('tsub')}
	}
	handle @clientua {
${subHeaders('tua')}
	}
	handle @client {
${subHeaders('tcl')}
	}
	handle @page {
		rewrite * /s/{re.tpg.1}/index.html
		header Cache-Control no-store
		file_server
	}
	handle {
		rewrite * /index.html
		file_server
	}
}
`;
}

module.exports = {
  CLIENT_UA_RE, esc, subUrl, happUrl, personLink, xhttpKeys, subscriptionBody, profileTitleHeader,
  classifyRequest, renderPage, renderStub, buildSite, buildCaddyfile,
};
