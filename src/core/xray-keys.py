# Запускается на сервере. Читает ключи Xray или безопасно меняет конфиг.
# Порядок правки: копия -> проверка `xray run -test` -> бэкап -> замена ->
# перезапуск -> проверка службы и портов -> при сбое откат на бэкап.
import base64, fcntl, json, os, re, shutil, subprocess, tempfile, time

REQUEST = json.loads(base64.b64decode('__REQUEST__'))
NAME_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}$')
SUFFIX_RE = re.compile(r'-(xhttp|vision)$')


class Refused(Exception):
    pass


def run(*cmd, timeout=30):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def config_path():
    out = run('systemctl', 'show', 'xray', '-p', 'ExecStart', '--value').stdout
    m = re.search(r'(?:-c|-config|--config)[ =](\S+)', out)
    if not m:
        raise Refused('@E:xray_config_missing')
    return m.group(1)


def key_inbounds(config):
    # from-entry принимает только входной сервер каскада, клиентских ключей там нет.
    return [i for i in config['inbounds']
            if i.get('protocol') == 'vless' and 'clients' in (i.get('settings') or {})
            and i.get('tag') != 'from-entry']


def suffix(inbound):
    return '-xhttp' if inbound['streamSettings'].get('network') == 'xhttp' else '-vision'


# На одних серверах ключ называется одинаково во всех входах (key01),
# на других по входам (user1-xhttp, user1-vision). Новый ключ повторяет уже принятую схему.
def email_for(name, inbound):
    used = any(SUFFIX_RE.search(c.get('email', '')) for c in inbound['settings']['clients'])
    return name + suffix(inbound) if used else name


def key_name(email):
    return SUFFIX_RE.sub('', email)


def public_key(private):
    out = run('xray', 'x25519', '-i', private).stdout
    m = re.search(r'^(?:Public key|Password(?: \(PublicKey\))?):\s*(\S+)', out, re.M | re.I)
    return m.group(1) if m else None


def inventory(config):
    inbounds, keys = [], {}
    for ib in key_inbounds(config):
        stream = ib['streamSettings']
        reality = stream.get('realitySettings') or {}
        xhttp = stream.get('xhttpSettings') or {}
        clients = ib['settings']['clients']
        inbounds.append({
            'tag': ib.get('tag'), 'port': ib['port'], 'net': stream.get('network'),
            'sni': (reality.get('serverNames') or [None])[0],
            'pbk': public_key(reality['privateKey']) if reality.get('privateKey') else None,
            'sid': (reality.get('shortIds') or [''])[0],
            'path': xhttp.get('path'), 'mode': xhttp.get('mode'),
            'flow': next((c.get('flow') for c in clients if c.get('flow')), None),
        })
        for c in clients:
            k = keys.setdefault(key_name(c.get('email', '')), [])
            # email нужен, чтобы новый сервер повторил его точно (по нему идёт учёт трафика)
            k.append({'tag': ib.get('tag'), 'id': c['id'], 'email': c.get('email', '')})
    return {'inbounds': inbounds, 'keys': [{'name': n, 'entries': e} for n, e in sorted(keys.items())]}


def add_key(config, name, uuid, profile=None):
    if not NAME_RE.match(name) or SUFFIX_RE.search(name):
        raise Refused('@E:bad_key_name')
    inbounds = key_inbounds(config)
    # Имя должно быть уникально на всём сервере, а ключ добавляется только в свой режим.
    if any(key_name(c.get('email', '')) == name for i in inbounds for c in i['settings']['clients']):
        raise Refused('@E:key_exists')
    if profile:
        inbounds = [i for i in inbounds if str(i.get('tag', '')).startswith(profile + '-')]
    if not inbounds:
        raise Refused('@E:no_vless_inbounds')
    for ib in inbounds:
        clients = ib['settings']['clients']
        # Копируем поля существующего клиента (например flow), меняем только id и email.
        client = dict(clients[0]) if clients else {}
        client.update(id=uuid, email=email_for(name, ib))
        clients.append(client)


def delete_key(config, name):
    found = False
    for ib in key_inbounds(config):
        clients = ib['settings']['clients']
        keep = [c for c in clients if key_name(c.get('email', '')) != name]
        if len(keep) != len(clients):
            found = True
        if not keep:
            raise Refused('@E:last_key')
        ib['settings']['clients'] = keep
    if not found:
        raise Refused('@E:no_such_key')


def healthy(config):
    time.sleep(2)
    if run('systemctl', 'is-active', 'xray').stdout.strip() != 'active':
        return False
    listening = run('ss', '-tlnH').stdout
    return all(re.search(r':%d\s' % i['port'], listening) for i in key_inbounds(config))


def apply_config(config, path, dry):
    st = os.stat(path)
    fd, tmp = tempfile.mkstemp(prefix='.vpsmon-', suffix='.json', dir='/run' if dry else os.path.dirname(path))
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        os.chown(tmp, st.st_uid, st.st_gid)
        os.chmod(tmp, st.st_mode & 0o777)
        test = run('xray', 'run', '-test', '-config', tmp)
        if test.returncode != 0:
            raise Refused('@E:xray_rejected_config')
        if dry:
            return
        backup = '%s.bak.vpsmon.%s' % (path, time.strftime('%Y%m%dT%H%M%S'))
        shutil.copy2(path, backup)
        os.replace(tmp, path)
        tmp = None
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)
    run('systemctl', 'restart', 'xray')
    if not healthy(config):
        shutil.copy2(backup, path)
        run('systemctl', 'restart', 'xray')
        raise Refused('@E:xray_rolled_back')


def main():
    path = config_path()
    action = REQUEST['action']
    if action == 'list':
        with open(path) as f:
            return inventory(json.load(f))
    # Блокировка не даёт двум изменениям идти одновременно.
    with open('/run/vpsmon.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with open(path) as f:
            config = json.load(f)
        if action == 'add':
            add_key(config, REQUEST['name'], REQUEST['uuid'], REQUEST.get('profile'))
        elif action == 'delete':
            delete_key(config, REQUEST['name'])
        else:
            raise Refused('@E:unknown_action')
        apply_config(config, path, REQUEST.get('dry', False))
    return inventory(config)


try:
    print(json.dumps({'ok': True, 'data': main()}))
except Refused as e:
    print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok': False, 'error': '@E:server_exception|%s' % type(e).__name__}, ensure_ascii=False))
