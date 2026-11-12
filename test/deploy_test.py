# Тесты серверного скрипта публикации (только то, что можно проверить без Linux).
# Запуск: python -m unittest test/deploy_test.py
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'server', 'subsite', 'deploy.py')
spec = importlib.util.spec_from_file_location('deploy', SCRIPT)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

TOKEN = 'A' * 20 + 'b_-' + 'C' * 20  # 43 символа


class DeployTest(unittest.TestCase):
    def test_scrub_removes_link_codes(self):
        msg = deploy.scrub('No space left: /var/www/vpsmon-sub/releases/x/s/%s/index.html' % TOKEN)
        self.assertNotIn(TOKEN, msg)
        self.assertIn('No space left', msg)

    def test_safe_path(self):
        self.assertTrue(deploy.safe_path('s/%s/index.html' % TOKEN))
        self.assertFalse(deploy.safe_path('../etc/passwd'))
        self.assertFalse(deploy.safe_path('/etc/passwd'))
        self.assertFalse(deploy.safe_path('s/../../x'))

    def test_valid_port(self):
        self.assertTrue(deploy.valid_port(8443))
        for bad in (443, 22, 80, 2019, 0, 70000, '8443', None):
            self.assertFalse(deploy.valid_port(bad), bad)

    def test_without_caddy_reports_install_first_and_writes_nothing(self):
        base = os.path.join(tempfile.mkdtemp(), 'site')
        env = dict(os.environ, VPSMON_BASE=base, VPSMON_CADDY='no-such-caddy-binary')
        payload = json.dumps({'files': {'index.html': 'x'}, 'caddyfile': 'c', 'port': 8443})
        r = subprocess.run([sys.executable, SCRIPT], input=payload, capture_output=True, text=True, env=env)
        reply = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertFalse(reply['ok'])
        self.assertIn('@E:caddy_missing', reply['error'])
        self.assertFalse(os.path.exists(base))


if __name__ == '__main__':
    unittest.main()
