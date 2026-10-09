#!/usr/bin/env python3
"""Exporta ou aplica modelos Auth a partir da marca resolvida pelo app (Python 3)."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.request import Request, HTTPRedirectHandler
from urllib.parse import urlparse


MODELOS = (
    'confirmation', 'recovery', 'invite', 'magic_link', 'email_change',
    'reauthentication', 'password_changed_notification', 'email_changed_notification',
    'phone_changed_notification', 'identity_linked_notification',
    'identity_unlinked_notification', 'mfa_factor_enrolled_notification',
    'mfa_factor_unenrolled_notification',
)
CAMPOS = {campo for modelo in MODELOS for campo in (
    f'mailer_subjects_{modelo}', f'mailer_templates_{modelo}_content',
)}


class SemRedirecionamento(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Redirecionamento recusado")


def requisicao(url, token=None, dados=None):
    from urllib.request import build_opener
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if dados is not None:
        headers["Content-Type"] = "application/json"
    req = Request(url, headers=headers, data=json.dumps(dados).encode() if dados is not None else None,
                  method="PATCH" if dados is not None else "GET")
    with build_opener(SemRedirecionamento()).open(req, timeout=30) as res:
        return json.load(res)


def salvar(caminho, dados):
    fd = os.open(caminho, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-url", required=True)
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--diretorio", required=True, help="Diretório privado NOVO para exportação/backup")
    parser.add_argument("--token-file", help="Arquivo 0600 contendo somente o token Management API")
    parser.add_argument("--aplicar", action="store_true")
    args = parser.parse_args()
    app = urlparse(args.app_url)
    if app.scheme != "https" or not app.hostname or app.path not in ('', '/') or app.username or app.password or app.query or app.fragment:
        raise ValueError("Use a URL HTTPS do app sem credenciais, query ou fragmento")
    if not re.fullmatch(r"[a-z]{20}", args.project_ref):
        raise ValueError("Ref de projeto inválido")
    pasta = Path(args.diretorio)
    pasta.mkdir(mode=0o700, parents=True, exist_ok=False)
    config = requisicao(args.app_url.rstrip('/') + "/email-templates/config")
    if not isinstance(config, dict) or set(config) != CAMPOS or any(
        not isinstance(v, str) or not v for v in config.values()
    ):
        raise ValueError("App não retornou o catálogo completo de modelos")
    salvar(pasta / "modelos.json", config)
    for chave, valor in config.items():
        if chave.startswith("mailer_templates_"):
            modelo = chave.removeprefix("mailer_templates_").removesuffix("_content")
            (pasta / (modelo + ".html")).write_text(valor)
    if not args.aplicar:
        print("Modelos exportados. Nada alterado no Supabase. Não há sincronização automática.")
        return
    if not args.token_file:
        raise ValueError("Aplicação exige --token-file; não forneça token na linha de comando")
    arquivo = Path(args.token_file)
    if arquivo.stat().st_mode & 0o077:
        raise ValueError("Arquivo do token deve ter permissão 0600")
    token = arquivo.read_text().strip()
    api = "https://api.supabase.com/v1/projects/" + args.project_ref
    projeto = requisicao(api, token)
    if projeto.get("id") != args.project_ref:
        raise ValueError("Identidade do projeto não confirmada")
    atual = requisicao(api + "/config/auth", token)
    site = urlparse(atual.get("site_url", ""))
    if (site.scheme, site.netloc) != (app.scheme, app.netloc):
        raise ValueError("Site URL do projeto difere do app; nada foi alterado")
    if any(k not in atual for k in config):
        raise ValueError("Projeto não oferece todos os campos; nada foi alterado")
    # Backup somente dos campos afetados; não grava SMTP/segredos de Auth.
    salvar(pasta / "antes.json", {k: atual[k] for k in config})
    requisicao(api + "/config/auth", token, config)
    depois = requisicao(api + "/config/auth", token)
    if any(depois.get(k) != v for k, v in config.items()):
        raise ValueError("Releitura divergente. Preserve antes.json para recuperação")
    salvar(pasta / "verificado.json", {k: depois[k] for k in config})
    print("Modelos aplicados e conferidos campo a campo. Repita após mudar a marca; não há agendamento automático.")


if __name__ == "__main__":
    try:
        main()
    except Exception as erro:
        # Nunca imprimir corpo remoto, cabeçalhos ou credencial.
        print("Operação não concluída: " + (str(erro) if isinstance(erro, ValueError) else type(erro).__name__), file=sys.stderr)
        sys.exit(1)
