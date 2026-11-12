# Тесты server/replace/exit-link.py: параметры звена, прочитанные с конфига выхода.
# Запуск: python test/exit_link_test.py
import copy
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('exitlink', os.path.join(HERE, '..', 'server', 'replace', 'exit-link.py'))
exitlink = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exitlink)


def exit_cfg():
    # Форма реального конфига выхода : один inbound tcp+reality, один клиент с Vision.
    return {'inbounds': [
        {'tag': 'api', 'protocol': 'dokodemo-door', 'port': 10085},
        {'tag': 'inbound-443', 'protocol': 'vless', 'port': 443,
         'settings': {'clients': [{'id': 'LINK-UUID', 'flow': 'xtls-rprx-vision', 'email': 'link'}], 'decryption': 'none'},
         'streamSettings': {'network': 'tcp', 'security': 'reality',
                            'realitySettings': {'dest': 'www.bmw.de:443', 'serverNames': ['www.bmw.de'],
                                                'privateKey': 'PRIV', 'shortIds': ['ab', 'cd']}}},
    ]}


class LinkParams(unittest.TestCase):
    def test_vpsg(self):
        p = exitlink.link_params(exit_cfg())
        self.assertEqual(p, {'port': 443, 'uuid': 'LINK-UUID', 'flow': 'xtls-rprx-vision',
                             'shortId': 'ab', 'sni': 'www.bmw.de', 'network': 'tcp', 'privateKey': 'PRIV'})

    def test_no_flow_is_empty_string(self):
        cfg = exit_cfg()
        del cfg['inbounds'][1]['settings']['clients'][0]['flow']
        self.assertEqual(exitlink.link_params(cfg)['flow'], '')
        cfg['inbounds'][1]['settings']['clients'][0]['flow'] = None
        self.assertEqual(exitlink.link_params(cfg)['flow'], '')

    def test_two_clients(self):
        cfg = exit_cfg()
        cfg['inbounds'][1]['settings']['clients'].append({'id': 'X', 'email': 'x'})
        with self.assertRaisesRegex(ValueError, '@E:exit_many_clients'):
            exitlink.link_params(cfg)

    def test_no_reality(self):
        cfg = copy.deepcopy(exit_cfg())
        cfg['inbounds'][1]['streamSettings']['security'] = 'none'
        with self.assertRaises(ValueError):
            exitlink.link_params(cfg)


if __name__ == '__main__':
    unittest.main()
