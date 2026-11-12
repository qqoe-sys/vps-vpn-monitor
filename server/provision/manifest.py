#!/usr/bin/env python3
# Список всего, что программа внедрила на сервер. По нему работает удаление и откат.
# Запись делается ДО действия: при сбое посередине останется, что убирать.
import json
import os
import sys

PATH = os.environ.get('VPSMON_ROOT', '') + '/var/lib/vpsmon/manifest.json'


def load():
    with open(PATH) as f:
        return json.load(f)


def save(data):
    tmp = PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, PATH)


def main():
    cmd = sys.argv[1]
    if cmd == 'init':
        save({'status': 'incomplete', 'files': [], 'ufwRules': [], 'units': [], 'users': [], 'appKey': sys.argv[2]})
    elif cmd == 'add':
        data = load()
        for value in sys.argv[3:]:
            if value not in data[sys.argv[2]]:
                data[sys.argv[2]].append(value)
        save(data)
    elif cmd == 'status':
        data = load()
        data['status'] = sys.argv[2]
        save(data)


if __name__ == '__main__':
    main()
