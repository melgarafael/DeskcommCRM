/**
 * TODA CHAMADA AO WAHA TEM TETO DE RELÓGIO (issue #470).
 *
 * ─── O defeito, medido em c5b45b24 ──────────────────────────────────────────
 *
 *     $ grep -cE "AbortController|AbortSignal|setTimeout" lib/waha/client.ts
 *     0
 *     $ grep -c "fetch(" lib/waha/client.ts
 *     14
 *
 * CONTROLE POSITIVO (a mesma sonda, em arquivos que TÊM teto):
 *     lib/messaging/media/waha-source.ts:37   signal: AbortSignal.timeout(...)
 *     lib/automation/actions/call-webhook.ts:121  signal: AbortSignal.timeout(...)
 *
 * O WAHA é dependência externa e cai. Sem teto, uma Server Action ou rota fica
 * presa até o limite do runtime.
 *
 * ─── Por que o dublê é um socket que ACEITA E NÃO RESPONDE ──────────────────
 *
 * Recusa imediata (porta fechada) e aceita-e-cala dão desfechos OPOSTOS: a
 * primeira devolve `ECONNREFUSED` na hora e nenhum teto é exercitado — um teste
 * contra porta fechada fica verde com o defeito inteiro no lugar. É o segundo
 * caso que pendura o processo, e é o único que mede o conserto.
 *
 * ─── Dois tetos, e por que um só não serve ──────────────────────────────────
 *
 * `lib/waha/media-send.ts:28,31` manda `convert: true` em `sendVideo` e
 * `sendVoice`: o WAHA roda ffmpeg e BAIXA a URL do Storage antes de responder.
 * Um teto único calibrado para `sendText` cortaria envio de áudio legítimo — o
 * conserto viraria um defeito novo, e mais difícil de ver que o original.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TETO_PADRAO_MS, TETO_DE_MIDIA_MS, WahaClient } from "./client";

/** Sockets aceitos e deixados pendurados — o modo de falha caro. */
let mudo: Server;
let urlMudo = "";
/** Responde, mas devagar: separa o teto padrão do teto da mídia. */
let lento: Server;
let urlLento = "";
const ATRASO_DO_LENTO_MS = 400;

beforeAll(async () => {
  mudo = createServer(() => {
    /* aceita a conexão e NUNCA responde — de propósito */
  });
  lento = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ok" }));
    }, ATRASO_DO_LENTO_MS);
  });
  await Promise.all([
    new Promise<void>((r) => mudo.listen(0, "127.0.0.1", r)),
    new Promise<void>((r) => lento.listen(0, "127.0.0.1", r)),
  ]);
  urlMudo = `http://127.0.0.1:${(mudo.address() as AddressInfo).port}`;
  urlLento = `http://127.0.0.1:${(lento.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((r) => mudo.close(() => r())),
    new Promise<void>((r) => lento.close(() => r())),
  ]);
});

/** Quanto tempo a promessa levou para rejeitar, e com qual mensagem. */
async function medir(fn: () => Promise<unknown>): Promise<{ ms: number; erro: string }> {
  const t0 = performance.now();
  try {
    await fn();
    return { ms: performance.now() - t0, erro: "" };
  } catch (e) {
    return { ms: performance.now() - t0, erro: e instanceof Error ? e.message : String(e) };
  }
}

describe("as constantes de teto são as que a spec prescreve", () => {
  it("o teto padrão é 15s — o número de docs/specs/03-spec-whatsapp-waha.md:636", () => {
    // Não inventar 10s: a spec deste arquivo já prescreve `timeoutMs ?? 15_000`,
    // e duas réguas para a mesma grandeza divergem na primeira mudança.
    expect(TETO_PADRAO_MS).toBe(15_000);
  });

  it("o teto da mídia é MAIOR — `convert: true` faz o WAHA rodar ffmpeg antes de responder", () => {
    // Sem esta diferença, o conserto do timeout cortaria envio de áudio
    // legítimo: um defeito novo, e mais difícil de ver que o original.
    expect(TETO_DE_MIDIA_MS).toBeGreaterThan(TETO_PADRAO_MS);
  });
});

describe("socket que aceita e não responde — a chamada desiste, não pendura", () => {
  const cliente = () => new WahaClient(urlMudo, "chave-de-teste");

  it("⭐ sendMessage desiste dentro do teto", async () => {
    // Teto de 250ms injetado: medir os 15s reais faria a suíte esperar 15s por
    // caso. O que se prova aqui é que EXISTE teto e ele é respeitado.
    const c = new WahaClient(urlMudo, "chave-de-teste", { tetoMs: 250 });
    const { ms, erro } = await medir(() => c.sendMessage("sessao", "5511999@c.us", "oi"));
    expect(erro, "a chamada não falhou — ficou pendurada até o timeout do vitest").not.toBe("");
    expect(ms, `demorou ${Math.round(ms)}ms com teto de 250ms`).toBeLessThan(3_000);
  });

  it("startSession desiste dentro do teto", async () => {
    const c = new WahaClient(urlMudo, "chave-de-teste", { tetoMs: 250 });
    const { ms, erro } = await medir(() => c.startSession("sessao"));
    expect(erro).not.toBe("");
    expect(ms).toBeLessThan(3_000);
  });

  it("o erro DIZ que foi o relógio, e não se disfarça de recusa do WAHA", async () => {
    // Sem isto, um estouro de teto vira "waha_start_undefined" no log e o
    // diagnóstico começa procurando defeito de contrato.
    const c = new WahaClient(urlMudo, "chave-de-teste", { tetoMs: 250 });
    const { erro } = await medir(() => c.sendMessage("sessao", "5511999@c.us", "oi"));
    expect(erro.toLowerCase()).toMatch(/timeout|tempo|abort/);
  });

  it("controle positivo: contra um servidor que RESPONDE, a mesma chamada passa", async () => {
    // Sem este caso, um "conserto" que quebrasse toda chamada ao WAHA deixaria
    // os casos acima verdes — eles só exigem que a promessa rejeite.
    const c = new WahaClient(urlLento, "chave-de-teste", { tetoMs: 5_000 });
    const { erro } = await medir(() => c.sendMessage("sessao", "5511999@c.us", "oi"));
    expect(erro, "o cliente passou a falhar mesmo contra um WAHA saudável").toBe("");
  });

  it("o cliente sem opções usa o teto padrão, não fica sem teto", () => {
    // A injeção existe para o teste. O caminho de produção é o construtor de
    // dois argumentos, e é ele que precisa estar coberto.
    const c = cliente() as unknown as { tetoMs: number };
    expect(c.tetoMs).toBe(TETO_PADRAO_MS);
  });
});

describe("a superfície inteira — nenhum fetch fica de fora", () => {
  it("⭐ nenhum `fetch(` cru sobrou em lib/waha/client.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fonte = readFileSync(join(process.cwd(), "lib/waha/client.ts"), "utf8");

    // Controle positivo: a sonda tem de achar o wrapper, senão o vazio abaixo
    // seria "procurei errado" lido como "está tudo coberto".
    expect(fonte, "o wrapper com teto não existe neste arquivo").toContain("fetchComTeto");

    // O ÚNICO `fetch(` cru permitido é o de dentro do wrapper — e ele só é
    // permitido porque carrega o sinal. Aceitar qualquer linha com "fetch" abriria
    // a porta para o próximo call site sem teto passar despercebido.
    const crus = fonte
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(
        ([, l]) =>
          /(?<![\w.])fetch\(/.test(l) &&
          !l.includes("fetchComTeto") &&
          !l.includes("AbortSignal.timeout"),
      );
    expect(
      crus.map(([n, l]) => `${n}: ${l.trim()}`),
      "estas chamadas ao WAHA não têm teto de relógio — com o WAHA fora do ar elas penduram a requisição até o limite do runtime",
    ).toEqual([]);
  });
});

/**
 * O CORPO DA RESPOSTA DO WAHA NÃO SAI DAQUI — NEM NA EXCEÇÃO, NEM NA API.
 *
 * ─── O defeito, medido em 2005aea6 ──────────────────────────────────────────
 *
 *     $ grep -c 'body.slice(0, 200)' lib/waha/client.ts
 *     8
 *
 * Os oito montavam `waha_<acao>_<status>: <corpo do WAHA>`, e essa string não
 * morria no log: `wahaFriendlyError` a devolve inteira quando
 * `classificarFalhaDeAlcance` não reconhece a falha — o caso de todo HTTP com
 * status —, e as três rotas de `channel-sessions` a passam para `fail(...)`,
 * que é o corpo da resposta da nossa API. Corpo de terceiro atravessando a
 * fronteira do produto.
 *
 * ─── Por que o dublê é um servidor REAL ─────────────────────────────────────
 *
 * Um `vi.stubGlobal("fetch", ...)` provaria o mesmo texto sem passar pelo
 * `fetchComTeto`, que é quem constrói a `Response` de verdade. Aqui o corpo
 * atravessa a pilha inteira, como em produção.
 *
 * ─── As duas metades ────────────────────────────────────────────────────────
 *
 * Só provar que o segredo sumiu deixa verde um "conserto" que jogue fora a
 * mensagem toda — e aí ninguém mais distingue 401 (credencial) de 500 (o WAHA
 * quebrou). Por isso cada caso exige ALGO: o status tem de continuar lá.
 *
 * Achado de @prevprocesso-maker no PR #465.
 */
describe("o corpo devolvido pelo WAHA nunca entra na exceção", () => {
  /** Tudo que um corpo de erro do WAHA pode carregar, junto numa linha. */
  const CORPO_SENSIVEL =
    '{"error":"session config","phone":"+5511987654321","webhook":' +
    '{"url":"https://crm.exemplo.com/api/v1/webhooks/waha","hmac":{"key":"seg' +
    'redo-do-hmac"}},"apiKey":"a1b2c3d4"}';
  /** Os pedaços que, sozinhos, denunciam vazamento. */
  const AGULHAS = ["+5511987654321", "segredo-do-hmac", "a1b2c3d4", "crm.exemplo.com"];

  let quebrado: Server;
  let urlQuebrado = "";

  beforeAll(async () => {
    quebrado = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(CORPO_SENSIVEL);
    });
    await new Promise<void>((r) => quebrado.listen(0, "127.0.0.1", r));
    urlQuebrado = `http://127.0.0.1:${(quebrado.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => quebrado.close(() => r()));
  });

  /**
   * Toda chamada que LANÇA quando o WAHA responde com status de erro. Enumerar
   * a classe é o ponto: consertar por instância deixa a próxima passar.
   */
  const CHAMADAS: Array<[string, (c: WahaClient) => Promise<unknown>]> = [
    ["startSession", (c) => c.startSession("sessao")],
    ["stopSession", (c) => c.stopSession("sessao")],
    ["logoutSession", (c) => c.logoutSession("sessao")],
    ["deleteSession", (c) => c.deleteSession("sessao")],
    ["getSessionQr", (c) => c.getSessionQr("sessao")],
    ["sendMessage", (c) => c.sendMessage("sessao", "5511999@c.us", "oi")],
    ["checkContactExists", (c) => c.checkContactExists("sessao", "5511999999999")],
    [
      "sendContactVcard",
      (c) =>
        c.sendContactVcard("sessao", "5511999@c.us", [
          { fullName: "F", phoneNumber: "+5511999999999", whatsappId: "5511999@c.us", vcard: "x" },
        ]),
    ],
    [
      "sendMedia",
      (c) => c.sendMedia("sessao", "5511999@c.us", { endpoint: "sendImage", payload: {} }),
    ],
  ];

  it.each(CHAMADAS)("⭐ %s: a mensagem não carrega nada do corpo do WAHA", async (_nome, fn) => {
    const c = new WahaClient(urlQuebrado, "chave-de-teste", { tetoMs: 3_000 });
    const { erro } = await medir(() => fn(c));

    // Controle: sem exceção, o resto do caso não mede nada.
    expect(erro, "a chamada não lançou — o caso ficaria verde sem medir").not.toBe("");
    for (const agulha of AGULHAS) {
      expect(erro, `a exceção carrega "${agulha}", que veio do corpo do WAHA`).not.toContain(agulha);
    }
  });

  it.each(CHAMADAS)("%s: mas o STATUS continua na mensagem", async (_nome, fn) => {
    // Sem esta metade, jogar a mensagem inteira fora passaria — e aí ninguém
    // mais distingue 401 (credencial errada) de 500 (o WAHA quebrou).
    const c = new WahaClient(urlQuebrado, "chave-de-teste", { tetoMs: 3_000 });
    const { erro } = await medir(() => fn(c));
    expect(erro, "o status sumiu junto com o corpo — o diagnóstico foi a zero").toContain("500");
  });

  it("⭐ nenhum corpo de resposta é interpolado numa exceção deste arquivo", async () => {
    // Guarda de CLASSE: os casos acima cobrem os nove caminhos de hoje; este
    // reprova o décimo, que ainda não existe.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fonte = readFileSync(join(process.cwd(), "lib/waha/client.ts"), "utf8");

    // Controle positivo: a sonda precisa achar `new Error(` aqui, senão o
    // vazio abaixo seria "procurei errado" lido como "está limpo".
    expect(fonte, "a sonda não achou nenhum `new Error(` — ela está cega").toContain("new Error(");

    const vazando = fonte
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /new Error\(/.test(l) && /\$\{\s*(body|corpo|texto)\b/.test(l));
    expect(
      vazando.map(([n, l]) => `${n}: ${l.trim()}`),
      "estas exceções carregam o corpo devolvido pelo WAHA, e ele sai na resposta da nossa API pelas rotas de channel-sessions",
    ).toEqual([]);
  });
});
