# Тесты преобразований конфига Xray для server/cascade-tune.py (Vision на звене + смена SNI входа).
# Запуск: python test/cascade_tune_test.py
import copy
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('tune', os.path.join(HERE, '..', 'server', 'cascade-tune.py'))
tune = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tune)

EXIT_IP = '198.51.100.20'
VISION = 'xtls-rprx-vision'


def reality(dest, names):
    return {'show': False, 'dest': dest, 'xver': 0, 'serverNames': names, 'privateKey': 'PRIV', 'shortIds': ['ab']}


def entry_cfg():
    return {
        'inbounds': [
            {'tag': 'api', 'protocol': 'dokodemo-door', 'port': 10085},
            {'tag': 'inbound-443', 'protocol': 'vless', 'port': 443,
             'settings': {'clients': [{'id': 'U1X', 'flow': '', 'email': 'user1-xhttp'}], 'decryption': 'none'},
             'streamSettings': {'network': 'xhttp', 'security': 'reality', 'realitySettings': reality('old-mask.example.com:443', ['old-mask.example.com']),
                                'xhttpSettings': {'mode': 'auto', 'path': '/'}}},
            {'tag': 'inbound-8443', 'protocol': 'vless', 'port': 8443,
             'settings': {'clients': [{'id': 'U1V', 'flow': VISION, 'email': 'user1-vision'}], 'decryption': 'none'},
             'streamSettings': {'network': 'tcp', 'security': 'reality', 'realitySettings': reality('old-mask.example.com:443', ['old-mask.example.com'])}},
        ],
        'outbounds': [
            {'tag': 'to-germany', 'protocol': 'vless',
             'settings': {'vnext': [{'address': EXIT_IP, 'port': 443, 'users': [{'id': 'L1', 'encryption': 'none', 'flow': ''}]}]},
             'streamSettings': {'network': 'tcp', 'security': 'reality',
                                'realitySettings': {'fingerprint': 'firefox', 'serverName': 'exit-mask.example.org', 'publicKey': 'PUB', 'shortId': 'cd'}}},
            {'tag': 'direct', 'protocol': 'freedom'},
        ],
    }


def exit_cfg():
    return {'inbounds': [{'tag': 'inbound-443', 'protocol': 'vless', 'port': 443,
                          'settings': {'clients': [{'id': 'L1', 'flow': ''}], 'decryption': 'none'},
                          'streamSettings': {'network': 'tcp', 'security': 'reality', 'realitySettings': reality('exit-mask.example.org:443', ['exit-mask.example.org'])}}],
            'outbounds': [{'tag': 'direct', 'protocol': 'freedom'}]}


class TuneExit(unittest.TestCase):
    def test_sets_vision_on_link_clients(self):
        cfg, changes = tune.tune_exit(exit_cfg())
        self.assertEqual(cfg['inbounds'][0]['settings']['clients'][0]['flow'], VISION)
        self.assertTrue(changes)

    def test_idempotent(self):
        cfg, _ = tune.tune_exit(exit_cfg())
        _, changes = tune.tune_exit(cfg)
        self.assertEqual(changes, [])

    def test_does_not_touch_reality_or_ids(self):
        before = exit_cfg()
        cfg, _ = tune.tune_exit(copy.deepcopy(before))
        self.assertEqual(cfg['inbounds'][0]['streamSettings'], before['inbounds'][0]['streamSettings'])
        self.assertEqual(cfg['inbounds'][0]['settings']['clients'][0]['id'], 'L1')

    def test_refuses_non_tcp_inbound(self):
        cfg = exit_cfg()
        cfg['inbounds'][0]['streamSettings']['network'] = 'xhttp'
        with self.assertRaises(ValueError):
            tune.tune_exit(cfg)


class TuneEntry(unittest.TestCase):
    def test_link_gets_vision(self):
        cfg, _ = tune.tune_entry(entry_cfg(), EXIT_IP, 'mask.example.net')
        self.assertEqual(cfg['outbounds'][0]['settings']['vnext'][0]['users'][0]['flow'], VISION)

    def test_sni_new_first_old_kept(self):
        cfg, _ = tune.tune_entry(entry_cfg(), EXIT_IP, 'mask.example.net')
        for ib in cfg['inbounds'][1:]:
            r = ib['streamSettings']['realitySettings']
            self.assertEqual(r['dest'], 'mask.example.net:443')
            self.assertEqual(r['serverNames'], ['mask.example.net', 'old-mask.example.com'])

    def test_client_flows_unchanged(self):
        cfg, _ = tune.tune_entry(entry_cfg(), EXIT_IP, 'mask.example.net')
        self.assertEqual(cfg['inbounds'][1]['settings']['clients'][0]['flow'], '')
        self.assertEqual(cfg['inbounds'][2]['settings']['clients'][0]['flow'], VISION)

    def test_switch_to_backup_keeps_all_old_names(self):
        cfg, _ = tune.tune_entry(entry_cfg(), EXIT_IP, 'mask.example.net')
        cfg, _ = tune.tune_entry(cfg, EXIT_IP, 'backup.example.org')
        names = cfg['inbounds'][1]['streamSettings']['realitySettings']['serverNames']
        self.assertEqual(names, ['backup.example.org', 'mask.example.net', 'old-mask.example.com'])

    def test_no_link_outbound_is_error(self):
        with self.assertRaises(ValueError):
            tune.tune_entry(entry_cfg(), '1.2.3.4', 'mask.example.net')

    def test_bad_sni_is_error(self):
        for bad in ('bs 39.ru', 'x;rm', '', 'mask.example.net:443'):
            with self.assertRaises(ValueError):
                tune.tune_entry(entry_cfg(), EXIT_IP, bad)

    def test_drop_old_names(self):
        cfg, _ = tune.tune_entry(entry_cfg(), EXIT_IP, 'mask.example.net')
        cfg, changes = tune.drop_old_sni(cfg)
        self.assertTrue(changes)
        for ib in cfg['inbounds'][1:]:
            self.assertEqual(ib['streamSettings']['realitySettings']['serverNames'], ['mask.example.net'])


class ProbeClient(unittest.TestCase):
    def test_client_for_xhttp_inbound(self):
        c = tune.probe_client(entry_cfg(), 'inbound-443', 'mask.example.net', 'PUBKEY', 10899)
        out = c['outbounds'][0]
        user = out['settings']['vnext'][0]['users'][0]
        self.assertEqual(out['settings']['vnext'][0]['address'], '127.0.0.1')
        self.assertEqual(out['settings']['vnext'][0]['port'], 443)
        self.assertEqual(user['id'], 'U1X')
        self.assertNotIn('flow', user)
        s = out['streamSettings']
        self.assertEqual(s['network'], 'xhttp')
        self.assertEqual(s['xhttpSettings']['path'], '/')
        self.assertEqual(s['realitySettings']['serverName'], 'mask.example.net')
        self.assertEqual(s['realitySettings']['publicKey'], 'PUBKEY')
        self.assertEqual(s['realitySettings']['shortId'], 'ab')
        self.assertEqual(c['inbounds'][0]['listen'], '127.0.0.1')
        self.assertEqual(c['inbounds'][0]['port'], 10899)

    def test_client_for_vision_inbound(self):
        c = tune.probe_client(entry_cfg(), 'inbound-8443', 'old-mask.example.com', 'PUBKEY', 10899)
        user = c['outbounds'][0]['settings']['vnext'][0]['users'][0]
        self.assertEqual(user['flow'], VISION)
        self.assertEqual(c['outbounds'][0]['streamSettings']['network'], 'tcp')


class ParseTls(unittest.TestCase):
    FULL = ('Server Temp Key: X25519, 253 bits\n---\nNew, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384\n'
            'ALPN protocol: h2\n')

    def test_full_output(self):
        self.assertEqual(tune.parse_tls(self.FULL), {'tls13': True, 'h2': True, 'x25519': True})

    def test_no_h2(self):
        self.assertFalse(tune.parse_tls(self.FULL.replace('ALPN protocol: h2', 'No ALPN negotiated'))['h2'])


class RunBinaryOutput(unittest.TestCase):
    def test_binary_bytes_do_not_crash(self):
        # openssl s_client печатает сырые байты HTTP/2 SETTINGS (например 0x80) после рукопожатия.
        import sys
        out = tune.run(sys.executable, '-c', 'import sys; sys.stdout.buffer.write(bytes([0x00, 0x80, 0xff]) + b"ALPN protocol: h2")')
        self.assertTrue(tune.parse_tls(out.stdout)['h2'])


class TempPath(unittest.TestCase):
    def test_keeps_json_extension(self):
        # Xray определяет формат по расширению: временный файл обязан кончаться на .json.
        self.assertEqual(tune.temp_config_path('/etc/xray/config.json'), '/etc/xray/config.tune-new.json')


class XrayStable(unittest.TestCase):
    @staticmethod
    def fake(states):
        # states: список (ActiveState, NRestarts) по одному на каждый опрос
        it = iter(states)

        def show():
            state, restarts = next(it)
            return {'ActiveState': state, 'NRestarts': str(restarts)}
        return show

    def test_crash_loop_is_not_healthy(self):
        # Сегодняшний случай: служба в цикле падений иногда бывает «active».
        states = [('activating', 1), ('active', 2), ('failed', 2), ('active', 3), ('active', 3), ('activating', 4)] * 4
        self.assertFalse(tune.xray_stable(self.fake(states), sleep=lambda _: None))

    def test_active_but_restarting_is_not_healthy(self):
        # Каждый опрос попадает в момент «active», но служба между опросами перезапускается.
        states = [('active', n) for n in range(30)]
        self.assertFalse(tune.xray_stable(self.fake(states), sleep=lambda _: None))

    def test_stable_service_is_healthy(self):
        states = [('activating', 0)] + [('active', 0)] * 10
        self.assertTrue(tune.xray_stable(self.fake(states), sleep=lambda _: None))

    def test_never_starts(self):
        self.assertFalse(tune.xray_stable(self.fake([('failed', 5)] * 30), sleep=lambda _: None))


class Describe(unittest.TestCase):
    def test_no_secrets(self):
        text = repr(tune.describe(entry_cfg(), EXIT_IP))
        for secret in ('U1X', 'U1V', 'L1', 'PRIV', 'PUB'):
            self.assertNotIn(secret, text)
        self.assertIn('old-mask.example.com', text)


if __name__ == '__main__':
    unittest.main()
