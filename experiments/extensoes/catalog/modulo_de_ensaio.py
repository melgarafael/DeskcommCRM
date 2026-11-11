"""Módulo conectado de ensaio (Spec 33): o serviço de exemplo que a prova em tela usa.

Só existe quando o laboratório sobe com `serve --modulo-de-ensaio`. Ele é o LADO DO MÓDULO do
contrato da Spec 33, escrito do mesmo jeito que um módulo real (`modulo-assistente`): a página
`/embed` roda no iframe de OUTRA origem, conversa com o CRM só por `postMessage` e nunca chama o
CRM direto. Quem chama o CRM é este processo, com o token curto do módulo.

  GET  /embed?organization=<uuid>&installation=<uuid>   a página (HTML)
  GET  /embed.js                                        o script da página
  POST /ensaio/configurar                               entrega ao serviço a origem do CRM, a
                                                        instalação e o segredo (só em memória)
  GET  /ensaio/estado                                   {"configurado": bool}
  POST /ensaio/contatos/listar                          GET  /api/v1/contacts  no CRM, como o módulo
  POST /ensaio/contatos/criar                           POST /api/v1/contacts  no CRM, como o módulo

COMO O SERVIÇO OBTÉM O SEGREDO. Não há segredo escrito no repositório. O segredo da instalação nasce
no CRM (botão "Gerar segredo" de `/app/extensions`) e a tela o mostra UMA vez. A prova em tela lê
esse valor da caixa de diálogo, como um administrador faria para copiar, e o entrega a este serviço
por `POST /ensaio/configurar`. O serviço o guarda só na memória do processo: nunca o grava em
arquivo, nunca o escreve em log, nunca o devolve em resposta.

COMO O SERVIÇO OBTÉM O TOKEN. Igual ao `modulo-assistente`: `POST {crm}/api/v1/extensions/token` com
`X-Module-Installation`, `X-Module-Organization`, `X-Module-Timestamp`, `X-Module-Nonce` e
`X-Module-Signature` (HMAC-SHA256 em hex de `${organização}.${carimbo}.${nonce}` com o segredo). Cada
busca gera um token novo e invalida o anterior; o serviço o guarda em memória, por organização, e
renova quando falta pouco para vencer ou quando o CRM responde 401.

O JWT de contexto (a pessoa que clicou) vem da página, que o recebeu do CRM por `postMessage`, e
segue no cabeçalho `X-Module-Context`. Este serviço não o verifica: quem decide é o CRM.

Loopback apenas (o laboratório já se recusa a abrir fora de 127.0.0.1). Nada aqui é para produção.
"""

from __future__ import annotations

import hashlib
import hmac
import html
import json
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, urlsplit

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ORIGEM_EXATA = re.compile(r"^https?://[A-Za-z0-9.\-]+(:\d{1,5})?$")
SEGREDO = re.compile(r"^[A-Za-z0-9_\-]{16,128}$")

MARGEM_DE_RENOVACAO_S = 60
PRAZO_DE_REDE_S = 10

PAGINA = """<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Módulo de ensaio</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; }
    button { margin-right: 8px; padding: 6px 12px; }
    dt { font-weight: 600; margin-top: 8px; }
    dd { margin: 0; }
  </style>
</head>
<body data-host="__HOST__" data-org="__ORG__" data-inst="__INST__">
  <main>
    <h1>Módulo de ensaio</h1>
    <p id="estado" data-testid="ensaio-estado">__ESTADO__</p>
    <p>
      <button id="listar" type="button" disabled>Listar contatos</button>
      <button id="criar" type="button" disabled>Criar contato</button>
    </p>
    <dl>
      <dt>Resposta HTTP</dt><dd id="status" data-testid="ensaio-status">—</dd>
      <dt>Código</dt><dd id="codigo" data-testid="ensaio-codigo">—</dd>
      <dt>Contatos na lista</dt><dd id="total" data-testid="ensaio-total">—</dd>
    </dl>
  </main>
  <script src="/embed.js"></script>
</body>
</html>
"""

SCRIPT = r"""// Tela do módulo de ensaio (roda no iframe, na origem do serviço). Fala com o CRM só por postMessage,
// com a origem conferida nos dois lados e só pela lista fechada de mensagens da Spec 33.
(function () {
  var corpo = document.body;
  var host = corpo.dataset.host;
  var org = corpo.dataset.org;
  var inst = corpo.dataset.inst;
  var estado = document.getElementById("estado");
  var status = document.getElementById("status");
  var codigo = document.getElementById("codigo");
  var total = document.getElementById("total");
  var botaoListar = document.getElementById("listar");
  var botaoCriar = document.getElementById("criar");

  var jwt = null;
  var jwtVenceEm = 0;
  var esperando = [];
  var pediuJwt = false;
  var ocupado = false;

  function dizer(texto, erro) {
    estado.textContent = texto;
    estado.setAttribute("data-erro", erro ? "sim" : "nao");
  }

  function travar(sim) {
    botaoListar.disabled = sim;
    botaoCriar.disabled = sim;
  }

  function venceEmMs(expiresAt) {
    var t = Date.parse(String(expiresAt));
    return isNaN(t) ? Date.now() + 60000 : t;
  }

  // Devolve um JWT válido por pelo menos 20 s; pede outro ao CRM quando precisa.
  function obterJwt() {
    if (jwt && jwtVenceEm - Date.now() > 20000) return Promise.resolve(jwt);
    return new Promise(function (resolve, reject) {
      var feito = false;
      esperando.push(function (j) {
        if (!feito) { feito = true; resolve(j); }
      });
      window.parent.postMessage({ type: "module:request-jwt" }, host);
      setTimeout(function () {
        if (!feito) { feito = true; reject(new Error("sem_jwt")); }
      }, 10000);
    });
  }

  function chamar(caminho, jwtAtual) {
    return fetch(caminho, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-modulo-installation": inst,
        "x-modulo-organization": org,
        "x-modulo-contexto": jwtAtual
      },
      body: "{}"
    }).then(function (r) {
      return r.json().then(function (c) { return c; });
    });
  }

  function mostrar(r) {
    status.textContent = String(r.status);
    codigo.textContent = r.codigo ? String(r.codigo) : "—";
    total.textContent = typeof r.total === "number" ? String(r.total) : "—";
  }

  function acao(caminho) {
    if (ocupado) return;
    ocupado = true;
    travar(true);
    status.textContent = "…";
    codigo.textContent = "…";
    total.textContent = "…";
    obterJwt()
      .then(function (j) { return chamar(caminho, j); })
      .then(mostrar)
      .catch(function () {
        status.textContent = "0";
        codigo.textContent = "sem_resposta";
        total.textContent = "—";
      })
      .then(function () {
        ocupado = false;
        travar(false);
      });
  }

  botaoListar.addEventListener("click", function () { acao("/ensaio/contatos/listar"); });
  botaoCriar.addEventListener("click", function () { acao("/ensaio/contatos/criar"); });

  window.addEventListener("message", function (e) {
    if (e.origin !== host || e.source !== window.parent) return;
    // O CRM serializa a mensagem como TEXTO JSON (`mensagemParaOModulo` em lib/modulo/ponte.ts).
    var m = e.data;
    if (typeof m === "string") {
      try { m = JSON.parse(m); } catch (_) { return; }
    }
    if (!m || typeof m !== "object") return;
    if (m.type === "host:jwt" && typeof m.jwt === "string") {
      jwt = m.jwt;
      jwtVenceEm = venceEmMs(m.expires_at);
      var fila = esperando;
      esperando = [];
      fila.forEach(function (f) { f(jwt); });
      dizer("Conectado ao CRM.", false);
      if (!ocupado) travar(false);
    } else if (m.type === "host:context") {
      // O CRM está escutando: agora sim pedimos o JWT (uma vez; o CRM limita a frequência do pedido).
      if (!pediuJwt) {
        pediuJwt = true;
        window.parent.postMessage({ type: "module:request-jwt" }, host);
      }
    } else if (m.type === "host:error") {
      dizer("O CRM recusou o contexto desta tela (" + String(m.code) + ").", true);
    }
  });

  if (!host || !org || !inst) {
    dizer("Este serviço ainda não recebeu a configuração do ensaio.", true);
    return;
  }

  // O CRM só passa a escutar depois que a página dele termina de carregar, e o iframe pode carregar
  // antes disso. Por isso o "pronto" se repete até o CRM responder com o contexto.
  var tentativas = 0;
  var relogio = setInterval(function () {
    if (pediuJwt || tentativas >= 40) {
      clearInterval(relogio);
      if (!pediuJwt) dizer("O CRM não respondeu a esta tela.", true);
      return;
    }
    tentativas += 1;
    window.parent.postMessage({ type: "module:ready" }, host);
  }, 500);
  window.parent.postMessage({ type: "module:ready" }, host);
})();
"""


class _RecusaDoToken(Exception):
    def __init__(self, status: int, codigo: str) -> None:
        super().__init__(codigo)
        self.status = status
        self.codigo = codigo


def _json(status: int, dados: dict[str, Any]) -> tuple[int, str, bytes]:
    corpo = json.dumps(dados, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return status, "application/json; charset=utf-8", corpo


def _codigo_do_erro(dados: Any) -> str | None:
    if isinstance(dados, dict):
        erro = dados.get("error")
        if isinstance(erro, dict) and isinstance(erro.get("code"), str):
            return erro["code"]
    return None


def _epoch_de(expires_at: Any) -> float:
    """`expires_at` do CRM em epoch; na dúvida, vale pouco (o serviço busca de novo)."""
    try:
        texto = str(expires_at).replace("Z", "+00:00")
        momento = datetime.fromisoformat(texto)
        if momento.tzinfo is None:
            momento = momento.replace(tzinfo=timezone.utc)
        return momento.timestamp()
    except ValueError:
        return time.time() + MARGEM_DE_RENOVACAO_S


class ModuloDeEnsaio:
    """O estado do serviço: configuração entregue pela prova e tokens por organização."""

    def __init__(self) -> None:
        self._trava = threading.Lock()
        self._host: str | None = None
        self._instalacao: str | None = None
        self._segredo: str | None = None
        self._tokens: dict[str, tuple[str, float]] = {}

    # ── Configuração ─────────────────────────────────────────────────────────────────────────
    def configurar(self, host_origin: Any, installation_id: Any, secret: Any) -> str | None:
        """Devolve o motivo da recusa, ou `None` quando guardou."""
        if not isinstance(host_origin, str) or not ORIGEM_EXATA.fullmatch(host_origin):
            return "host_origin inválido"
        if not isinstance(installation_id, str) or not UUID.fullmatch(installation_id.lower()):
            return "installation_id inválido"
        if not isinstance(secret, str) or not SEGREDO.fullmatch(secret):
            return "secret inválido"
        with self._trava:
            self._host = host_origin
            self._instalacao = installation_id.lower()
            self._segredo = secret
            self._tokens = {}
        return None

    def _configuracao(self) -> tuple[str, str, str] | None:
        with self._trava:
            if self._host is None or self._instalacao is None or self._segredo is None:
                return None
            return self._host, self._instalacao, self._segredo

    # ── Rede ─────────────────────────────────────────────────────────────────────────────────
    @staticmethod
    def _http(
        metodo: str, url: str, cabecalhos: dict[str, str], corpo: bytes | None
    ) -> tuple[int, Any]:
        pedido = urllib.request.Request(url, data=corpo, method=metodo, headers=cabecalhos)
        try:
            with urllib.request.urlopen(pedido, timeout=PRAZO_DE_REDE_S) as resposta:
                bruto = resposta.read()
                status = resposta.status
        except urllib.error.HTTPError as erro:
            bruto = erro.read()
            status = erro.code
            erro.close()
        except (urllib.error.URLError, OSError, TimeoutError):
            return 0, None
        try:
            return status, json.loads(bruto.decode("utf-8")) if bruto else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return status, None

    def _buscar_token(self, organizacao: str) -> str:
        configuracao = self._configuracao()
        if configuracao is None:
            raise _RecusaDoToken(503, "ensaio_sem_configuracao")
        host, instalacao, segredo = configuracao
        carimbo = str(int(time.time() * 1000))
        nonce = secrets.token_urlsafe(24)  # 32 caracteres, só [A-Za-z0-9_-], sem ponto
        assinatura = hmac.new(
            segredo.encode("utf-8"),
            f"{organizacao}.{carimbo}.{nonce}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        status, dados = self._http(
            "POST",
            f"{host}/api/v1/extensions/token",
            {
                "x-module-installation": instalacao,
                "x-module-organization": organizacao,
                "x-module-timestamp": carimbo,
                "x-module-nonce": nonce,
                "x-module-signature": assinatura,
            },
            b"",
        )
        if status != 200 or not isinstance(dados, dict):
            raise _RecusaDoToken(status, _codigo_do_erro(dados) or "token_recusado")
        corpo = dados.get("data")
        token = corpo.get("token") if isinstance(corpo, dict) else None
        if not isinstance(token, str) or not token.startswith("dsk_"):
            raise _RecusaDoToken(502, "token_resposta_invalida")
        vence = _epoch_de(corpo.get("expires_at"))
        with self._trava:
            self._tokens[organizacao] = (token, vence)
        return token

    def _token(self, organizacao: str, forcar: bool = False) -> str:
        if not forcar:
            with self._trava:
                atual = self._tokens.get(organizacao)
            if atual is not None and atual[1] - time.time() > MARGEM_DE_RENOVACAO_S:
                return atual[0]
        return self._buscar_token(organizacao)

    def _chamar_crm(
        self, organizacao: str, metodo: str, caminho: str, jwt: str, corpo: dict[str, Any] | None
    ) -> tuple[int, Any]:
        configuracao = self._configuracao()
        if configuracao is None:
            return 503, {"error": {"code": "ensaio_sem_configuracao"}}
        host = configuracao[0]
        status: int = 0
        dados: Any = None
        for tentativa in (0, 1):
            token = self._token(organizacao, forcar=tentativa == 1)
            cabecalhos = {"authorization": f"Bearer {token}", "x-module-context": jwt}
            dados_do_corpo: bytes | None = None
            if corpo is not None:
                cabecalhos["content-type"] = "application/json"
                dados_do_corpo = json.dumps(corpo).encode("utf-8")
            status, dados = self._http(metodo, f"{host}{caminho}", cabecalhos, dados_do_corpo)
            # 401 com token vivo = o CRM o invalidou (revogado ou substituído): busca UMA vez e repete.
            if status == 401 and tentativa == 0:
                continue
            break
        return status, dados

    # ── Rotas ────────────────────────────────────────────────────────────────────────────────
    def _pagina(self, consulta: dict[str, list[str]]) -> tuple[int, str, bytes]:
        organizacao = (consulta.get("organization") or [""])[0].lower()
        instalacao = (consulta.get("installation") or [""])[0].lower()
        configuracao = self._configuracao()
        if not UUID.fullmatch(organizacao) or not UUID.fullmatch(instalacao):
            return 400, "text/plain; charset=utf-8", "Endereço do módulo inválido.".encode("utf-8")
        host = configuracao[0] if configuracao is not None else ""
        estado = (
            "Conectando ao CRM…"
            if configuracao is not None
            else "Este serviço ainda não recebeu a configuração do ensaio."
        )
        pagina = (
            PAGINA.replace("__HOST__", html.escape(host, quote=True))
            .replace("__ORG__", html.escape(organizacao, quote=True))
            .replace("__INST__", html.escape(instalacao, quote=True))
            .replace("__ESTADO__", html.escape(estado))
        )
        return 200, "text/html; charset=utf-8", pagina.encode("utf-8")

    def _acao(
        self, cabecalhos: Any, metodo: str, corpo_da_chamada: dict[str, Any] | None, resumir: bool
    ) -> tuple[int, str, bytes]:
        organizacao = (cabecalhos.get("x-modulo-organization") or "").lower()
        instalacao = (cabecalhos.get("x-modulo-installation") or "").lower()
        jwt = cabecalhos.get("x-modulo-contexto") or ""
        configuracao = self._configuracao()
        if configuracao is None:
            return _json(200, {"status": 503, "codigo": "ensaio_sem_configuracao"})
        if (
            not UUID.fullmatch(organizacao)
            or instalacao != configuracao[1]
            or not jwt
            or len(jwt) > 4096
        ):
            return _json(400, {"status": 400, "codigo": "pedido_do_ensaio_invalido"})
        try:
            status, dados = self._chamar_crm(
                organizacao, metodo, "/api/v1/contacts", jwt, corpo_da_chamada
            )
        except _RecusaDoToken as recusa:
            return _json(200, {"status": recusa.status, "codigo": recusa.codigo, "etapa": "token"})
        saida: dict[str, Any] = {"status": status, "codigo": _codigo_do_erro(dados)}
        if status == 0:
            saida["codigo"] = "crm_inalcancavel"
        if (
            resumir
            and status == 200
            and isinstance(dados, dict)
            and isinstance(dados.get("data"), list)
        ):
            saida["total"] = len(dados["data"])
        return _json(200, saida)

    def atender(
        self, metodo: str, alvo: str, cabecalhos: Any, corpo: bytes
    ) -> tuple[int, str, bytes] | None:
        """Atende uma rota do módulo de ensaio; `None` quando o caminho não é dele."""
        partes = urlsplit(alvo)
        caminho = partes.path
        if metodo == "GET" and caminho == "/embed":
            return self._pagina(parse_qs(partes.query))
        if metodo == "GET" and caminho == "/embed.js":
            return 200, "text/javascript; charset=utf-8", SCRIPT.encode("utf-8")
        if metodo == "GET" and caminho == "/ensaio/estado":
            return _json(200, {"configurado": self._configuracao() is not None})
        if metodo != "POST":
            return None
        if caminho == "/ensaio/configurar":
            try:
                dados = json.loads(corpo.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return _json(400, {"erro": "corpo inválido"})
            if not isinstance(dados, dict):
                return _json(400, {"erro": "corpo inválido"})
            motivo = self.configurar(
                dados.get("host_origin"), dados.get("installation_id"), dados.get("secret")
            )
            if motivo is not None:
                return _json(400, {"erro": motivo})
            return _json(200, {"configurado": True})
        if caminho == "/ensaio/contatos/listar":
            return self._acao(cabecalhos, "GET", None, resumir=True)
        if caminho == "/ensaio/contatos/criar":
            # Telefone único por chamada (8 dígitos aleatórios): o CRM não pode achar que o contato já existe.
            corpo_do_contato = {
                "name": f"Contato do módulo de ensaio {secrets.token_hex(4)}",
                "phone_number": "+55119" + f"{secrets.randbelow(10**8):08d}",
            }
            return self._acao(cabecalhos, "POST", corpo_do_contato, resumir=False)
        return None
