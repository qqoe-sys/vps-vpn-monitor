#!/usr/bin/env python3
# Сборщик трафика. Работает на сервере по таймеру systemd.
# Читает счётчики (без сброса) и копит прирост по дням в одном файле.
# Логика повторяет src/core/traffic-store.js, совпадение проверяет автотест.
import argparse
import json
import os
import subprocess
import tempfile
from datetime import date, datetime, timedelta, timezone

try:
    import fcntl
except ImportError:  # на Windows модуля нет, он нужен только на сервере
    fcntl = None

SERVER_KEY = '__server__'
KEEP_DAYS = 400
STATE_FILE = '/var/lib/vpsmon/traffic.json'
LOCK_FILE = '/run/vpsmon-collector.lock'


def read_net():
    """Счётчики интерфейса, через который идёт маршрут по умолчанию."""
    iface = None
    with open('/proc/net/route') as f:
        for line in f.readlines()[1:]:
            parts = line.split()
            if parts[1] == '00000000':
                iface = parts[0]
                break
    if not iface:
        return None
    with open('/proc/net/dev') as f:
        for line in f:
            name, _, data = line.partition(':')
            if name.strip() == iface:
                fields = data.split()
                return {'rx': int(fields[0]), 'tx': int(fields[8])}
    return None


def read_stats(port):
    """Счётчики ключей Xray. None означает, что API не ответил."""
    if not port:
        return None
    try:
        out = subprocess.run(
            ['/usr/local/bin/xray', 'api', 'statsquery', '--server=127.0.0.1:%d' % port],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout
        entries = json.loads(out)['stat']
    except (OSError, subprocess.SubprocessError, ValueError, KeyError):
        return None
    users = {}
    for entry in entries:
        parts = str(entry.get('name')).split('>>>')
        if len(parts) != 4 or parts[0] != 'user' or parts[2] != 'traffic':
            continue
        user = users.setdefault(parts[1], {'up': 0, 'down': 0})
        value = int(entry.get('value', 0))  # Xray не присылает value, когда он равен нулю
        if parts[3] == 'uplink':
            user['up'] = value
        elif parts[3] == 'downlink':
            user['down'] = value
    return users


def new_state():
    return {'counters': {}, 'days': {}, 'baseline': {}, 'since': None}


def add_sample(rec, day, name, up, down, is_first_poll):
    last = rec['counters'].get(name)
    rec['counters'][name] = {'up': up, 'down': down}
    if last is None and is_first_poll:
        rec['baseline'][name] = {'up': up, 'down': down}
        return
    last = last or {'up': 0, 'down': 0}
    # Значение меньше прошлого значит, что счётчик обнулился: весь объём новый.
    d_up = up - last['up'] if up >= last['up'] else up
    d_down = down - last['down'] if down >= last['down'] else down
    if d_up == 0 and d_down == 0:
        return
    bucket = rec['days'].setdefault(day, {}).setdefault(name, {'up': 0, 'down': 0})
    bucket['up'] += d_up
    bucket['down'] += d_down


def update(rec, day, net, stats):
    if rec['since'] is None:
        rec['since'] = day
    if net:
        add_sample(rec, day, SERVER_KEY, net['tx'], net['rx'], SERVER_KEY not in rec['counters'])
    if stats is not None:
        first = not any(n != SERVER_KEY for n in rec['counters'])
        for name, c in stats.items():
            add_sample(rec, day, name, c['up'], c['down'], first)
    oldest = (date.fromisoformat(day) - timedelta(days=KEEP_DAYS)).isoformat()
    for d in [d for d in rec['days'] if d < oldest]:
        del rec['days'][d]


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return new_state()


def save(rec, path):
    # Пишем во временный файл и подменяем: сбой посреди записи не испортит историю.
    fd, tmp = tempfile.mkstemp(prefix='.traffic-', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(rec, f, separators=(',', ':'))
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stats-port', type=int, default=0)
    parser.add_argument('--utc-offset', type=int, default=7)
    parser.add_argument('--dry-run', action='store_true', help='только показать счётчики')
    args = parser.parse_args()

    tz = timezone(timedelta(hours=args.utc_offset))
    day = datetime.now(tz).date().isoformat()
    net = read_net()
    stats = read_stats(args.stats_port)
    if args.dry_run:
        print(json.dumps({'day': day, 'net': net, 'keys': None if stats is None else len(stats)}))
        return
    with open(LOCK_FILE, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        rec = load(STATE_FILE)
        update(rec, day, net, stats)
        save(rec, STATE_FILE)


if __name__ == '__main__':
    main()
