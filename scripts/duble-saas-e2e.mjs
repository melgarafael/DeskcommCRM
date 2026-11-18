#!/usr/bin/env node
/**
 * Dublê HTTP dos SaaS que o e2e não pode alcançar de verdade (Resend e
 * Nuvemshop). Issue #179.
 *
 * ── POR QUE UM SERVIDOR DE VERDADE, E NÃO UM MOCK EM PROCESSO ─────────────
 *
 * O produto fala com esses dois por HTTP, de dentro do processo do servidor
 * Next (`next start`), não de dentro do teste. Um `vi.mock()`/intercept de
 * `fetch` viveria no processo do PLAYWRIGHT e o servidor sob teste continuaria
 * batendo na internet: o teste passaria a medir o dublê, não o produto. A
 * doutrina de QA visual do CLAUDE.md pede a mesma coisa em outras palavras —
 * efeito colateral externo se prova com receptor real, não com mock em
 * processo.
 *
 * Por isso este arquivo é um servidor HTTP de verdade: sobe, escuta numa
 * porta, responde o que o SaaS responderia, e GUARDA o que recebeu para que o
 * teste possa afirmar depois ("o e-mail saiu?", "o webhook foi registrado?").
 *
 * ── O QUE ELE DUBLA ───────────────────────────────────────────────────────
 *
 * Resend (`https://api.resend.com`):
 *   POST /emails                    → 200 { id }
 *   GET  /emails/:id                → 200 { id, to, subject, last_event }
 *   GET  /domains e /domains/:id    → domínios/registros só das contas sintéticas
 *
 * Nuvemshop / Tiendanube (`https://www.tiendanube.com` e
 * `https://api.tiendanube.com/v1`), incluindo o handshake OAuth:
 *   GET  /apps/:app_id/authorize    → 302 no `redirect_uri` com `code` e `state`
 *   POST /apps/authorize/token      → { access_token, token_type, scope, user_id }
 *   GET  /:store_id/store           → dados da loja
 *   GET  /:store_id/webhooks        → lista
 *   POST /:store_id/webhooks        → cria (id sintético)
 *   DELETE /:store_id/webhooks/:id  → 204
 *
 * Plano de controle (não existe no SaaS, existe para o teste):
 *   GET    /__duble/saude           → 200 { ok, resend, nuvemshop, porta }
 *   GET    /__duble/recebidos       → 200 { total, requisicoes: [...] }
 *   DELETE /__duble/recebidos       → 204 (zera a caixa)
 *
 * ── COMO O APP CHEGA AQUI ────────────────────────────────────────────────
 *
 * Pela env, nunca por edição de código:
 *   RESEND_BASE_URL         (SDK: plataforma e organização, durante todo ojob)
 *   RESEND_API_BASE_URL     (default do produto: https://api.resend.com)
 *   NUVEMSHOP_AUTH_BASE     (default: https://www.tiendanube.com)
 *   NUVEMSHOP_API_BASE      (default: https://api.tiendanube.com/v1)
 * O `.env.e2e` é quem carrega esses valores, e ele só é aceito em localhost —
 * a guarda está em `playwright.config.ts` e não foi tocada.
 *
 * Quando a env não é setada, os defaults do produto valem e este servidor não
 * é alcançado: é isso que mantém a produção fora do caminho.
 *
 * Zero dependências (só `node:http`/`node:url`): o passo do CI não pode
 * depender de `pnpm install` ter dado certo para conseguir subir o dublê.
 *
 * Uso:  node scripts/duble-saas-e2e.mjs [--porta 3997] [--host 127.0.0.1]
 */

import http from "node:http";
import { URL } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const CONTAS = JSON.parse(
  readFileSync(new URL("../tests/fixtures/resend-da-organizacao.json", import.meta.url), "utf8"),
);

// ── Configuração ───────────────────────────────────────────────────────────

/**
 * Porta 3997: vizinha de 3998 (Redis HTTP) e 3999 (WAHA), que o
 * `scripts/gerar-env-e2e.sh` já fixa. As três cabem na mesma régua.
 */
const PORTA = Number(process.env.DUBLE_SAAS_PORTA ?? 3997);
const HOST = process.env.DUBLE_SAAS_HOST ?? "127.0.0.1";

const APP_ID_NUVEMSHOP = process.env.NUVEMSHOP_APP_ID ?? "e2e-app-id";
const CLIENT_SECRET_NUVEMSHOP =
  process.env.NUVEMSHOP_CLIENT_SECRET ?? "e2e-placeholder-nao-e-segredo";

/**
 * Teto da caixa de entrada. Um teste que dispara e-mail em laço não pode
 * derrubar o runner por memória; 500 é folgado para as specs do repo, que
 * mandam unidades por cenário.
 */
const TETO_RECEBIDOS = 500;

// ── Estado (em memória, por processo) ──────────────────────────────────────

/** @type {Array<{t: string, metodo: string, caminho: string, corpo: unknown, authorization_sha256: string | null}>} */
const recebidos = [];
/** @type {Map<string, {id: string, to: unknown, subject: string, html: string, last_event: string}>} */
const emails = new Map();
/** @type {Map<number, {id: number, event: string, url: string}>} */
const webhooks = new Map();
let seq = 0;

function registrar(metodo, caminho, corpo, authorization) {
  recebidos.push({
    t: new Date().toISOString(),
    metodo,
    caminho,
    corpo,
    // O receiver serve todas as SDKs durante o job; identifica a conta sem revelar a chave.
    authorization_sha256: authorization
      ? createHash("sha256").update(authorization).digest("hex")
      : null,
  });
  if (recebidos.length > TETO_RECEBIDOS) recebidos.shift();
}

function proximoId(prefixo) {
  seq += 1;
  return `${prefixo}_${Date.now().toString(36)}${seq.toString(36)}`;
}

// ── Utilidades HTTP ────────────────────────────────────────────────────────

async function lerCorpo(req) {
  const pedacos = [];
  for await (const p of req) pedacos.push(p);
  const cru = Buffer.concat(pedacos).toString("utf8");
  if (!cru) return undefined;
  try {
    return JSON.parse(cru);
  } catch {
    // Corpo não-JSON é guardado como está: é sinal de que o produto mudou o
    // formato, e o teste merece ver isso em vez de um `undefined` silencioso.
    return cru;
  }
}

function responder(res, status, corpo, extras = {}) {
  const cabecalhos = { "content-type": "application/json", ...extras };
  const texto = corpo === undefined ? "" : JSON.stringify(corpo);
  res.writeHead(status, cabecalhos);
  res.end(texto);
}

/** O `Bearer` que o Resend usa. Sem chave, o SaaS real devolve 401. */
function autorizadoResend(req) {
  const cabecalho = req.headers.authorization ?? "";
  return /^Bearer\s+\S+/i.test(cabecalho);
}

function contaResendSintetica(req) {
  const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return [CONTAS.a, CONTAS.b].find((conta) => conta.key === key);
}

/** Domínios são só de chaves sintéticas conhecidas; envio legado de plataforma continua aceito. */
function resendDominios(req, partes, res) {
  if (req.method !== "GET") return responder(res, 405, { error: "method_not_allowed" });
  const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!autorizadoResend(req))
    return responder(res, 401, {
      statusCode: 401,
      name: "missing_api_key",
      message: "Missing API key",
    });
  if (key === CONTAS.errors.permission)
    return responder(res, 401, {
      statusCode: 401,
      name: "restricted_api_key",
      message: "Synthetic key cannot list domains",
    });
  if (key === CONTAS.errors.unavailable)
    return responder(res, 503, {
      statusCode: 503,
      name: "internal_server_error",
      message: "Synthetic provider unavailable",
    });
  const conta =
    contaResendSintetica(req) ??
    ([CONTAS.errors.pending, CONTAS.errors.disabled].includes(key) ? CONTAS.a : null);
  if (!conta)
    return responder(res, 401, {
      statusCode: 401,
      name: "validation_error",
      message: "Synthetic key not recognized",
    });
  const dominio = {
    id: conta.id,
    name: conta.domain,
    region: "us-east-1",
    created_at: "2026-10-27T00:00:00.000Z",
    status: key === CONTAS.errors.pending ? "pending" : "verified",
    capabilities: {
      sending: key === CONTAS.errors.disabled ? "disabled" : "enabled",
      receiving: "disabled",
    },
  };
  if (!partes[1]) return responder(res, 200, { object: "list", has_more: false, data: [dominio] });
  if (partes[1] !== conta.id)
    return responder(res, 404, { statusCode: 404, name: "not_found", message: "Domain not found" });
  return responder(res, 200, {
    ...dominio,
    object: "domain",
    records: [
      {
        record: "SPF",
        type: "TXT",
        name: `outbound.${conta.domain}`,
        value: "v=spf1 include:amazonses.com ~all",
        status: "verified",
        ttl: "Auto",
      },
      {
        record: "SPF",
        type: "MX",
        name: `outbound.${conta.domain}`,
        value: "feedback-smtp.us-east-1.amazonses.com",
        priority: 10,
        status: "verified",
        ttl: "Auto",
      },
      {
        record: "DKIM",
        type: "CNAME",
        name: `seletor._domainkey.${conta.domain}`,
        value: `dkim.${conta.domain}`,
        status: "verified",
        ttl: "Auto",
      },
    ],
  });
}

// ── Rotas: Resend ──────────────────────────────────────────────────────────

function resendCriarEmail(req, corpo, res) {
  if (!autorizadoResend(req)) {
    // 401 de verdade: um dublê permissivo esconderia do teste que o produto
    // parou de mandar a chave.
    return responder(res, 401, {
      statusCode: 401,
      name: "missing_api_key",
      message: "Missing API key",
    });
  }
  const conta = contaResendSintetica(req);
  if (conta) {
    const from =
      typeof corpo?.from === "string"
        ? (corpo.from.match(/<([^<>]+)>$/)?.[1] ?? corpo.from).trim()
        : "";
    const to = Array.isArray(corpo?.to) ? corpo.to : [corpo?.to];
    if (
      from !== conta.from ||
      to.length === 0 ||
      !to.every((v) => typeof v === "string" && v.endsWith(".invalid"))
    ) {
      return responder(res, 403, {
        statusCode: 403,
        name: "validation_error",
        message: "Synthetic account and sender do not match",
      });
    }
  }
  const id = proximoId("email");
  const registro = {
    id,
    to: corpo?.to ?? null,
    subject: corpo?.subject ?? "",
    html: corpo?.html ?? "",
    last_event: "delivered",
  };
  emails.set(id, registro);
  return responder(res, 200, { id });
}

// ── Rotas: Nuvemshop / Tiendanube ──────────────────────────────────────────

function nuvemshopAuthorize(url, res) {
  const estado = url.searchParams.get("state") ?? "sem-state";
  const redirecionar = url.searchParams.get("redirect_uri");
  const codigo = `codigo-e2e-${estado.slice(0, 12)}`;

  if (!redirecionar) {
    // Sem `redirect_uri` não há para onde voltar: 400 explícito, porque um 302
    // para lugar nenhum viraria "timeout misterioso" no teste.
    return responder(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri ausente",
    });
  }

  let destino;
  try {
    destino = new URL(redirecionar);
  } catch {
    return responder(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri inválido",
    });
  }
  destino.searchParams.set("code", codigo);
  destino.searchParams.set("state", estado);

  // 302 é o que o SaaS faz: o browser do lojista é jogado de volta no app com
  // o `code` na query. É este passo que o teste de instalação exercita.
  res.writeHead(302, { location: destino.toString() });
  res.end();
}

function nuvemshopToken(corpo, res) {
  if (!corpo || typeof corpo !== "object") {
    return responder(res, 400, { error: "invalid_request", error_description: "corpo ausente" });
  }
  if (corpo.client_secret !== CLIENT_SECRET_NUVEMSHOP) {
    return responder(res, 401, {
      error: "invalid_client",
      error_description: "client_secret inválido",
    });
  }
  return responder(res, 200, {
    access_token: `token-e2e-${cx()}`,
    token_type: "bearer",
    scope: "read_products,write_products,read_orders",
    user_id: 42,
  });
}

/** O código do token carrega o app_id e o store_id do corpo: dois testes no
 *  mesmo processo não podem compartilhar credencial por acidente. */
function cx() {
  return `${APP_ID_NUVEMSHOP}-${Date.now().toString(36)}`;
}

function nuvemshopWebhooks(metodo, partes, corpo, res) {
  if (metodo === "GET") {
    return responder(res, 200, [...webhooks.values()]);
  }
  if (metodo === "POST") {
    const id = 1000 + webhooks.size + 1;
    const registro = {
      id,
      event: String(corpo?.event ?? "order/paid"),
      url: String(corpo?.url ?? ""),
    };
    webhooks.set(id, registro);
    return responder(res, 201, registro);
  }
  if (metodo === "DELETE") {
    const id = Number(partes[partes.length - 1]);
    webhooks.delete(id);
    return responder(res, 204, undefined);
  }
  return responder(res, 405, { error: "method_not_allowed" });
}

function nuvemshopLoja(storeId, res) {
  return responder(res, 200, {
    id: Number(storeId),
    name: "Loja E2E",
    email: "loja-e2e@deskcomm.test",
    country: "BR",
    currency: "BRL",
    language: "pt",
    domain: "loja-e2e.example",
  });
}

// ── Roteador ───────────────────────────────────────────────────────────────

async function rotear(req, res) {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORTA}`);
  const metodo = req.method ?? "GET";
  const partes = url.pathname.split("/").filter(Boolean);
  const corpo = ["POST", "PUT", "PATCH"].includes(metodo) ? await lerCorpo(req) : undefined;

  if (!partes[0]?.startsWith("__duble")) {
    registrar(metodo, url.pathname + url.search, corpo, req.headers.authorization);
  }

  // ── Plano de controle ──
  if (partes[0] === "__duble") {
    if (partes[1] === "saude") {
      return responder(res, 200, {
        ok: true,
        porta: typeof servidor.address() === "object" ? servidor.address()?.port : PORTA,
        pid: process.pid,
        recebidos: recebidos.length,
        emails: emails.size,
        webhooks: webhooks.size,
        resend: "POST /emails · GET /emails/:id",
        nuvemshop:
          "GET /apps/:id/authorize · POST /apps/authorize/token · /:store_id/{store,webhooks}",
      });
    }
    if (partes[1] === "recebidos") {
      if (metodo === "DELETE") {
        recebidos.length = 0;
        return responder(res, 204, undefined);
      }
      return responder(res, 200, { total: recebidos.length, requisicoes: recebidos });
    }
    return responder(res, 404, { error: "rota_de_controle_desconhecida" });
  }

  // ── Resend ──
  if (partes[0] === "domains") return resendDominios(req, partes, res);
  if (partes[0] === "emails") {
    // `req` vai junto: `autorizadoResend` lê o `Authorization` do cabeçalho, e
    // sem ele o 401 de verdade (chave ausente) virava 500 — o dublê escondia do
    // teste justamente o que ele existe para mostrar.
    if (metodo === "POST") return resendCriarEmail(req, corpo, res);
    if (metodo === "GET" && partes[1]) {
      const email = emails.get(partes[1]);
      if (!email)
        return responder(res, 404, {
          statusCode: 404,
          name: "not_found",
          message: "Email not found",
        });
      return responder(res, 200, email);
    }
    return responder(res, 405, { error: "method_not_allowed" });
  }

  // ── Nuvemshop: handshake OAuth ──
  if (partes[0] === "apps") {
    // /apps/:app_id/authorize — pode vir com prefixo de idioma (`/pt/`), como o
    // SaaS real serve; por isso a busca é por sufixo e não por índice fixo.
    if (metodo === "GET" && partes[partes.length - 1] === "authorize") {
      return nuvemshopAuthorize(url, res);
    }
    if (metodo === "POST" && partes[1] === "authorize" && partes[2] === "token") {
      return nuvemshopToken(corpo, res);
    }
    return responder(res, 404, { error: "rota_nuvemshop_desconhecida", caminho: url.pathname });
  }

  // ── Nuvemshop: API autenticada — /:store_id/{store,webhooks} ──
  if (partes.length >= 2 && /^\d+$/.test(partes[0])) {
    const storeId = partes[0];
    if (partes[1] === "store" && metodo === "GET") return nuvemshopLoja(storeId, res);
    if (partes[1] === "webhooks") return nuvemshopWebhooks(metodo, partes, corpo, res);
    return responder(res, 404, { error: "rota_nuvemshop_desconhecida", caminho: url.pathname });
  }

  return responder(res, 404, { error: "rota_desconhecida", caminho: url.pathname });
}

const servidor = http.createServer((req, res) => {
  // `res.req` é usado por `autorizadoResend`; em node >= 18 já existe, mas
  // fixar aqui deixa a dependência explícita em vez de implícita.
  res.req = req;
  rotear(req, res).catch((erro) => {
    responder(res, 500, { error: "erro_no_duble", detalhe: String(erro?.message ?? erro) });
  });
});

servidor.listen(PORTA, HOST, () => {
  const endereco = servidor.address();
  const base = `http://${HOST}:${typeof endereco === "object" ? endereco.port : PORTA}`;
  console.info(`[duble-saas] ouvindo em ${base}`);
  console.info(`[duble-saas] resend     → RESEND_API_BASE_URL=${base}`);
  console.info(`[duble-saas] nuvemshop  → NUVEMSHOP_AUTH_BASE=${base}`);
  console.info(`[duble-saas] nuvemshop  → NUVEMSHOP_API_BASE=${base}`);
  console.info(`[duble-saas] saúde      → ${base}/__duble/saude`);
});

for (const sinal of ["SIGINT", "SIGTERM"]) {
  process.on(sinal, () => {
    servidor.close(() => process.exit(0));
  });
}
