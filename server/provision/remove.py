#!/usr/bin/env python3
# step:remove
# Удаляет только то, что программа внедрила сама (список в манифесте).
# Без манифеста сервер настроен вручную: убираем лишь сборщик трафика.
import json
import os
import posixpath
import shutil
import subprocess
import sys

ROOT = os.environ.get('VPSMON_ROOT', '')
NO_SYSTEM = bool(os.environ.get('VPSMON_NO_SYSTEM'))
MANIFEST = '/var/lib/vpsmon/manifest.json'
AUTH_KEYS = '/root/.ssh/authorized_keys'

# Что бы ни было записано в манифесте, удалять можно только внутри этих путей.
ALLOWED = (
    '/usr/local/bin/xray', '/usr/local/share/xray', '/usr/local/etc/xray', '/usr/local/lib/vpsmon',
    '/var/lib/vpsmon', '/etc/systemd/system/xray.service', '/etc/systemd/system/vpsmon-collector.',
    '/etc/sysctl.d/99-vpsmon',
)
COLLECTOR_ONLY = {
    'files': ['/etc/systemd/system/vpsmon-collector.service', '/etc/systemd/system/vpsmon-collector.timer',
              '/usr/local/lib/vpsmon', '/var/lib/vpsmon'],
    'units': ['vpsmon-collector.timer', 'vpsmon-collector.service'],
    'ufwRules': [], 'users': [], 'appKey': None,
}


def system(*cmd):
    if not NO_SYSTEM:
        subprocess.run(cmd, capture_output=True, timeout=60)


def allowed(path):
    # posixpath: пути в манифесте всегда серверные. Сравнение отсекает хитрости вроде "/../".
    return posixpath.normpath(path) == path and path.startswith(ALLOWED)


def remove_path(path):
    if not allowed(path):
        return False
    full = ROOT + path
    if os.path.isdir(full):
        shutil.rmtree(full)
    elif os.path.exists(full):
        os.unlink(full)
    return True


def drop_app_key(key):
    if not key:
        return
    full = ROOT + AUTH_KEYS
    # newline='' сохраняет строки чужих ключей байт в байт.
    with open(full, newline='') as f:
        lines = f.readlines()
    keep = [line for line in lines if line.strip() != key.strip()]
    tmp = full + '.vpsmon'
    with open(tmp, 'w', newline='') as f:
        f.writelines(keep)
    os.chmod(tmp, 0o600)
    os.replace(tmp, full)


def load_manifest():
    try:
        with open(ROOT + MANIFEST) as f:
            return json.load(f), True
    except FileNotFoundError:
        return dict(COLLECTOR_ONLY), False


def main():
    data, has_manifest = load_manifest()
    if '--only-app-key' in sys.argv:
        drop_app_key(data.get('appKey'))
        print(json.dumps({'removed': ['app-key']}))
        return

    system('systemctl', 'stop', 'vpsmon-ufw-guard.timer')
    for unit in data['units']:
        system('systemctl', 'disable', '--now', unit)
    for rule in data['ufwRules']:
        system('sh', '-c', 'ufw delete ' + rule)

    removed = []
    # Папку с манифестом убираем последней: без него повтор не будет знать, что удалять.
    for path in sorted(data['files'], key=lambda p: p == '/var/lib/vpsmon'):
        if remove_path(path):
            removed.append(path)
    system('systemctl', 'daemon-reload')
    for user in data.get('users', []):
        if user == 'xray':
            system('userdel', user)

    if has_manifest:
        remove_path('/var/lib/vpsmon')
    if '--drop-app-key' in sys.argv:
        drop_app_key(data.get('appKey'))
    print(json.dumps({'removed': removed}))


if __name__ == '__main__':
    main()
