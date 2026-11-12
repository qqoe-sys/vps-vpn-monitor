#!/usr/bin/env python3
# Настройка каскада: Vision на звене вход -> выход и смена SNI (маскировки) входа.
# Запускается программой по SSH (проверка пути probe в мастере замены входа). Аргумент — base64 от JSON-запроса:
#   {"action": "plan|apply|probe|confirm|rollback", "role": "entry|exit",
#    "exitIp": "198.51.100.20", "sni": "mask.example.net", "dropOld": false}
# Безопасность изменений:
#   * перед правкой — бэкап конфига и `xray run -test`;
#   * если Xray после перезапуска не поднялся — сразу возврат бэкапа;
#   * «мёртвая рука»: через DEADMAN секунд бэкап вернётся сам, если ПК не подтвердит (confirm).
# Секреты (UUID, ключи) скрипт не печатает.

import base64
import copy
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time

VISION = 'xtls-rprx-vision'
SNI_RE = re.compile(r'^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$')
DEADMAN = 600  # 10 минут на проверку и подтверждение
TIMER = 'vpsmon-tune-rollback'
STATE_DIR = '/var/lib/vpsmon'
LAST_BACKUP = os.path.join(STATE_DIR, 'tune-last-backup')
PROBE_PORT = 10899


# ---------- чистые преобразования конфига (покрыты тестами) ----------

def reality_inbounds(cfg):
    return [i for i in cfg.get('inbounds', []) if i.get('protocol') == 'vless'
            and (i.get('streamSettings') or {}).get('security') == 'reality']


def tune_exit(cfg):
    """Выход: Vision для клиентов звена (входящий VLESS+Reality по TCP)."""
    cfg = copy.deepcopy(cfg)
    changes = []
    inbounds = reality_inbounds(cfg)
    if not inbounds:
        raise ValueError('@E:exit_no_reality')
    for ib in inbounds:
        if ib['streamSettings'].get('network', 'tcp') not in ('tcp', 'raw'):
            raise ValueError('@E:vision_needs_tcp|%s|%s' % (ib.get('tag'), ib['streamSettings'].get('network')))
        for c in ib['settings']['clients']:
            if c.get('flow') != VISION:
                c['flow'] = VISION
                changes.append('%s: client flow -> %s' % (ib.get('tag'), VISION))
    return cfg, changes


def link_outbound(cfg, exit_ip):
    for o in cfg.get('outbounds', []):
        vnext = (o.get('settings') or {}).get('vnext') or []
        if o.get('protocol') == 'vless' and vnext and vnext[0].get('address') == exit_ip:
            return o
    raise ValueError('@E:no_outbound_to_exit|%s' % exit_ip)


def check_sni(sni):
    if not isinstance(sni, str) or not SNI_RE.match(sni):
        raise ValueError('@E:bad_sni|%s' % sni)


def tune_entry(cfg, exit_ip, sni):
    """Вход: Vision на звене к выходу + новый SNI первым, прежние имена остаются (переходный период)."""
    check_sni(sni)
    cfg = copy.deepcopy(cfg)
    changes = []
    out = link_outbound(cfg, exit_ip)
    if out['streamSettings'].get('network', 'tcp') not in ('tcp', 'raw'):
        raise ValueError('@E:link_not_tcp')
    for u in out['settings']['vnext'][0]['users']:
        if u.get('flow') != VISION:
            u['flow'] = VISION
            changes.append('%s: link flow -> %s' % (out.get('tag'), VISION))
    for ib in reality_inbounds(cfg):
        r = ib['streamSettings']['realitySettings']
        dest_key = 'target' if 'target' in r and 'dest' not in r else 'dest'
        if r.get(dest_key) != sni + ':443':
            changes.append('%s: dest %s -> %s:443' % (ib.get('tag'), r.get(dest_key), sni))
            r[dest_key] = sni + ':443'
        names = [sni] + [n for n in r.get('serverNames', []) if n != sni]
        if names != r.get('serverNames'):
            changes.append('%s: serverNames -> %s' % (ib.get('tag'), names))
            r['serverNames'] = names
    return cfg, changes


def drop_old_sni(cfg):
    """Конец переходного периода: оставить только первое (текущее) имя."""
    cfg = copy.deepcopy(cfg)
    changes = []
    for ib in reality_inbounds(cfg):
        r = ib['streamSettings']['realitySettings']
        if len(r.get('serverNames', [])) > 1:
            changes.append('%s: serverNames %s -> %s' % (ib.get('tag'), r['serverNames'], r['serverNames'][:1]))
            r['serverNames'] = r['serverNames'][:1]
    return cfg, changes


def probe_client(cfg, tag, sni, public_key, port):
    """Временный клиент для проверки «вход -> выход -> интернет» прямо с входного сервера."""
    ib = next(i for i in reality_inbounds(cfg) if i.get('tag') == tag)
    stream = ib['streamSettings']
    client = ib['settings']['clients'][0]
    user = {'id': client['id'], 'encryption': 'none'}
    if client.get('flow'):
        user['flow'] = client['flow']
    r = stream['realitySettings']
    out_stream = {
        'network': stream.get('network', 'tcp'), 'security': 'reality',
        'realitySettings': {'serverName': sni, 'fingerprint': 'firefox', 'publicKey': public_key,
                            'shortId': (r.get('shortIds') or [''])[0]},
    }
    if out_stream['network'] == 'xhttp':
        x = stream.get('xhttpSettings') or {}
        out_stream['xhttpSettings'] = {'path': x.get('path', '/'), 'mode': x.get('mode', 'auto')}
    return {
        'log': {'loglevel': 'none'},
        'inbounds': [{'listen': '127.0.0.1', 'port': port, 'protocol': 'socks', 'settings': {'udp': False}}],
        'outbounds': [{'protocol': 'vless', 'settings': {'vnext': [{'address': '127.0.0.1', 'port': ib['port'], 'users': [user]}]},
                       'streamSettings': out_stream}],
    }


def describe(cfg, exit_ip=None):
    """Сводка без секретов: что сейчас настроено."""
    info = {'inbounds': [], 'link': None}
    for ib in reality_inbounds(cfg):
        r = ib['streamSettings']['realitySettings']
        info['inbounds'].append({
            'tag': ib.get('tag'), 'port': ib.get('port'), 'network': ib['streamSettings'].get('network', 'tcp'),
            'dest': r.get('dest') or r.get('target'), 'serverNames': r.get('serverNames'),
            'clients': len(ib['settings']['clients']),
            'flows': sorted({c.get('flow') or '' for c in ib['settings']['clients']}),
        })
    if exit_ip:
        try:
            o = link_outbound(cfg, exit_ip)
            info['link'] = {'tag': o.get('tag'), 'network': o['streamSettings'].get('network', 'tcp'),
                            'flow': o['settings']['vnext'][0]['users'][0].get('flow') or ''}
        except ValueError as e:
            info['link'] = str(e)
    return info


# ---------- работа на сервере ----------

def run(*cmd, timeout=30, data=None):
    # errors='replace': openssl s_client печатает сырые байты от сервера (кадр HTTP/2 SETTINGS),
    # и строгий UTF-8 падал бы на них с UnicodeDecodeError.
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace',
                          timeout=timeout, input=data)


def temp_config_path(path):
    # Xray определяет формат конфига по расширению, поэтому временный файл тоже *.json.
    base = path[:-5] if path.endswith('.json') else path
    return base + '.tune-new.json'


def config_path():
    out = run('systemctl', 'cat', 'xray').stdout
    m = re.search(r'-c(?:onfig)?[ =](\S+\.json)', out)
    for p in ([m.group(1)] if m else []) + ['/etc/xray/config.json', '/usr/local/etc/xray/config.json']:
        if os.path.exists(p):
            return p
    raise RuntimeError('@E:xray_config_missing')


def public_key(private):
    out = run('xray', 'x25519', '-i', private).stdout
    m = re.search(r'^(?:Public key|Password(?: \(PublicKey\))?):\s*(\S+)', out, re.M | re.I)
    if not m:
        raise RuntimeError('@E:reality_pubkey')
    return m.group(1)


def parse_tls(text):
    # Полный вывод openssl s_client (без -brief: в кратком нет строки ALPN).
    return {'tls13': 'TLSv1.3' in text, 'h2': 'ALPN protocol: h2' in text, 'x25519': 'X25519' in text}


def sni_ok(sni):
    """Подходит ли сайт для Reality: TLS 1.3 + h2 + X25519, и куда он резолвится."""
    out = run('openssl', 's_client', '-connect', sni + ':443', '-servername', sni, '-tls1_3',
              '-groups', 'X25519', '-alpn', 'h2', data='', timeout=10)
    try:
        ip = socket.gethostbyname(sni)
    except OSError:
        ip = None
    return dict({'sni': sni, 'ip': ip}, **parse_tls(out.stdout + out.stderr))


def xray_show():
    out = run('systemctl', 'show', 'xray', '-p', 'ActiveState', '-p', 'NRestarts').stdout
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def xray_stable(show=None, sleep=time.sleep, polls=20, need=5):
    """Служба здорова, только если `need` опросов подряд (раз в секунду) она active
    и счётчик перезапусков не растёт. Одиночный «active» в цикле падений не считается:
    именно так 2026-11-10 проверка пропустила permission denied на выходе."""
    show = show or xray_show
    streak, restarts = 0, None
    for _ in range(polls):
        sleep(1)
        s = show()
        if s.get('ActiveState') == 'active' and (restarts is None or s.get('NRestarts') == restarts):
            streak += 1
            restarts = s.get('NRestarts')
            if streak >= need:
                return True
        else:
            streak, restarts = 0, None
    return False


def xray_active():
    return xray_stable()


def stop_deadman():
    stopped = run('systemctl', 'stop', TIMER + '.timer')
    if stopped.returncode != 0:
        raise RuntimeError('@E:guard_stop_failed')
    run('systemctl', 'reset-failed', TIMER + '.service', TIMER + '.timer')


def preserve_owner(source, destination):
    # copy2/copymode НЕ переносят UID/GID. Без chown root:xray превращается
    # в root:root, и служба под пользователем xray теряет доступ к JSON.
    st = os.stat(source)
    os.chown(destination, st.st_uid, st.st_gid)
    shutil.copymode(source, destination)


def copy_config(source, destination):
    shutil.copy2(source, destination)
    preserve_owner(source, destination)


def validate_service_config(path):
    # Проверка от root скрывала permission denied у реальной службы.
    identity = run('systemctl', 'show', 'xray', '-p', 'User', '--value')
    if identity.returncode:
        raise RuntimeError('@E:xray_user_unknown')
    user = identity.stdout.strip() or 'root'
    test = run('runuser', '-u', user, '--', 'xray', 'run', '-test', '-format', 'json', '-config', path, timeout=60)
    if test.returncode:
        raise RuntimeError('@E:config_test_as_user|%s|%s' % (user, path))


def apply(req):
    path = config_path()
    if run('systemctl', 'is-active', TIMER + '.timer').returncode == 0:
        raise RuntimeError('@E:guard_pending')
    validate_service_config(path)
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)
    if req['role'] == 'exit':
        new, changes = tune_exit(cfg)
    elif req.get('dropOld'):
        new, changes = drop_old_sni(cfg)
    else:
        sni = req['sni']
        check = sni_ok(sni)
        if not (check['tls13'] and check['h2'] and check['x25519']):
            return {'ok': False, 'error': '@E:sni_unsuitable|%s|%s' % (sni, check)}
        new, changes = tune_entry(cfg, req['exitIp'], sni)
    if not changes:
        return {'ok': True, 'changes': [], 'note': '@E:already_configured'}

    tmp = temp_config_path(path)
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(new, f, indent=2, ensure_ascii=False)
    preserve_owner(path, tmp)
    validate_service_config(tmp)
    test = run('xray', 'run', '-test', '-config', tmp, timeout=60)
    if test.returncode != 0:
        os.remove(tmp)
        tail = (test.stdout + test.stderr).strip().splitlines()[-1:] or ['']
        return {'ok': False, 'error': '@E:xray_test_failed|' + tail[0][:200].replace('|', '/')}

    backup = '%s.bak.tune.%s.%s' % (path, time.strftime('%Y%m%dT%H%M%S'), time.time_ns())
    copy_config(path, backup)
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LAST_BACKUP, 'w') as f:
        f.write(backup)

    # Отсутствующий старый таймер нормален; действующий означает незавершённую
    # операцию. Не снимаем чужую защиту и не продолжаем без новой.
    run('systemctl', 'reset-failed', TIMER + '.service', TIMER + '.timer')
    restore = 'cp -p -- %s %s && systemctl restart xray' % (shlex.quote(backup), shlex.quote(path))
    armed = run('systemd-run', '--unit=' + TIMER, '--on-active=%d' % DEADMAN, '/bin/sh', '-c', restore)
    if armed.returncode != 0 or run('systemctl', 'is-active', TIMER + '.timer').returncode != 0:
        raise RuntimeError('@E:guard_not_started')

    os.replace(tmp, path)
    run('systemctl', 'restart', 'xray', timeout=60)
    if not xray_active():
        copy_config(backup, path)
        run('systemctl', 'restart', 'xray', timeout=60)
        recovered = xray_active()
        if recovered:
            stop_deadman()
        return {'ok': False, 'error': '@E:xray_rollback_recovered' if recovered else '@E:xray_rollback_still_down'}
    return {'ok': True, 'changes': changes, 'deadman': DEADMAN}


def probe(req):
    """Проверка с входа: каждый вход Reality × каждое имя SNI -> через выход в интернет."""
    path = config_path()
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)
    results = []
    for ib in reality_inbounds(cfg):
        r = ib['streamSettings']['realitySettings']
        pbk = public_key(r['privateKey'])
        for sni in r.get('serverNames', []):
            client = probe_client(cfg, ib.get('tag'), sni, pbk, PROBE_PORT)
            cpath = '/run/vpsmon-probe.json'
            old = os.umask(0o077)
            with open(cpath, 'w') as f:
                json.dump(client, f)
            os.umask(old)
            proc = subprocess.Popen(['xray', 'run', '-config', cpath], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                time.sleep(2)
                proxy = 'socks5h://127.0.0.1:%d' % PROBE_PORT
                code = run('curl', '-s', '-m', '15', '-x', proxy, '-o', '/dev/null', '-w', '%{http_code}',
                           'https://www.gstatic.com/generate_204', timeout=20).stdout.strip()
                ip = run('curl', '-s', '-m', '15', '-x', proxy, 'https://api.ipify.org', timeout=20).stdout.strip()
            finally:
                proc.kill()
                proc.wait()
                os.remove(cpath)
            ok = code == '204' and ip == req['exitIp']
            results.append({'inbound': ib.get('tag'), 'sni': sni, 'http': code, 'exitIp': ip, 'ok': ok})
    return {'ok': all(x['ok'] for x in results) and bool(results), 'probes': results}


def rollback(_req):
    try:
        with open(LAST_BACKUP) as f:
            backup = f.read().strip()
    except FileNotFoundError:
        return {'ok': False, 'error': '@E:no_backup_record'}
    if not os.path.exists(backup):
        return {'ok': False, 'error': '@E:backup_missing|' + backup}
    validate_service_config(backup)
    copy_config(backup, config_path())
    run('systemctl', 'restart', 'xray', timeout=60)
    active = xray_active()
    if active and run('systemctl', 'is-active', TIMER + '.timer').returncode == 0:
        stop_deadman()
    return {'ok': active, 'restored': os.path.basename(backup)}


def confirm(_req):
    stop_deadman()
    return {'ok': True}


def plan(req):
    with open(config_path(), encoding='utf-8') as f:
        cfg = json.load(f)
    info = {'ok': True, 'now': describe(cfg, req.get('exitIp') if req['role'] == 'entry' else None),
            'xray': run('xray', 'version').stdout.splitlines()[:1]}
    try:
        validate_service_config(config_path())
        if req['role'] == 'exit':
            _, info['changes'] = tune_exit(cfg)
        elif req.get('dropOld'):
            _, info['changes'] = drop_old_sni(cfg)
        else:
            _, info['changes'] = tune_entry(cfg, req['exitIp'], req['sni'])
            info['sniCheck'] = sni_ok(req['sni'])
    except (ValueError, RuntimeError) as e:
        info.update(ok=False, error=str(e))
    return info


ACTIONS = {'plan': plan, 'apply': apply, 'probe': probe, 'confirm': confirm, 'rollback': rollback}

if __name__ == '__main__':
    try:
        request = json.loads(base64.b64decode(sys.argv[1]))
        result = ACTIONS[request['action']](request)
    except Exception as e:  # noqa: BLE001 — любая ошибка возвращается как JSON
        result = {'ok': False, 'error': str(e)[:300]}
    print(json.dumps(result, ensure_ascii=False))
