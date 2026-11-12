#!/usr/bin/env python3
# Публикация сайта подписок. Запускается VPS-VPN Monitor по SSH, данные приходят в stdin:
#   {"files": {"путь": "содержимое", ...}, "caddyfile": "...", "port": 8443}
# Порядок: проверить конфиг Caddy -> записать новый релиз -> (если конфиг другой) подменить
# и перезагрузить Caddy -> атомарно переключить симлинк current -> открыть порт в UFW.
# При любой ошибке сайт остаётся прежним. Печатает одну строку JSON.

import json
import os
import re
import shutil
import subprocess
import sys
import time

# Пути и команды можно подменить переменными окружения — только для тестов.
BASE = os.environ.get('VPSMON_BASE', '/var/www/vpsmon-sub')
CADDYFILE = os.environ.get('VPSMON_CADDYFILE', '/etc/caddy/Caddyfile')
CADDY = os.environ.get('VPSMON_CADDY', 'caddy')
SYSTEMCTL = os.environ.get('VPSMON_SYSTEMCTL', 'systemctl')
UFW = os.environ.get('VPSMON_UFW', 'ufw')
RELEASES = os.path.join(BASE, 'releases')
CURRENT = os.path.join(BASE, 'current')
PORT_FILE = os.path.join(BASE, 'port')
PATH_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_./-]*$')
TOKEN_RE = re.compile(r'[A-Za-z0-9_-]{43}')
RESERVED_PORTS = {22, 80, 443, 2019}  # SSH, сертификат, Xray, админка Caddy
KEEP = 1  # старые релизы с отозванными ссылками не храним


def scrub(msg):
    # Код ссылки в пути к файлу — секрет: в сообщение об ошибке он попасть не должен.
    return TOKEN_RE.sub('…', str(msg))[:300]


def done(**result):
    if 'error' in result:
        result['error'] = scrub(result['error'])
    print(json.dumps(result))
    sys.exit(0)


def safe_path(p):
    return bool(PATH_RE.match(p)) and '..' not in p.split('/') and not p.startswith('/')


def valid_port(port):
    return isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535 and port not in RESERVED_PORTS


def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60)


def last_line(r):
    lines = (r.stderr or r.stdout or '').strip().splitlines()
    return lines[-1] if lines else '@E:no_details'


def read(path):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        return ''


def write(path, text):
    # Права явно: Caddy работает от своего пользователя и должен читать файлы и конфиг.
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    os.chmod(path, 0o644)


def write_release(files):
    rel = time.strftime('%Y%m%dT%H%M%S', time.gmtime())
    target = os.path.join(RELEASES, rel)
    if os.path.exists(target):
        rel = '%s-%d' % (rel, os.getpid())
        target = os.path.join(RELEASES, rel)
    for p, content in files.items():
        full = os.path.join(target, p)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        write(full, content)
    for root, dirs, _ in os.walk(target):
        os.chmod(root, 0o755)
        for d in dirs:
            os.chmod(os.path.join(root, d), 0o755)
    return rel, target


def switch_current(target):
    tmp = CURRENT + '.new'
    if os.path.lexists(tmp):
        os.remove(tmp)
    os.symlink(target, tmp)
    os.replace(tmp, CURRENT)  # атомарная подмена симлинка


def prune(keep_target):
    for d in os.listdir(RELEASES):
        path = os.path.join(RELEASES, d)
        if path != keep_target and os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)


def open_port(port):
    # Сайт может переехать на другой порт: открываем новый, закрываем прежний.
    if not shutil.which(UFW):
        return
    old = read(PORT_FILE).strip()
    run(UFW, 'allow', '%d/tcp' % port)
    if old.isdigit() and int(old) != port and valid_port(int(old)):
        run(UFW, 'delete', 'allow', '%s/tcp' % old)
    write(PORT_FILE, str(port))


def main():
    os.umask(0o022)
    data = json.load(sys.stdin)
    files, caddy, port = data.get('files'), data.get('caddyfile'), data.get('port')
    if not shutil.which(CADDY):
        done(ok=False, error='@E:caddy_missing')
    if not isinstance(files, dict) or 'index.html' not in files or not isinstance(caddy, str):
        done(ok=False, error='@E:site_incomplete')
    if not valid_port(port):
        done(ok=False, error='@E:site_bad_port')
    for p, content in files.items():
        if not safe_path(p) or not isinstance(content, str):
            done(ok=False, error='@E:site_bad_path')

    old_caddy = read(CADDYFILE)
    caddy_changed = caddy != old_caddy
    new_conf = CADDYFILE + '.vpsmon.new'
    if caddy_changed:
        write(new_conf, caddy)
        r = run(CADDY, 'validate', '--adapter', 'caddyfile', '--config', new_conf)
        if r.returncode != 0:
            os.remove(new_conf)
            done(ok=False, error='caddy validate: ' + last_line(r))

    os.makedirs(RELEASES, exist_ok=True)
    os.chmod(BASE, 0o755)
    os.chmod(RELEASES, 0o755)
    rel, target = write_release(files)

    if caddy_changed:
        os.replace(new_conf, CADDYFILE)
        r = run(SYSTEMCTL, 'reload', 'caddy')
        if r.returncode != 0:
            # Откат: старый конфиг и старый релиз остаются в работе.
            write(CADDYFILE, old_caddy)
            run(SYSTEMCTL, 'reload', 'caddy')
            shutil.rmtree(target, ignore_errors=True)
            done(ok=False, error='@E:caddy_rejected|' + last_line(r).replace('|', '/'))

    switch_current(target)
    open_port(port)
    prune(target)
    done(ok=True, release=rel)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — любая ошибка должна вернуться в программу как JSON
        done(ok=False, error=e)
