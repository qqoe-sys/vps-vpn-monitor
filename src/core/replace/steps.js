'use strict';
// Шаги мастера замены входа: новый VPS настраивается как вход к ТОМУ ЖЕ выходу,
// с теми же клиентами (UUID/email) и теми же inbound, что были на старом входе.
//
// План: { target: { id, name, host, password, limit, ports, sni? }, old: <запись старого входа>,
//         exit: <запись выхода>, source: { inventory, from, savedAt } }
//
// На ВЫХОДЕ разрешено только: прочитать параметры звена (exit-link.py), добавить одно правило
// `ufw allow from <IP нового входа> to any port <порт звена> proto tcp` под защитным таймером
// и снять таймер / удалить это же правило при откате. Xray выхода не трогаем вообще.

const i18n = require('../../i18n');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../provision/steps');
const { isIpv4 } = require('../provision/validate');
const { buildReplacementConfig, usedInbounds } = require('./entry-config');

const SERVER_ROOT = path.join(__dirname, '../../../server');
const readScript = (rel) => fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
const EXIT_GUARD_SECONDS = 600;
// Защитный таймер у каждого правила свой (IP + порт): таймер другого запуска мы никогда не остановим,
// а по живому таймеру узнаём «своё» правило, оставшееся от прошлой неудачной попытки.
const guardUnit = (ip, port) => `vpsmon-exit-guard-${ip.replace(/\./g, '-')}-${port}`;

// Адреса и ключ проверяем ДО первого шага: они попадают в команды shell и в сравнение IP в probe.
function checkPlan(plan) {
  if (!isIpv4(plan?.target?.host)) throw new Error(i18n.t('repl.newIpv4'));
  if (!isIpv4(plan?.exit?.host)) throw new Error(i18n.t('repl.exitIpv4'));
  if (!plan.exit.keyPath) throw new Error(i18n.t('repl.exitNoKey'));
  if (!usedInbounds(plan.source.inventory).length) throw new Error(i18n.t('repl.noClients'));
}

// План замены из того, что собрал main: форма, записи старого входа и выхода, выбранный источник клиентов.
// cleanIncomplete — галочка «Убрать следы незавершённой установки» (как в мастере добавления):
// повторная замена на тот же VPS после прерванной попытки иначе упрётся в precheck.
function makeReplacePlan({ target, old, exit, picked, cleanIncomplete = false }) {
  return {
    target,
    old,
    exit: { ...exit },
    source: { inventory: picked.inventory, from: picked.from, savedAt: picked.savedAt ?? null },
    cleanIncomplete: Boolean(cleanIncomplete),
  };
}

// Секреты в ctx.secrets вычищаются runner'ом из ошибок и прогресса.
function addSecrets(ctx, ...values) {
  ctx.secrets = ctx.secrets || [];
  for (const v of values) if (v && !ctx.secrets.includes(v)) ctx.secrets.push(v);
}

// Последняя строка вывода — JSON от Python-скрипта.
function lastJson(text, what) {
  const line = text.trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(i18n.t('repl.badReply', { what }));
  }
}

function closeQuietly(t) {
  try { t.transport?.close(); } catch { /* уже закрыто */ }
  t.transport = null;
}

function buildReplaceSteps(plan) {
  checkPlan(plan);
  const { inventory } = plan.source;
  // Порты нового входа — ровно те, что слушал старый (из снимка), иначе ключи клиентов не подойдут.
  // Inbound без клиентов не переносятся (см. usedInbounds), их порты тоже не открываем.
  const ports = usedInbounds(inventory).map((ib) => ib.port);
  // Копии: в них живут соединения, а запись выхода из конфига приложения не должна их получить.
  const t = { ...plan.target, role: 'entry', ports };
  const exit = { ...plan.exit };
  const targets = [t];
  const rule = (port) => `allow from ${t.host} to any port ${port} proto tcp`;
  const guard = (port) => guardUnit(t.host, port);
  // Для команд на выходе: живое соединение или новое по ключу приложения.
  const onExit = async (ctx) => {
    if (!exit.transport) exit.transport = await ctx.connect(exit, { keyPath: exit.keyPath });
    return exit;
  };

  const record = () => ({
    id: t.id,
    name: t.name,
    role: i18n.t('role.entry', { exit: exit.name }),
    host: t.host,
    user: 'root',
    keyPath: t.keyPath,
    services: ['xray'],
    ports,
    statsPort: P.STATS_PORT,
    exitHost: exit.host,
    limit: t.limit,
    managed: true,
  });

  const connect = P.stepConnect(targets);
  return [
    {
      ...connect,
      run: async (ctx) => {
        // Пароль и UUID клиентов из снимка — секреты с самого начала.
        addSecrets(ctx, t.password, ...inventory.keys.flatMap((k) => k.entries.map((e) => e.id)));
        await connect.run(ctx);
      },
      undo: async () => closeQuietly(t),
    },
    P.stepPrecheck(targets, { cleanIncomplete: plan.cleanIncomplete }),
    {
      id: 'exit-link',
      title: i18n.t('step.exitLink'),
      undoOnFail: true,
      run: async (ctx) => {
        const x = await onExit(ctx);
        const arg = P.b64(JSON.stringify({ entryHost: t.host }));
        let out;
        try {
          out = await P.py(x, `# step:exit-link\n${readScript('replace/exit-link.py')}`, [arg], 60000);
        } catch (err) {
          // Скрипт при ошибке печатает {ok:false,error}; показываем только текст ошибки.
          const e = (() => { try { return JSON.parse(err.message.trim().split('\n').pop()); } catch { return null; } })();
          throw new Error(`${i18n.t('role.exit')}: ${e?.error || err.message}`);
        }
        const link = lastJson(out, i18n.t('role.exit'));
        if (!link.ok) throw new Error(`${i18n.t('role.exit')}: ${link.error || i18n.t('repl.linkRead')}`);
        addSecrets(ctx, link.uuid);
        const missing = ['uuid', 'publicKey', 'shortId', 'sni'].filter((k) => typeof link[k] !== 'string' || !link[k]);
        if (!Number.isInteger(link.port) || typeof link.flow !== 'string' || missing.length) {
          throw new Error(`${i18n.t('role.exit')}: ${i18n.t('repl.linkIncomplete', { fields: missing.join(', ') || 'port/flow' })}`);
        }
        // Звено новый вход строит по TCP (Vision работает только поверх TCP). Пустой network = tcp,
        // raw — новое имя tcp в Xray. Другой транспорт — отказ, пока на выходе ничего не изменено.
        const net = link.network || 'tcp';
        if (net !== 'tcp' && net !== 'raw') throw new Error(`${i18n.t('role.exit')}: ${i18n.t('repl.linkNotTcp', { net })}`);
        ctx.link = link;
      },
      undo: async () => closeQuietly(exit),
    },
    P.stepAppKey(targets),
    P.stepFail2ban(targets),
    P.stepXray(targets),
    P.stepSni(targets),
    P.stepConfig(targets, (x, ctx) => {
      addSecrets(ctx, x.xrayKeys.privateKey);
      return buildReplacementConfig({
        inventory,
        link: ctx.link,
        exitHost: exit.host,
        reality: { privateKey: x.xrayKeys.privateKey, shortId: ctx.randomHex(8), sni: x.sni },
        xhttpPath: `/${ctx.randomHex(4)}`,
        statsPort: P.STATS_PORT,
      });
    }),
    P.stepSysctl(targets),
    // Вход открывает свои клиентские порты; план из одного сервера — правило «только для входа» здесь не нужно.
    P.stepFirewall(targets, { targets }),
    P.stepCollector(targets, record),
    // Связь с выходом здесь не проверяем: выход пустит новый вход только на шаге exit-allow.
    P.stepVerify(targets),
    {
      id: 'exit-allow',
      title: i18n.t('step.exitAccess'),
      undoOnFail: true,
      run: async (ctx) => {
        const x = await onExit(ctx);
        const r = rule(ctx.link.port);
        const g = guard(ctx.link.port);
        // Только чтение: есть ли правило и взведён ли защитный таймер ИМЕННО этого правила.
        const out = await P.sh(x, `# step:exit-check
ufw show added
echo "@@guard=$(systemctl is-active ${g}.timer 2>/dev/null || true)"`);
        const lines = out.split('\n').map((l) => l.trim());
        if (lines.includes(`ufw ${r}`)) {
          // Правило с живым таймером — наше, от прошлой попытки, чей откат не дошёл: не добавляем
          // и не перевзводим, но finish снимет таймер, а откат уберёт правило.
          // Без таймера правило постоянное (чужое): не трогаем ни сейчас, ни при откате.
          if (lines.includes('@@guard=active')) ctx.exitRuleAdded = true;
          return;
        }
        // С этого момента правило может появиться: откат должен его убрать.
        ctx.exitRuleAdded = true;
        // Защитный таймер ставится ДО правила и удаляет только его (никогда не ufw disable).
        await P.sh(x, `# step:exit-allow
set -e
systemctl stop ${g}.timer 2>/dev/null || true
systemctl reset-failed ${g}.service ${g}.timer 2>/dev/null || true
systemd-run --on-active=${EXIT_GUARD_SECONDS} --unit=${g} /usr/sbin/ufw delete ${r}
ufw ${r}
`);
      },
      undo: async (ctx) => {
        if (!ctx.exitRuleAdded) return;
        const r = rule(ctx.link.port);
        const g = guard(ctx.link.port);
        // Скрипт можно безопасно повторить: правило удаляется, только если оно есть.
        // Сначала правило, потом таймер: если связь оборвётся посередине, живой таймер
        // всё равно уберёт правило — постоянного правила без защиты не останется.
        // Не удалось удалить — выходим, не трогая таймер: он остаётся последней страховкой.
        const undo = `# step:exit-undo
if ufw show added | grep -qxF 'ufw ${r}'; then ufw delete ${r} || exit 1; fi
systemctl stop ${g}.timer 2>/dev/null || true
systemctl reset-failed ${g}.service ${g}.timer 2>/dev/null || true
`;
        try {
          await P.sh(await onExit(ctx), undo);
        } catch {
          // Старое соединение могло оборваться — подключаемся заново по ключу и повторяем.
          closeQuietly(exit);
          await P.sh(await onExit(ctx), undo);
        }
        ctx.exitRuleAdded = false;
      },
    },
    {
      id: 'probe',
      title: i18n.t('step.probe'),
      run: async (ctx) => {
        const request = P.b64(JSON.stringify({ action: 'probe', role: 'entry', exitIp: exit.host }));
        const out = await P.py(t, `# step:probe\n${readScript('cascade-tune.py')}`, [request], 180000);
        const res = lastJson(out, i18n.t('step.probe'));
        if (res.ok) return;
        // Только тег inbound и SNI: ни UUID, ни ключей в сообщении нет.
        const failed = (res.probes || []).filter((p) => !p.ok).map((p) => `${p.inbound}/${p.sni} (http ${p.http || '-'})`);
        throw new Error(i18n.t('repl.probeFailed', { list: failed.join(', ') || res.error || i18n.t('repl.noChecks') }));
      },
    },
    {
      id: 'finish',
      title: i18n.t('step.finish'),
      run: async (ctx) => {
        if (ctx.exitRuleAdded) {
          // Снимаем таймер выхода и убеждаемся, что правило на месте (таймер мог успеть сработать).
          const x = await onExit(ctx);
          const r = rule(ctx.link.port);
          const g = guard(ctx.link.port);
          await P.sh(x, `# step:exit-release
systemctl stop ${g}.timer 2>/dev/null || true
systemctl reset-failed ${g}.service ${g}.timer 2>/dev/null || true
! systemctl is-active --quiet ${g}.timer || { echo '@E:guard_stop_failed'; exit 1; }
ufw show added | grep -qxF 'ufw ${r}' || { echo '@E:exit_rule_gone'; exit 1; }
`);
        }
        await P.sh(t, `python3 ${P.MANIFEST} status complete`);
        ctx.result = { server: record() };
        closeQuietly(t);
        closeQuietly(exit);
      },
    },
  ];
}

module.exports = { buildReplaceSteps, makeReplacePlan };
