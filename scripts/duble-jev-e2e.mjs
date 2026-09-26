#!/usr/bin/env node
/**
 * Dublê HTTP do Jev (System One, da TypeSafe AI) para o e2e.
 *
 * Servidor de verdade, em processo separado, pelo mesmo motivo do
 * `scripts/duble-saas-e2e.mjs`: quem fala com o Jev é o servidor Next (o
 * worker de clima dentro do dreno do event_log), não o processo do Playwright.
 * Um intercept de `fetch` no teste deixaria o produto batendo na internet.
 *
 * Responde o formato REAL, medido contra a API em 2026-09-23 (o plano do Jev
 * guarda as amostras):
 *   GET  /v1/models      → 200 { models: [...] } com o Bearer certo; 401 com
 *                          outro; 403 sem nenhum. É o que valida a chave.
 *   POST /v1/systemone   → 200 { model, answers, usage }. Para `score`, a
 *                          posição na escala (0..n-1) vem de DUBLE_JEV_SCORE.
 *                          DUBLE_JEV_RESPOSTAS (JSON, id da pergunta → resposta
 *                          no formato do fornecedor) troca a resposta das
 *                          perguntas que nomeia — é como a spec força uma
 *                          discordância; as outras seguem o padrão acima.
 *
 * E GRAVA cada chamada num arquivo JSON (DUBLE_JEV_ARQUIVO), que a spec LÊ
 * para provar que o Jev foi chamado e com o quê. Grava o corpo (é por ele que
 * se prova que o telefone saiu apagado) e se o Bearer bateu — nunca o Bearer.
 *
 *   GET /__duble/saude   → { ok, porta, arquivo } — a spec confere que o
 *                          dublê que respondeu é o dela, e não um que sobrou.
 *
 * Zero dependências. Uso:
 *   DUBLE_JEV_ARQUIVO=/tmp/chamadas.json node scripts/duble-jev-e2e.mjs
 */

import { writeFileSync } from "node:fs";
import http from "node:http";

/** 3996: vizinha de 3997 (dublê dos SaaS), 3998 (Redis HTTP) e 3999 (WAHA). */
const PORTA = Number(process.env.DUBLE_JEV_PORTA ?? 3996);
const HOST = process.env.DUBLE_JEV_HOST ?? "127.0.0.1";
const CHAVE = process.env.DUBLE_JEV_CHAVE ?? "apikey_e2e_duble_do_jev_0123456789abcdef";
const ARQUIVO = process.env.DUBLE_JEV_ARQUIVO ?? "";
/** Posição na escala de 5 níveis: 3 = "satisfeito" — longe do limiar de passagem. */
const SCORE = Number(process.env.DUBLE_JEV_SCORE ?? 3);
const MODELO = "jev-1.13.0";

if (!ARQUIVO) {
  console.error("[duble-jev] DUBLE_JEV_ARQUIVO é obrigatório: é por ele que a spec prova a chamada");
  process.exit(2);
}

/**
 * Respostas forçadas por id de pergunta. Ilegível derruba o dublê na subida: um
 * mapa ignorado em silêncio faria a spec provar o padrão achando que provou a
 * discordância.
 */
function lerRespostasForcadas() {
  const cru = process.env.DUBLE_JEV_RESPOSTAS;
  if (!cru) return {};
  let lido;
  try {
    lido = JSON.parse(cru);
  } catch {
    lido = null;
  }
  if (lido === null || typeof lido !== "object" || Array.isArray(lido)) {
    console.error("[duble-jev] DUBLE_JEV_RESPOSTAS precisa ser um objeto JSON: id da pergunta → resposta");
    process.exit(2);
  }
  return lido;
}
const RESPOSTAS_FORCADAS = lerRespostasForcadas();

/** @type {Array<{t: string, metodo: string, caminho: string, autorizado: boolean, corpo: unknown}>} */
const chamadas = [];

function gravar() {
  writeFileSync(ARQUIVO, JSON.stringify(chamadas, null, 2));
}
gravar();

function responder(res, status, corpo) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(corpo));
}

async function lerCorpo(req) {
  const pedacos = [];
  for await (const p of req) pedacos.push(p);
  const cru = Buffer.concat(pedacos).toString("utf8");
  if (!cru) return undefined;
  try {
    return JSON.parse(cru);
  } catch {
    // Guardado como veio: formato novo do produto é o que o teste precisa ver.
    return cru;
  }
}

/** A resposta de uma pergunta, no formato do fornecedor. */
function responderPergunta(pergunta) {
  if (pergunta?.type === "score") {
    const niveis = Array.isArray(pergunta.criteria) ? pergunta.criteria : [];
    const teto = Math.max(niveis.length - 1, 0);
    const score = Math.min(Math.max(SCORE, 0), teto);
    const legend = {};
    const probabilities = {};
    niveis.forEach((texto, i) => {
      legend[String(i)] = texto;
      probabilities[String(i)] = i === Math.round(score) ? 0.9 : 0.1 / Math.max(teto, 1);
    });
    return { type: "score", score, confidence: 0.9, legend, probabilities };
  }
  if (pergunta?.type === "choice") {
    const opcoes = Object.keys(pergunta.criteria ?? {});
    const probabilities = Object.fromEntries(opcoes.map((o, i) => [o, i === 0 ? 0.9 : 0.1]));
    return { type: "choice", choice: opcoes[0] ?? "", confidence: 0.9, probabilities };
  }
  return { type: "noul", noul: 0.5 };
}

const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORTA}`);
    const metodo = req.method ?? "GET";

    if (url.pathname === "/__duble/saude") {
      return responder(res, 200, { ok: true, porta: PORTA, arquivo: ARQUIVO, chamadas: chamadas.length });
    }

    const corpo = metodo === "POST" ? await lerCorpo(req) : undefined;
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? null;
    const autorizado = bearer === CHAVE;
    chamadas.push({ t: new Date().toISOString(), metodo, caminho: url.pathname, autorizado, corpo });
    gravar();

    // A API real devolve 403 sem chave e 401 com chave errada — os dois viram
    // "chave recusada" no produto, e o dublê não pode ser mais permissivo que ela.
    if (bearer === null) return responder(res, 403, { detail: "Not authenticated" });
    if (!autorizado) {
      return responder(res, 401, {
        detail: { error_type: "authentication_error", message: "Invalid API key" },
      });
    }

    if (metodo === "GET" && url.pathname === "/v1/models") {
      return responder(res, 200, {
        models: [{ name: MODELO, description: "dublê do e2e", release_date: "2026-09-01" }],
      });
    }

    if (metodo === "POST" && url.pathname === "/v1/systemone") {
      const perguntas = corpo && typeof corpo === "object" ? (corpo.questions ?? {}) : {};
      const answers = Object.fromEntries(
        Object.entries(perguntas).map(([id, p]) => [
          id,
          Object.hasOwn(RESPOSTAS_FORCADAS, id) ? RESPOSTAS_FORCADAS[id] : responderPergunta(p),
        ]),
      );
      const estado = typeof corpo?.state === "string" ? corpo.state : JSON.stringify(corpo?.state ?? "");
      return responder(res, 200, {
        model: MODELO,
        answers,
        usage: { input_tokens: Math.max(1, Math.ceil(estado.length / 4)), output_tokens: 1 },
      });
    }

    return responder(res, 404, { error_type: "not_found", message: `rota desconhecida: ${url.pathname}` });
  } catch (erro) {
    // O detalhe fica no log deste processo (a spec imprime a saída do dublê);
    // a resposta HTTP não carrega mensagem nem pilha de erro.
    console.error("[duble-jev] falhou ao responder:", erro);
    return responder(res, 500, { error_type: "erro_no_duble", message: "o dublê falhou — veja o log dele" });
  }
});

servidor.listen(PORTA, HOST, () => {
  console.info(`[duble-jev] ouvindo em http://${HOST}:${PORTA} — chamadas em ${ARQUIVO}`);
});

// Sai na hora, sem `servidor.close()`: ele espera as conexões keep-alive do
// servidor Next fecharem, e o dublê seguiria preso à porta depois da spec. Não
// há o que perder — cada chamada já foi gravada no arquivo, de forma síncrona.
for (const sinal of ["SIGINT", "SIGTERM"]) {
  process.on(sinal, () => process.exit(0));
}
