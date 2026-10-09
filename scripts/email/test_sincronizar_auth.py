import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sync', Path(__file__).with_name('sincronizar-auth.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class Sincronizacao(unittest.TestCase):
    def run_sync(self, site='https://app.example.test', divergir=False):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            token = root / 'token'
            token.write_text('credencial-sintetica')
            token.chmod(0o600)
            pasta = root / 'backup'
            config = {campo: f'Novo {i}' for i, campo in enumerate(sorted(sync.CAMPOS))}
            anterior = {k: 'Anterior' for k in config}
            chamadas = []
            def request(url, segredo=None, dados=None):
                chamadas.append((url, dados))
                if url.endswith('/email-templates/config'):
                    return config
                if not url.endswith('/config/auth'):
                    return {'id': 'a'*20}
                if dados is not None:
                    self.assertEqual(json.loads((pasta/'antes.json').read_text()), anterior)
                    self.assertEqual((pasta/'antes.json').stat().st_mode & 0o777, 0o600)
                    self.assertEqual(dados, config)
                    return config
                if len(chamadas) >= 5:
                    return anterior if divergir else config
                return {**anterior, 'site_url': site, 'smtp_pass': 'nunca-salvar'}
            args = ['sync', '--app-url', 'https://app.example.test', '--project-ref', 'a'*20,
                    '--diretorio', str(pasta), '--aplicar', '--token-file', str(token)]
            with patch.object(sync, 'requisicao', side_effect=request), patch('sys.argv', args), contextlib.redirect_stdout(io.StringIO()):
                try:
                    sync.main()
                except ValueError:
                    self.assertFalse((pasta/'verificado.json').exists())
                    if site != 'https://app.example.test':
                        self.assertFalse(any(dados is not None for _, dados in chamadas))
                    raise
            self.assertEqual(json.loads((pasta/'verificado.json').read_text()), config)
            self.assertNotIn('smtp_pass', (pasta/'antes.json').read_text())
    def test_backup_antes_do_patch_e_releitura(self):
        self.run_sync()
    def test_projeto_de_outro_app_nao_recebe_patch(self):
        with self.assertRaises(ValueError):
            self.run_sync(site='https://outro.example.test')
    def test_aceitou_e_ignorou_nao_e_sucesso(self):
        with self.assertRaises(ValueError):
            self.run_sync(divergir=True)

if __name__ == '__main__':
    unittest.main()
