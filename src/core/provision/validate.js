'use strict';
// Проверка данных из мастера до первого обращения к серверу.

const RESERVED_PORTS = new Set([22, 10085]); // SSH и API статистики Xray

function isIpv4(host) {
  const parts = String(host ?? '').split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Некорректный порт: ${port}`);
  if (RESERVED_PORTS.has(port)) throw new Error(`Порт ${port} служебный, выбери другой`);
}

function checkPorts(ports) {
  ports.forEach(checkPort);
  if (new Set(ports).size !== ports.length) throw new Error('Один и тот же порт указан дважды');
}

// Точки заменяем, а не убираем: иначе 1.2.3.45 и 12.3.4.5 совпали бы.
const serverIdFor = (host) => `s${host.replace(/\./g, '_')}`;

function validatePlan(plan) {
  if (!Array.isArray(plan?.targets) || plan.targets.length < 1 || plan.targets.length > 2) {
    throw new Error('Нужен один или два сервера');
  }
  for (const t of plan.targets) {
    if (!isIpv4(t.host)) throw new Error(`Некорректный IP-адрес: ${t.host}`);
    if (!t.password) throw new Error(`Не указан пароль для ${t.host}`);
    if (!t.name?.trim()) throw new Error(`Не указано имя для ${t.host}`);
    if (!(t.limit?.tb > 0)) throw new Error(`Некорректный лимит для ${t.host}`);
    if (!Number.isInteger(t.limit.resetDay) || t.limit.resetDay < 1 || t.limit.resetDay > 31) {
      throw new Error('День сброса должен быть от 1 до 31');
    }
    if (!['both', 'down', 'up'].includes(t.limit.mode)) throw new Error('Неизвестный способ подсчёта лимита');
    checkPorts(t.role === 'exit' ? [t.ports.exit] : t.modes.flatMap((m) => [t.ports[m].xhttp, t.ports[m].vision]));
  }
  const [a, b] = plan.targets;
  if (b) {
    if (a.host === b.host) throw new Error('Для каскада нужны разные серверы');
    const roles = plan.targets.map((t) => t.role).sort().join();
    if (roles !== 'entry,exit') throw new Error('В каскаде должны быть входной и выходной сервер');
  }
}

module.exports = { validatePlan, serverIdFor, isIpv4 };
