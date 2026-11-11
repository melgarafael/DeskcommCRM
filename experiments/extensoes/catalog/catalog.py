#!/usr/bin/env python3
"""Catálogo local de ensaio: SQLite próprio, publicação offline e HTTP somente loopback."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, NoReturn
from urllib.parse import urlsplit


PACKAGE_BYTES = 64 * 1024
CATALOG_ENTRIES = 128
CATALOG_REVISION = 999_999_999
VERSION_CHARACTERS = 64
FORBIDDEN_KEYS = {"__proto__", "prototype", "constructor"}
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
DIGEST_PATH = re.compile(r"^/packages/([a-f0-9]{64})\.json$")
ICONS = {"ListChecks", "BookOpen", "Lightbulb"}


class CatalogError(Exception):
    pass


# Espelho de `lib/extensions/capacidades.ts` (ADR-0003). Este processo é isolado de propósito
# — SQLite próprio, sem o banco do CRM —, então não dá para importar o TypeScript daqui. O par
# é vigiado por `tests/unit/catalogo-de-ensaio-espelha-o-vocabulario.test.ts`, que reprova
# quando as duas listas divergem: sem ele, a bancada volta a publicar pacote que o host recusa,
# e o sintoma aparece só no E2E, como "instalação falhou" sem causa visível.
PERMISSOES = [
    "navigation.tasks",
    "navigation.inbox",
    "navigation.kanban",
    "navigation.contacts",
    "navigation.agenda",
    "navigation.radar",
    "theme.apply",
    "dados.proprios",
    # O consentimento para um tema de extensão pintar o produto (ADR-0003, #1095).
    # A ordem espelha `EXTENSION_PERMISSIONS` em `lib/extensions/capacidades.ts` —
    # `tests/unit/catalogo-de-ensaio-espelha-o-vocabulario.test.ts` compara as duas.
    # Áreas do CRM do módulo conectado (spec 33, F1): mesma ordem das 11 áreas, leitura e escrita.
    "area.contatos.leitura",
    "area.contatos.escrita",
    "area.negocios.leitura",
    "area.negocios.escrita",
    "area.conversas.leitura",
    "area.conversas.escrita",
    "area.agenda.leitura",
    "area.agenda.escrita",
    "area.funis.leitura",
    "area.funis.escrita",
    "area.agentes_ia.leitura",
    "area.agentes_ia.escrita",
    "area.catalogo.leitura",
    "area.catalogo.escrita",
    "area.configuracao.leitura",
    "area.configuracao.escrita",
    "area.analise.leitura",
    "area.analise.escrita",
]
CAPACIDADES = [
    "tasks.open",
    "inbox.open",
    "kanban.open",
    "contacts.open",
    "agenda.open",
    "radar.open",
]
HOST_API_ATUAL = 2


def fail(message: str) -> NoReturn:
    raise CatalogError(message)


def safe_unicode(value: str) -> bool:
    return "\x00" not in value and not any(0xD800 <= ord(character) <= 0xDFFF for character in value)


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in FORBIDDEN_KEYS or not safe_unicode(key):
            fail("chave proibida no JSON")
        if key in result:
            fail("chave duplicada no JSON")
        if len(result) >= 32:
            fail("objeto excede 32 propriedades")
        result[key] = value
    return result


def strict_json(data: bytes) -> Any:
    if len(data) > PACKAGE_BYTES:
        fail("pacote excede 64 KiB")
    try:
        text = data.decode("utf-8", errors="strict")
        return json.loads(
            text,
            object_pairs_hook=strict_object,
            parse_constant=lambda _value: fail("constante não permitida no JSON"),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise CatalogError("JSON UTF-8 inválido") from error


def exact_keys(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"estrutura inválida em {label}")
    return value


def positive_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        fail(f"inteiro positivo esperado em {label}")
    return value


def text(value: Any, limit: int, label: str) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > limit
        or not safe_unicode(value)
    ):
        fail(f"texto inválido em {label}")
    return value


def localized(value: Any, limit: int, label: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) not in ({"pt-BR"}, {"pt-BR", "es"}):
        fail(f"texto localizado inválido em {label}")
    text(value["pt-BR"], limit, f"{label}.pt-BR")
    if "es" in value:
        text(value["es"], limit, f"{label}.es")
    return value


def validate_manifest(value: Any) -> dict[str, Any]:
    manifest = exact_keys(
        value,
        {
            "format_version",
            "profile",
            "publisher",
            "name",
            "version",
            "license",
            "host_api",
            "permissions",
            "dependencies",
            "data",
            "display",
            "configuration",
            "contributions",
        },
        "manifesto",
    )
    profile = manifest["profile"]
    if manifest["format_version"] != 1 or profile not in ("declarative", "connected"):
        fail("formato ou perfil não suportado")
    for field in ("publisher", "name"):
        value = manifest[field]
        if not isinstance(value, str) or not 2 <= len(value) <= 64 or not SLUG.fullmatch(value):
            fail(f"slug inválido em {field}")
    if (
        not isinstance(manifest["version"], str)
        or len(manifest["version"]) > VERSION_CHARACTERS
        or not SEMVER.fullmatch(manifest["version"])
    ):
        fail("versão inválida")
    if manifest["license"] != "MIT":
        fail("licença não suportada")

    host_api = exact_keys(manifest["host_api"], {"min", "max"}, "host_api")
    minimum = positive_integer(host_api["min"], "host_api.min")
    maximum = positive_integer(host_api["max"], "host_api.max")
    if minimum > maximum:
        fail("faixa host_api invertida")
    permissoes = manifest["permissions"]
    if (
        not isinstance(permissoes, list)
        or not permissoes
        or len(set(map(str, permissoes))) != len(permissoes)
        or any(p not in PERMISSOES for p in permissoes)
        or manifest["dependencies"] != []
    ):
        fail("permissões ou dependências não suportadas")
    # Espelho de `manifest.ts`: permissão de área é do perfil conectado e de mais nenhum, e o
    # perfil conectado só declara permissão de área (Spec 33, F1).
    areas = [p for p in permissoes if p.startswith("area.")]
    if profile == "connected" and len(areas) != len(permissoes):
        fail("perfil conectado só declara permissão de área")
    if profile != "connected" and areas:
        fail("permissão de área só existe no perfil conectado")
    if manifest["data"] != {"mode": "none"}:
        fail("modo de dados não suportado")

    display = exact_keys(manifest["display"], {"title", "summary", "category", "icon"}, "display")
    localized(display["title"], 100, "display.title")
    localized(display["summary"], 400, "display.summary")
    if display["category"] not in {"productivity", "sales", "service"} or display["icon"] not in ICONS:
        fail("apresentação inválida")

    if profile == "connected":
        # Sem card, sem tema, sem configuração de card: o perfil conectado só tem a tela do serviço.
        exact_keys(manifest["configuration"], set(), "configuration")
        exact_keys(manifest["contributions"], set(), "contributions")
        return manifest

    configuration = exact_keys(
        manifest["configuration"], {"density", "show_description"}, "configuration"
    )
    if configuration["density"] not in {"comfortable", "compact"} or not isinstance(
        configuration["show_description"], bool
    ):
        fail("configuração inválida")

    contributions = exact_keys(manifest["contributions"], {"crm_cards"}, "contributions")
    cards = contributions["crm_cards"]
    if not isinstance(cards, list) or len(cards) > 4:
        fail("lista de cards inválida")
    for card in cards:
        card = exact_keys(
            card, {"id", "title", "description", "icon", "blocks", "action"}, "card"
        )
        text(card["id"], PACKAGE_BYTES, "card.id")
        localized(card["title"], 100, "card.title")
        localized(card["description"], 400, "card.description")
        if card["icon"] not in ICONS:
            fail("ícone de card inválido")
        if not isinstance(card["blocks"], list) or len(card["blocks"]) > 8:
            fail("blocos inválidos")
        for block in card["blocks"]:
            block = exact_keys(block, {"heading", "body"}, "bloco")
            localized(block["heading"], 100, "block.heading")
            localized(block["body"], 2000, "block.body")
        action = exact_keys(card["action"], {"label", "capability"}, "action")
        localized(action["label"], 100, "action.label")
        if action["capability"] not in CAPACIDADES:
            fail("capacidade não suportada")
    return manifest


def validate_local_origin(origin: str) -> None:
    parsed = urlsplit(origin)
    try:
        port = parsed.port
    except ValueError as error:
        raise CatalogError("origem local inválida") from error
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != ""
        or parsed.query != ""
        or parsed.fragment != ""
        or port is None
        or f"http://127.0.0.1:{port}" != origin
    ):
        fail("a origem do ensaio deve ser HTTP exato em 127.0.0.1 com porta")


SCHEMA = """
pragma foreign_keys = on;
create table if not exists settings (
  singleton integer primary key check (singleton = 1),
  origin text not null
);
create table if not exists packages (
  sha256 text primary key check (length(sha256) = 64),
  publisher text not null,
  name text not null,
  version text not null,
  byte_length integer not null,
  entry_json text not null,
  artifact blob not null,
  unique (publisher, name, version)
);
create table if not exists catalog_snapshots (
  revision integer primary key,
  sha256 text not null unique,
  snapshot blob not null
);
"""


def connect(db: pathlib.Path) -> sqlite3.Connection:
    connection = sqlite3.connect(db)
    connection.execute("pragma foreign_keys = on")
    return connection


def command_init(args: argparse.Namespace) -> None:
    validate_local_origin(args.origin)
    args.db.parent.mkdir(parents=True, exist_ok=True)
    with connect(args.db) as connection:
        connection.executescript(SCHEMA)
        row = connection.execute("select origin from settings where singleton = 1").fetchone()
        if row is not None and row[0] != args.origin:
            fail("o banco já pertence a outra origem")
        connection.execute(
            "insert or ignore into settings (singleton, origin) values (1, ?)", (args.origin,)
        )


def command_make_example(args: argparse.Namespace) -> None:
    manifest = {
        "format_version": 1,
        "profile": "declarative",
        "publisher": "laboratorio-local",
        "name": "tarefas-praticas",
        "version": "1.0.0",
        "license": "MIT",
        "host_api": {"min": 1, "max": HOST_API_ATUAL},
        "permissions": ["navigation.tasks"],
        "dependencies": [],
        "data": {"mode": "none"},
        "display": {
            "title": {"pt-BR": "Tarefas práticas", "es": "Tareas prácticas"},
            "summary": {"pt-BR": "Orientações para organizar o próximo passo."},
            "category": "productivity",
            "icon": "ListChecks",
        },
        "configuration": {"density": "comfortable", "show_description": True},
        "contributions": {
            "crm_cards": [
                {
                    "id": "organizar-proximo-passo",
                    "title": {"pt-BR": "Organize o próximo passo"},
                    "description": {"pt-BR": "Use a lista existente para manter o trabalho visível."},
                    "icon": "BookOpen",
                    "blocks": [
                        {
                            "heading": {"pt-BR": "Revise antes de criar"},
                            "body": {"pt-BR": "Confira as tarefas abertas e escolha a próxima ação."},
                        }
                    ],
                    "action": {
                        "label": {"pt-BR": "Abrir tarefas"},
                        "capability": "tasks.open",
                    },
                }
            ]
        },
    }
    data = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    validate_manifest(strict_json(data))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with args.output.open("xb") as output:
            output.write(data)
    except FileExistsError as error:
        raise CatalogError("o arquivo de pacote já existe") from error


def entry_from_manifest(
    manifest: dict[str, Any],
    digest: str,
    byte_length: int,
    service_origin: str | None = None,
) -> dict[str, Any]:
    entry = {
        "publisher": manifest["publisher"],
        "name": manifest["name"],
        "version": manifest["version"],
        "license": manifest["license"],
        "host_api": manifest["host_api"],
        "display": manifest["display"],
        "permissions": manifest["permissions"],
        "sha256": digest,
        "byte_length": byte_length,
    }
    if service_origin is not None:
        # Spec 33, F1: o endereço do serviço mora na entrada do catálogo revisado.
        entry["service_origin"] = service_origin
    return entry


def command_publish(args: argparse.Namespace) -> None:
    data = args.manifest.read_bytes()
    manifest = validate_manifest(strict_json(data))
    digest = hashlib.sha256(data).hexdigest()
    service_origin = args.service_origin
    if service_origin is not None:
        if manifest["profile"] != "connected":
            fail("--service-origin só vale para um pacote do perfil conectado")
        validate_local_origin(service_origin)
    elif manifest["profile"] == "connected":
        fail("um pacote conectado precisa de --service-origin")
    entry = entry_from_manifest(manifest, digest, len(data), service_origin)
    entry_json = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
    with connect(args.db) as connection:
        if service_origin is not None:
            # A exceção de laboratório do host aceita UMA origem http: a do catálogo. O serviço mora nela.
            origem_do_catalogo = connection.execute(
                "select origin from settings where singleton = 1"
            ).fetchone()
            if origem_do_catalogo is None or origem_do_catalogo[0] != service_origin:
                fail("a origem do serviço de ensaio precisa ser a do catálogo")
        existing = connection.execute(
            "select sha256 from packages where publisher = ? and name = ? and version = ?",
            (manifest["publisher"], manifest["name"], manifest["version"]),
        ).fetchone()
        if existing is not None:
            if existing[0] != digest:
                fail("identidade já publicada com bytes diferentes")
        else:
            connection.execute(
                "insert into packages (sha256,publisher,name,version,byte_length,entry_json,artifact) values (?,?,?,?,?,?,?)",
                (
                    digest,
                    manifest["publisher"],
                    manifest["name"],
                    manifest["version"],
                    len(data),
                    entry_json,
                    data,
                ),
            )
    print(digest)


def command_export(args: argparse.Namespace) -> None:
    if args.output.exists():
        fail("o arquivo de admissão já existe")
    with connect(args.db) as connection:
        connection.execute("begin immediate")
        origin_row = connection.execute("select origin from settings where singleton = 1").fetchone()
        if origin_row is None:
            fail("catálogo não inicializado")
        rows = connection.execute(
            "select entry_json from packages order by publisher, name, version"
        ).fetchall()
        if len(rows) > CATALOG_ENTRIES:
            fail("catálogo excede 128 entradas")
        revision = connection.execute(
            "select coalesce(max(revision), 0) + 1 from catalog_snapshots"
        ).fetchone()[0]
        if revision > CATALOG_REVISION:
            fail("revisão do catálogo excede nove dígitos")
        snapshot = {
            "format_version": 1,
            "origin": origin_row[0],
            "revision": revision,
            "entries": [json.loads(row[0]) for row in rows],
        }
        data = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        digest = hashlib.sha256(data).hexdigest()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        try:
            with args.output.open("xb") as output:
                output.write(data)
            connection.execute(
                "insert into catalog_snapshots (revision, sha256, snapshot) values (?, ?, ?)",
                (revision, digest, data),
            )
            connection.commit()
        except Exception:
            args.output.unlink(missing_ok=True)
            raise
    print(digest)


def handler_for(db: pathlib.Path, ensaio: Any = None) -> type[BaseHTTPRequestHandler]:
    database_uri = f"{db.resolve().as_uri()}?mode=ro"

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _responder_ensaio(self, metodo: str, corpo: bytes) -> bool:
            """Entrega a requisição ao módulo de ensaio, quando ele está ligado. `True` = atendeu."""
            if ensaio is None:
                return False
            resposta = ensaio.atender(metodo, self.path, self.headers, corpo)
            if resposta is None:
                return False
            status, tipo, conteudo = resposta
            self.send_response(status)
            self.send_header("Content-Type", tipo)
            self.send_header("Content-Length", str(len(conteudo)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(conteudo)
            return True

        def do_POST(self) -> None:
            try:
                tamanho = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                tamanho = -1
            if tamanho < 0 or tamanho > 16 * 1024:
                self.send_error(413)
                return
            corpo = self.rfile.read(tamanho) if tamanho else b""
            if not self._responder_ensaio("POST", corpo):
                self.send_error(404)

        def do_GET(self) -> None:
            if self._responder_ensaio("GET", b""):
                return
            match = DIGEST_PATH.fullmatch(self.path)
            if match is None:
                self.send_error(404)
                return
            with sqlite3.connect(database_uri, uri=True) as connection:
                row = connection.execute(
                    "select artifact from packages where sha256 = ?", (match.group(1),)
                ).fetchone()
            if row is None:
                self.send_error(404)
                return
            artifact = bytes(row[0])
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(artifact)))
            self.send_header("Content-Encoding", "identity")
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.send_header("ETag", f'"sha256-{match.group(1)}"')
            self.end_headers()
            self.wfile.write(artifact)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return Handler


def command_serve(args: argparse.Namespace) -> None:
    if args.host != "127.0.0.1":
        fail("o servidor de ensaio aceita somente --host 127.0.0.1")
    if not args.db.is_file():
        fail("banco do catálogo não encontrado")
    ensaio = None
    if args.modulo_de_ensaio:
        # Import tardio de propósito: `catalog.py` também é carregado por `importlib` (os testes), que
        # não põe a pasta dele em `sys.path`; e o módulo de ensaio só existe quando alguém o pede.
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
        from modulo_de_ensaio import ModuloDeEnsaio

        ensaio = ModuloDeEnsaio()
    server = ThreadingHTTPServer((args.host, args.port), handler_for(args.db, ensaio))
    server.daemon_threads = True
    port = server.server_address[1]
    print(f"http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def path(value: str) -> pathlib.Path:
    return pathlib.Path(value).resolve()


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="cria o banco próprio do catálogo")
    init.add_argument("--db", type=path, required=True)
    init.add_argument("--origin", required=True)
    init.set_defaults(run=command_init)

    example = commands.add_parser("make-example", help="cria um pacote declarativo de ensaio")
    example.add_argument("--output", type=path, required=True)
    example.set_defaults(run=command_make_example)

    publish = commands.add_parser("publish", help="publica bytes imutáveis no SQLite")
    publish.add_argument("--db", type=path, required=True)
    publish.add_argument("--manifest", type=path, required=True)
    publish.add_argument(
        "--service-origin",
        default=None,
        help="origem do serviço de um pacote conectado (grava service_origin na entrada)",
    )
    publish.set_defaults(run=command_publish)

    export = commands.add_parser("export", help="exporta o arquivo offline de admissão")
    export.add_argument("--db", type=path, required=True)
    export.add_argument("--output", type=path, required=True)
    export.set_defaults(run=command_export)

    serve = commands.add_parser("serve", help="serve somente artefatos em loopback")
    serve.add_argument("--db", type=path, required=True)
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8787)
    serve.add_argument(
        "--modulo-de-ensaio",
        action="store_true",
        help="serve também /embed e /ensaio/*: o módulo conectado de ensaio (Spec 33)",
    )
    serve.set_defaults(run=command_serve)
    return root


def main() -> int:
    cli = parser()
    args = cli.parse_args()
    try:
        run: Callable[[argparse.Namespace], None] = args.run
        run(args)
        return 0
    except (CatalogError, FileNotFoundError, sqlite3.Error) as error:
        print(f"erro: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
