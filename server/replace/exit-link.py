#!/usr/bin/env python3
# Параметры звена вход -> выход, прочитанные с конфига Xray ВЫХОДА (ничего не подставляется).
# Аргумент — base64 от JSON {"entryHost": "..."} (entryHost только для информации).
# Печатает JSON {ok, port, uuid, flow, publicKey, shortId, sni, network}; приватный ключ не печатает.

import base64
import json
import os
import re
import subprocess
import sys


def run(*cmd, timeout=30):
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)


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


def link_params(cfg):
    """Чистая функция: параметры звена из конфига выхода (без publicKey, но с privateKey для его расчёта)."""
    pairs = []  # (inbound, client) для всех vless+reality inbound
    has_reality = False
    for ib in cfg.get('inbounds', []):
        ss = ib.get('streamSettings') or {}
        if ib.get('protocol') != 'vless' or ss.get('security') != 'reality':
            continue
        has_reality = True
        for c in (ib.get('settings') or {}).get('clients', []):
            pairs.append((ib, c))
    if not has_reality:
        raise ValueError('@E:exit_no_reality')
    if len(pairs) != 1:
        raise ValueError('@E:exit_no_clients' if not pairs else '@E:exit_many_clients')
    ib, client = pairs[0]
    ss = ib['streamSettings']
    rs = ss['realitySettings']
    short_ids = [s for s in rs.get('shortIds', []) if s]
    names = rs.get('serverNames') or []
    if not short_ids or not names:
        raise ValueError('@E:exit_reality_incomplete')
    return {
        'port': ib['port'],
        'uuid': client['id'],
        # flow ВСЕГДА строка: пропавший flow молча сломал бы Vision-звено
        'flow': client.get('flow') or '',
        'shortId': short_ids[0],
        'sni': names[0],
        'network': ss.get('network', 'tcp'),
        'privateKey': rs['privateKey'],
    }


def main():
    json.loads(base64.b64decode(sys.argv[1]).decode('utf-8')) if len(sys.argv) > 1 else None
    try:
        with open(config_path(), encoding='utf-8') as f:
            p = link_params(json.load(f))
        p['publicKey'] = public_key(p.pop('privateKey'))
        print(json.dumps(dict(ok=True, **p)))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
