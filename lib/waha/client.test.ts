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

/** Respostas locais independentes: não exercitam pairing nem envio WhatsApp. */
describe("sessões: conflito conhecido só converge com identidade e pós-condição", () => {
  type Step = { method: string; path: string; status: number; body?: unknown };
  const name = "qa/session";
  const sessionPath = "/api/sessions/qa%2Fsession";
  const config = { ignore: { status: true, broadcast: true, channels: true, groups: true } };
  const session = (status = "STOPPED", extra: Record<string, unknown> = {}) =>
    ({ name, status, config, engine: { engine: "NOWEB" }, ...extra });
  const duplicate = { statusCode: 422, error: "Unprocessable Entity", message: `Session '${name}' already exists. Use PUT to update it.` };
  const create = (status = 201, body: unknown = session()): Step => ({ method: "POST", path: "/api/sessions", status, body });
  const read = (body: unknown = session(), status = 200): Step => ({ method: "GET", path: sessionPath, status, body });
  const start: Step = { method: "POST", path: `${sessionPath}/start`, status: 201, body: session("STARTING") };

  async function receive(steps: Step[], run: (client: WahaClient, seen: string[]) => Promise<void>) {
    const seen: string[] = [];
    const unexpected: string[] = [];
    const server = createServer((req, res) => {
      const call = `${req.method} ${req.url}`;
      seen.push(call);
      const next = steps.shift();
      if (!next || next.method !== req.method || next.path !== req.url || req.headers["x-api-key"] !== "plaintext-local") {
        unexpected.push(call);
        res.writeHead(500).end();
        return;
      }
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run(new WahaClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "plaintext-local"), seen);
      expect(unexpected).toEqual([]);
      expect(steps).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("create 422 conhecido + GET compatível + start + GET correto converge sem PUT", async () => {
    await receive([create(422, duplicate), read(), start, read(session("SCAN_QR_CODE"))], async (c) => {
      await expect(c.startSession(name)).resolves.toMatchObject({ status: "SCAN_QR_CODE" });
    });
  });

  it.each([409, 422])("create %i desconhecido não pode virar sucesso nem PUT", async (status) => {
    await receive([create(status, { statusCode: status, message: "invalid apiKey=private-secret" })], async (c) => {
      const error = await c.startSession(name).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`waha_create_${status}`);
    });
  });

  it.each([
    ["outra identidade", { name: "outra" }],
    ["outro engine", { engine: { engine: "WEBJS" } }],
    ["config inválida", { config: null }],
    ["filtro explícito incompatível", { config: { ignore: { groups: false } } }],
  ])("conflito de create com %s falha sem tomar a sessão", async (_label, extra) => {
    await receive([create(422, duplicate), read(session("STOPPED", extra))], async (c) => {
      await expect(c.startSession(name)).rejects.toThrow("waha_create_422");
    });
  });

  it("2xx também exige GET; resposta inicial STARTING não disfarça FAILED", async () => {
    await receive([create(), read(), start, read(session("FAILED"))], async (c) => {
      await expect(c.startSession(name)).rejects.toThrow("waha_start_201");
    });
  });

  it("start 422 conhecido só converge com estado ativo da sessão certa", async () => {
    const conflict = { ...start, status: 422, body: { statusCode: 422, error: "Unprocessable Entity", message: `Session '${name}' is already started.` } };
    await receive([create(), read(), conflict, read(session("WORKING"))], async (c) => {
      await expect(c.startSession(name)).resolves.toMatchObject({ status: "WORKING" });
    });
  });

  it.each(["STOPPED", "FAILED"])("start em %s não é convergência", async (status) => {
    const conflict = { ...start, status: 422, body: { statusCode: 422, error: "Unprocessable Entity", message: `Session '${name}' is already started.` } };
    await receive([create(), read(), conflict, read(session(status))], async (c) => {
      await expect(c.startSession(name)).rejects.toThrow("waha_start_422");
    });
  });

  for (const operation of ["stop", "logout", "delete"] as const) {
    const call = (c: WahaClient) => operation === "stop" ? c.stopSession(name) : operation === "logout" ? c.logoutSession(name) : c.deleteSession(name);
    const operationStep = (status: number, body: unknown = {}) => ({ method: operation === "delete" ? "DELETE" : "POST", path: operation === "delete" ? sessionPath : `${sessionPath}/${operation}`, status, body });
    it.each([409, 422])(`${operation} %i sem corpo conhecido mantém erro`, async (status) => {
      await receive([operationStep(status, { statusCode: status, message: "private-secret" })], async (c) => {
        await expect(call(c)).rejects.toThrow(`waha_${operation}_${status}`);
      });
    });
    it(`${operation} 2xx com sessão ainda WORKING falha`, async () => {
      await receive([operationStep(200), read(session("WORKING"))], async (c) => {
        await expect(call(c)).rejects.toThrow(`waha_${operation}_200`);
      });
    });
    it(`${operation} 2xx converge após leitura da pós-condição`, async () => {
      const final = operation === "delete" ? read({ statusCode: 404, message: "Session not found", error: "Not Found" }, 404) : read(session("STOPPED", { me: null }));
      await receive([operationStep(200), final], async (c) => {
        await expect(call(c)).resolves.toBeUndefined();
      });
    });
  }

  it("logout STOPPED com identidade pareada ainda presente não é deslogado", async () => {
    await receive([{ method: "POST", path: `${sessionPath}/logout`, status: 200 }, read(session("STOPPED", { me: { id: "paired" } }))], async (c) => {
      await expect(c.logoutSession(name)).rejects.toThrow("waha_logout_200");
    });
  });

  it("delete 404 precisa confirmar ausência no GET", async () => {
    const absent = { statusCode: 404, message: "Session not found", error: "Not Found" };
    await receive([{ method: "DELETE", path: sessionPath, status: 404, body: absent }, read(absent, 404)], async (c) => {
      await expect(c.deleteSession(name)).resolves.toBeUndefined();
    });
  });
  it("logout ativo reiniciado em STARTING sem me respeita contrato upstream", async () => {
    await receive([{ method: "POST", path: `${sessionPath}/logout`, status: 200 }, read(session("STARTING", { me: null }))], async (c) => {
      await expect(c.logoutSession(name)).resolves.toBeUndefined();
    });
  });

  it("GET pós-start não aceita engine alterado mesmo com WORKING", async () => {
    await receive([create(), read(), start, read(session("WORKING", { engine: { engine: "WEBJS" } }))], async (c) => {
      await expect(c.startSession(name)).rejects.toThrow("waha_start_201");
    });
  });

  it("convergência não faz PUT sobre engine incompatível", async () => {
    await receive([read(session("STOPPED", { config: {}, engine: { engine: "WEBJS" } }))], async (c) => {
      await c.convergirConfigDaSessao(name);
    });
  });

  it("sessão STOPPED sem engine usa versão do servidor, e versão desconhecida permite tentar", async () => {
    await receive([
      create(), read(session("STOPPED", { engine: {} })),
      { method: "GET", path: "/api/server/version", status: 200, body: { version: "2027.1.0", tier: "CORE", engine: "NOWEB" } },
      start, read(session("SCAN_QR_CODE")),
    ], async (c) => {
      await expect(c.startSession(name)).resolves.toMatchObject({ status: "SCAN_QR_CODE" });
    });
  });

  it.each([409, 422])("start %i desconhecido falha mesmo se o servidor disser estado desejado", async (status) => {
    await receive([create(), read(), { ...start, status, body: { statusCode: status, error: "Unprocessable Entity", message: "invalid payload" } }], async (c) => {
      await expect(c.startSession(name)).rejects.toThrow(`waha_start_${status}`);
    });
  });

  it.each(["stop", "logout", "delete"] as const)("%s não aceita identidade divergente no GET", async (operation) => {
    const step = { method: operation === "delete" ? "DELETE" : "POST", path: operation === "delete" ? sessionPath : `${sessionPath}/${operation}`, status: 200 };
    await receive([step, read(session("STOPPED", { name: "outra", me: null }))], async (c) => {
      const call = operation === "stop" ? c.stopSession(name) : operation === "logout" ? c.logoutSession(name) : c.deleteSession(name);
      await expect(call).rejects.toThrow(`waha_${operation}_200`);
    });
  });

  it("404 de gateway sem envelope não confirma delete", async () => {
    await receive([{ method: "DELETE", path: sessionPath, status: 200 }, read({ message: "route not found" }, 404)], async (c) => {
      await expect(c.deleteSession(name)).rejects.toThrow("waha_delete_404");
    });
  });

  it("envelope de conflito referente a outro nome não concede start", async () => {
    await receive([create(422, { ...duplicate, message: "Session 'outra' already exists. Use PUT to update it." })], async (c) => {
      await expect(c.startSession(name)).rejects.toThrow("waha_create_422");
    });
  });

  it("porta granular inicia sessão existente sem criar nem fazer PUT", async () => {
    await receive([start, read(session("SCAN_QR_CODE"))], async (c) => {
      await expect(c.startExistingSession(name)).resolves.toMatchObject({ name, status: "SCAN_QR_CODE" });
    });
  });

});
