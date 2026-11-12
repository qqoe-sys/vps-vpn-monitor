"""Regression tests: real JSON files, mocked Linux service/ownership boundary."""
import json
import io
import os
import subprocess
import tempfile
from pathlib import Path
from pathlib import Path
from pathlib import Path
import unittest
from unittest.mock import patch, Mock

from cascade_tune_test import tune, exit_cfg


class ApplySafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'config.json')
        with open(self.path, 'w') as f:
            json.dump(exit_cfg(), f)
        self.original = Path(self.path).read_bytes()
        self.commands = []
        self.fail_timer = False
        self.fail_stop = False
        self.bad_config = False
        self.pending = False
        self.owner_changes = []
        self.active = True
        self.uid, self.gid = os.stat(self.path).st_uid, os.stat(self.path).st_gid
        for name, value in [('config_path', lambda: self.path),
                            ('STATE_DIR', self.tmp.name),
                            ('LAST_BACKUP', os.path.join(self.tmp.name, 'last')),
                            ('run', self.run_command),
                            ('xray_active', lambda: self.active)]:
            p = patch.object(tune, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(tune.os, 'chown', self.chown, create=True)
        p.start()
        self.addCleanup(p.stop)

    def chown(self, path, uid, gid):
        self.owner_changes.append((str(path), uid, gid))

    def run_command(self, *cmd, **kwargs):
        self.commands.append(cmd)
        rc = 1 if (self.fail_timer and cmd[0] == 'systemd-run') else 0
        if cmd[:2] == ('systemctl', 'stop') and self.fail_stop:
            rc = 1
        # No existing transaction; a newly armed timer is active.
        if cmd[:2] == ('systemctl', 'is-active'):
            active = self.pending or (any(c[0] == 'systemd-run' for c in self.commands) and not self.fail_timer)
            rc = 0 if active else 3
        if cmd[0] == 'runuser' and self.bad_config:
            rc = 1
        if cmd[:2] == ('systemctl', 'show'):
            return subprocess.CompletedProcess(cmd, 0, 'xray\n', '')
        return subprocess.CompletedProcess(cmd, rc, '', 'simulated failure' if rc == 1 else '')

    def test_apply_preserves_owner_on_candidate_and_backup(self):
        result = tune.apply({'role': 'exit'})
        self.assertTrue(result['ok'])
        self.assertIn((tune.temp_config_path(self.path), self.uid, self.gid), self.owner_changes)
        backup = Path(tune.LAST_BACKUP).read_text().strip()
        self.assertIn((backup, self.uid, self.gid), self.owner_changes)
        self.assertEqual(json.loads(Path(self.path).read_text())['inbounds'][0]['settings']['clients'][0]['flow'], tune.VISION)

    def test_timer_failure_leaves_live_config_untouched(self):
        self.fail_timer = True
        try:
            result = tune.apply({'role': 'exit'})
            self.assertFalse(result['ok'])
        except RuntimeError:
            pass
        self.assertEqual(Path(self.path).read_bytes(), self.original)
        self.assertNotIn(('systemctl', 'restart', 'xray'), self.commands)

    def test_rollback_restores_owner(self):
        tune.apply({'role': 'exit'})
        self.owner_changes.clear()
        result = tune.rollback({})
        self.assertTrue(result['ok'])
        self.assertEqual(Path(self.path).read_bytes(), self.original)
        self.assertIn((self.path, self.uid, self.gid), self.owner_changes)

    def test_failed_start_restores_owner(self):
        self.active = False
        result = tune.apply({'role': 'exit'})
        self.assertFalse(result['ok'])
        self.assertEqual(Path(self.path).read_bytes(), self.original)
        self.assertIn((self.path, self.uid, self.gid), self.owner_changes)

    def test_confirm_reports_stop_failure(self):
        self.fail_stop = True
        try:
            result = tune.confirm({})
            self.assertFalse(result['ok'])
        except RuntimeError:
            pass

    def test_missing_backup_does_not_disarm_timer(self):
        result = tune.rollback({})
        self.assertFalse(result['ok'])
        self.assertFalse(any(c[:2] == ('systemctl', 'stop') for c in self.commands))

    def test_unreadable_baseline_prevents_apply(self):
        self.bad_config = True
        try:
            result = tune.apply({'role': 'exit'})
            self.assertFalse(result['ok'])
        except RuntimeError:
            pass
        self.assertEqual(Path(self.path).read_bytes(), self.original)
        self.assertNotIn(('systemctl', 'restart', 'xray'), self.commands)

    def test_plan_reports_unreadable_config(self):
        self.bad_config = True
        result = tune.plan({'role': 'exit'})
        self.assertFalse(result['ok'])
        self.assertNotIn(('systemctl', 'restart', 'xray'), self.commands)

    def test_unreadable_legacy_backup_prevents_rollback(self):
        tune.apply({'role': 'exit'})
        current = Path(self.path).read_bytes()
        self.commands.clear()
        self.bad_config = True
        try:
            result = tune.rollback({})
            self.assertFalse(result['ok'])
        except RuntimeError:
            pass
        self.assertEqual(Path(self.path).read_bytes(), current)
        self.assertNotIn(('systemctl', 'restart', 'xray'), self.commands)

    def test_pending_transaction_preserves_backup_pointer(self):
        with open(tune.LAST_BACKUP, 'w') as f:
            f.write('previous-backup.json')
        self.pending = True
        with self.assertRaises(RuntimeError):
            tune.apply({'role': 'exit'})
        self.assertEqual(Path(tune.LAST_BACKUP).read_text(), 'previous-backup.json')


class ProbeCoverage(unittest.TestCase):
    def test_checks_all_advertised_names_including_third(self):
        cfg = exit_cfg()
        cfg['inbounds'][0]['streamSettings']['realitySettings']['serverNames'] = ['one.test', 'two.test', 'three.test']
        def opened(path, *args, **kwargs):
            return io.StringIO(json.dumps(cfg) if path == 'fixture.json' else '')
        def command(*cmd, **kwargs):
            value = '204' if cmd[-1].endswith('generate_204') else '198.51.100.20'
            return subprocess.CompletedProcess(cmd, 0, value, '')
        with patch.object(tune, 'config_path', return_value='fixture.json'), \
             patch.object(tune, 'open', opened, create=True), \
             patch.object(tune, 'public_key', return_value='fake-public'), \
             patch.object(tune, 'run', command), \
             patch.object(tune.subprocess, 'Popen', return_value=Mock()), \
             patch.object(tune.time, 'sleep'), patch.object(tune.os, 'remove'):
            result = tune.probe({'exitIp': '198.51.100.20'})
        self.assertTrue(result['ok'])
        self.assertEqual([p['sni'] for p in result['probes']], ['one.test', 'two.test', 'three.test'])


if __name__ == '__main__':
    unittest.main()
