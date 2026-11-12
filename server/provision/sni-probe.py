#!/usr/bin/env python3
# step:sni-probe
# Проверяет с самого сервера, какие сайты подходят для маскировки. Ничего не меняет.
# Ищет и "соседей": сайты на соседних IP той же сети выглядят для цензора естественнее всего.
import base64
import http.client
import json
import re
import socket
import ssl
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

NEIGHBOURS = 32


def run(cmd, data=None, timeout=8):
    try:
        return subprocess.run(cmd, input=data, capture_output=True, text=True, timeout=timeout, errors='replace').stdout
    except (OSError, subprocess.SubprocessError):
        return ''


def s_client(target, servername):
    return run(['openssl', 's_client', '-connect', target + ':443', '-servername', servername,
                '-tls1_3', '-groups', 'X25519', '-alpn', 'h2', '-brief'], data='', timeout=6) + run(
        ['openssl', 's_client', '-connect', target + ':443', '-servername', servername,
         '-tls1_3', '-groups', 'X25519', '-alpn', 'h2'], data='', timeout=6)


def redirects_away(domain):
    ctx = ssl.create_default_context()
    conn = http.client.HTTPSConnection(domain, 443, timeout=5, context=ctx)
    try:
        conn.request('HEAD', '/', headers={'User-Agent': 'Mozilla/5.0'})
        res = conn.getresponse()
        location = res.getheader('Location') or ''
        if 300 <= res.status < 400 and location.startswith('http'):
            host = re.sub(r'^https?://', '', location).split('/')[0].split(':')[0].lower()
            return host.removeprefix('www.') != domain.lower().removeprefix('www.')
        return False
    except (OSError, http.client.HTTPException, ssl.SSLError):
        return True
    finally:
        conn.close()


def check(domain):
    started = time.monotonic()
    try:
        socket.create_connection((domain, 443), timeout=4).close()
    except OSError:
        return None
    ms = round((time.monotonic() - started) * 1000)
    out = s_client(domain, domain)
    return {
        'domain': domain,
        'ms': ms,
        'tls13': 'TLSv1.3' in out,
        'h2': bool(re.search(r'ALPN protocol: h2', out)),
        'x25519': 'X25519' in out,
        'redirect': redirects_away(domain),
    }


def own_ip():
    out = run(['ip', '-4', 'route', 'get', '1.1.1.1'])
    m = re.search(r'src (\d+\.\d+\.\d+\.\d+)', out)
    return m.group(1) if m else None


def cert_domain(ip):
    try:
        socket.create_connection((ip, 443), timeout=2).close()
    except OSError:
        return None
    pem = run(['openssl', 's_client', '-connect', ip + ':443', '-tls1_3'], data='', timeout=5)
    san = run(['openssl', 'x509', '-noout', '-ext', 'subjectAltName'], data=pem, timeout=5)
    for name in re.findall(r'DNS:([^,\s]+)', san):
        if '*' not in name:
            return name
    return None


def neighbours():
    ip = own_ip()
    if not ip:
        return []
    a, b, c, d = map(int, ip.split('.'))
    hosts = [f'{a}.{b}.{c}.{n}' for n in range(max(1, d - NEIGHBOURS // 2), min(255, d + NEIGHBOURS // 2)) if n != d]
    with ThreadPoolExecutor(16) as pool:
        return [x for x in pool.map(cert_domain, hosts) if x]


def main():
    request = json.loads(base64.b64decode(sys.argv[1]))
    domains = list(request['candidates'])
    if request.get('subnetScan'):
        domains += neighbours()
    with ThreadPoolExecutor(8) as pool:
        results = [r for r in pool.map(check, list(dict.fromkeys(domains))) if r]
    print(json.dumps(results))


if __name__ == '__main__':
    main()
