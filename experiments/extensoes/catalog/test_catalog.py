from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request


HERE = pathlib.Path(__file__).resolve().parent
CLI = HERE / "catalog.py"


class CatalogFixtureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.db = self.root / "catalog.sqlite"
        self.package = self.root / "package.json"
        self.catalog = self.root / "catalog-admission.json"
        self.run_cli("init", "--db", self.db, "--origin", "http://127.0.0.1:8787")
        self.run_cli("make-example", "--output", self.package)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_cli(self, *args: object, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CLI), *(str(arg) for arg in args)],
            check=check,
            capture_output=True,
            text=True,
        )

    def test_publica_artefato_e_exporta_snapshot_de_admissao(self) -> None:
        package_bytes = self.package.read_bytes()
        digest = hashlib.sha256(package_bytes).hexdigest()

        published = self.run_cli("publish", "--db", self.db, "--manifest", self.package)
        self.assertEqual(published.stdout.strip(), digest)
        exported = self.run_cli("export", "--db", self.db, "--output", self.catalog)

        snapshot = json.loads(self.catalog.read_text(encoding="utf-8"))
        self.assertEqual(snapshot["format_version"], 1)
        self.assertEqual(snapshot["origin"], "http://127.0.0.1:8787")
        self.assertEqual(snapshot["revision"], 1)
        self.assertEqual(snapshot["entries"][0]["sha256"], digest)
        self.assertEqual(snapshot["entries"][0]["byte_length"], len(package_bytes))
        self.assertEqual(exported.stdout.strip(), hashlib.sha256(self.catalog.read_bytes()).hexdigest())

    def test_identidade_publicada_e_imutavel(self) -> None:
        self.run_cli("publish", "--db", self.db, "--manifest", self.package)
        changed = json.loads(self.package.read_text(encoding="utf-8"))
        changed["display"]["summary"]["pt-BR"] = "Outro conteúdo"
        self.package.write_text(
            json.dumps(changed, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

        conflict = self.run_cli(
            "publish", "--db", self.db, "--manifest", self.package, check=False
        )
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("identidade já publicada", conflict.stderr)

    def test_servidor_expoe_so_artefato_por_digest_e_preserva_bytes(self) -> None:
        digest = self.run_cli(
            "publish", "--db", self.db, "--manifest", self.package
        ).stdout.strip()
        process = subprocess.Popen(
            [
                sys.executable,
                str(CLI),
                "serve",
                "--db",
                str(self.db),
                "--host",
                "127.0.0.1",
                "--port",
                "0",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            assert process.stdout is not None
            origin = process.stdout.readline().strip()
            with urllib.request.urlopen(
                f"{origin}/packages/{digest}.json", timeout=3
            ) as response:
                self.assertEqual(response.read(), self.package.read_bytes())
                self.assertEqual(response.headers["Content-Encoding"], "identity")
                self.assertEqual(response.headers["Cache-Control"], "public, max-age=31536000, immutable")
            with self.assertRaises(urllib.error.HTTPError) as missing:
                urllib.request.urlopen(f"{origin}/catalog.json", timeout=3)
            self.assertEqual(missing.exception.code, 404)
            missing.exception.close()
        finally:
            process.terminate()
            process.wait(timeout=3)
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()

    def test_servidor_recusa_bind_fora_do_loopback_exato(self) -> None:
        refused = self.run_cli(
            "serve",
            "--db",
            self.db,
            "--host",
            "0.0.0.0",
            "--port",
            "8787",
            check=False,
        )
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("127.0.0.1", refused.stderr)

    def test_publicacao_recusa_json_duplicado_e_chaves_de_prototipo(self) -> None:
        for source in (
            '{"publisher":"a","publisher":"b"}',
            '{"__proto__":{}}',
        ):
            self.package.write_text(source, encoding="utf-8")
            refused = self.run_cli(
                "publish", "--db", self.db, "--manifest", self.package, check=False
            )
            self.assertNotEqual(refused.returncode, 0)

    def test_publicacao_recusa_texto_vazio_nul_e_surrogate_isolado(self) -> None:
        base = json.loads(self.package.read_text(encoding="utf-8"))
        for invalid in ("   ", "\x00", "\ud800"):
            manifest = json.loads(json.dumps(base))
            manifest["display"]["title"]["pt-BR"] = invalid
            self.package.write_text(
                json.dumps(manifest, ensure_ascii=True, separators=(",", ":")),
                encoding="utf-8",
            )
            refused = self.run_cli(
                "publish", "--db", self.db, "--manifest", self.package, check=False
            )
            self.assertNotEqual(refused.returncode, 0)

    def test_publicacao_limita_semver_a_64_caracteres(self) -> None:
        manifest = json.loads(self.package.read_text(encoding="utf-8"))
        manifest["version"] = f"1.{'1' * 61}.1"
        self.package.write_text(
            json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        refused = self.run_cli(
            "publish", "--db", self.db, "--manifest", self.package, check=False
        )
        self.assertNotEqual(refused.returncode, 0)


if __name__ == "__main__":
    unittest.main()
