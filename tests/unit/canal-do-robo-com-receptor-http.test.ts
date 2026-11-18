import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O ROBÔ DE MENSAGENS (#3486) CONTRA UM RECEPTOR HTTP DE VERDADE.
 *
 * Os outros testes do canal trocam `fetch` por um dublê. Este sobe um servidor
 * HTTP local no papel da Bot API (`TELEGRAM_API_BASE_URL` aponta para ele), e
 * o que se afirma é o que chegou PELO FIO: caminho com o token, corpo JSON,
 * segredo do webhook. É a prova possível sem o token de um robô real — que
 * continua pendente, e não é substituída por esta.
 *
 * Os quatro desfechos da v1: texto nos dois sentidos, segredo errado recusado,
 * grupo recusado e campanha recusada.
 */

interface Recebido {
  caminho: string;
  corpo: Record<string, unknown>;
}

const recebidos: Recebido[] = [];
let servidor: Server;
const TOKEN = "123456789:AAH-token-de-prova-local";

/** O que a Bot API responde a cada método — só o que a v1 chama. */
function responder(metodo: string): unknown {
  if (metodo === "getMe") return { ok: true, result: { id: 777, is_bot: true, first_name: "Acme", username: "acme_bot" } };
  if (metodo === "setWebhook" || metodo === "deleteWebhook") return { ok: true, result: true };
  if (metodo === "sendMessage") return { ok: true, result: { message_id: 4242 } };
  return { ok: false, error_code: 404, description: "Not Found" };
}

async function lerCorpo(req: IncomingMessage): Promise<Record<string, unknown>> {
  let bruto = "";
  for await (const parte of req) bruto += String(parte);
  return bruto ? (JSON.parse(bruto) as Record<string, unknown>) : {};
}

vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_a: unknown, texto: string) => `enc:${texto}`,
  decryptWebhookSecret: async (_a: unknown, cifrado: string) => cifrado.replace(/^enc:/, ""),
}));
vi.mock("@/lib/channels/reactivate", () => ({ reactivateChannelSession: async () => ({ error: null }) }));
vi.mock("@/lib/ai/elegibilidade/pre-go-live", () => ({ metadataInicialDoCanal: () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/bot/credentials", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/channels/bot/credentials")>();
  return { ...real, telegramCredsForBotId: async () => ({ token: TOKEN, botId: "777" }) };
});
const ingeridos = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/channels/bot/ingest", () => ({
  ingestTelegramInbound: async (_a: unknown, entrada: { payload: unknown }) => {
    ingeridos.push(entrada.payload);
    return { status: "ingested" };
  },
}));

/** Admin que não acha robô em outra conexão e aceita o INSERT. */
const admin = {
  from() {
    const q: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
          if (prop === "maybeSingle") return async () => ({ data: { id: "sess-1" }, error: null });
          return () => q;
        },
      },
    );
    return q;
  },
} as never;

beforeAll(async () => {
  servidor = createServer(async (req, res) => {
    const caminho = req.url ?? "";
    recebidos.push({ caminho, corpo: await lerCorpo(req) });
    const metodo = caminho.split("/").pop() ?? "";
    const corpo = responder(metodo);
    res.writeHead((corpo as { ok: boolean }).ok ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(corpo));
  });
  await new Promise<void>((pronto) => servidor.listen(0, "127.0.0.1", pronto));
  const { port } = servidor.address() as AddressInfo;
  process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.TELEGRAM_API_BASE_URL;
  await new Promise<void>((fim) => servidor.close(() => fim()));
});

beforeEach(() => {
  recebidos.length = 0;
  ingeridos.length = 0;
});

const { conectarRobo } = await import("@/lib/channels/bot/connect");
const { telegramAdapter } = await import("@/lib/channels/adapters/telegram");
const { handleInboundWebhook } = await import("@/lib/channels/inbound");
const { readTelegramUpdate } = await import("@/lib/channels/bot/webhook");
const { modoDeCampanhaDoCanal } = await import("@/lib/channels/capabilities");
const { decidirConteudo, lerModoDoCanal } = await import("@/lib/campanhas/conteudo-do-canal");

/** Conecta e devolve o `secret_token` que chegou ao receptor no `setWebhook`. */
async function conectarECapturarSegredo(): Promise<string> {
  const r = await conectarRobo(admin, {
    organizationId: "org-1",
    token: TOKEN,
    existente: null,
    webhookUrlBase: "https://crm.exemplo.com.br",
    userId: "u-1",
    requestId: "r-1",
  });
  expect(r.ok).toBe(true);
  const set = recebidos.find((x) => x.caminho.endsWith("/setWebhook"));
  expect(set).toBeDefined();
  return set!.corpo.secret_token as string;
}

const updatePrivado = {
  update_id: 1,
  message: {
    message_id: 10,
    date: 1_762_000_000,
    chat: { id: 5551, type: "private" },
    from: { id: 5551, is_bot: false, first_name: "Ana" },
    text: "oi, tudo bem?",
  },
};

function entrada(segredoNoCabecalho: string, segredoDaSessao: string, corpo: unknown = updatePrivado) {
  return {
    session: { id: "sess-1", organization_id: "org-1", provider: "telegram" },
    rawBody: JSON.stringify(corpo),
    headers: new Headers({ "x-telegram-bot-api-secret-token": segredoNoCabecalho }),
    secret: segredoDaSessao,
  };
}

describe("conectar, contra o receptor", () => {
  it("getMe e setWebhook chegam pelo fio, com o token no caminho e a URL neutra no corpo", async () => {
    const segredo = await conectarECapturarSegredo();
    expect(recebidos.map((x) => x.caminho)).toEqual([`/bot${TOKEN}/getMe`, `/bot${TOKEN}/setWebhook`]);
    const set = recebidos[1]!.corpo;
    expect(String(set.url)).toMatch(/^https:\/\/crm\.exemplo\.com\.br\/api\/v1\/webhooks\/channel\/[0-9a-f]{48}$/);
    expect(set.allowed_updates).toEqual(["message"]);
    expect(segredo).toMatch(/^[0-9a-f]{64}$/);
    expect(segredo).not.toContain(TOKEN);
  });
});

describe("texto nos dois sentidos", () => {
  it("entrada: com o segredo certo no cabeçalho, o update vai para a ingestão", async () => {
    const segredo = await conectarECapturarSegredo();
    const r = await handleInboundWebhook(admin, entrada(segredo, segredo));
    expect(r.ok).toBe(true);
    expect(ingeridos).toEqual([updatePrivado]);
  });

  it("saída: a resposta sai como sendMessage para o chat da conversa", async () => {
    const r = await telegramAdapter.send({
      organizationId: "org-1",
      sessionRef: "777",
      to: "provider-chat",
      providerConversationId: "5551",
      kind: "text",
      body: "Tudo ótimo, como posso ajudar?",
    });
    expect(recebidos).toHaveLength(1);
    expect(recebidos[0]!.caminho).toBe(`/bot${TOKEN}/sendMessage`);
    expect(recebidos[0]!.corpo).toMatchObject({ chat_id: "5551", text: "Tudo ótimo, como posso ajudar?" });
    expect(r.externalId).toBe("tg:777:5551:4242");
  });
});

describe("o que a v1 recusa", () => {
  it("segredo errado ou ausente: 'unauthorized', e nada chega à ingestão", async () => {
    const segredo = await conectarECapturarSegredo();
    const errado = await handleInboundWebhook(admin, entrada("x".repeat(64), segredo));
    expect(errado).toMatchObject({ ok: false, code: "unauthorized" });
    const semCabecalho = await handleInboundWebhook(admin, { ...entrada("", segredo), headers: new Headers() });
    expect(semCabecalho).toMatchObject({ ok: false, code: "unauthorized" });
    expect(ingeridos).toEqual([]);
  });

  it("grupo: o update é lido como sem interesse, não como conversa", () => {
    const grupo = { ...updatePrivado, message: { ...updatePrivado.message, chat: { id: -100, type: "group" } } };
    expect(readTelegramUpdate(grupo, "777")).toMatchObject({ ok: false, motivo: "sem_interesse" });
    // Controle: a mesma mensagem em conversa privada é lida.
    expect(readTelegramUpdate(updatePrivado, "777")).toMatchObject({ ok: true });
  });

  it("grupo: o adapter não resolve destino para responder num grupo", () => {
    expect(telegramAdapter.resolveRecipient({ isGroup: true } as never)).toBeNull();
  });

  it("campanha: o canal não tem modo de campanha, e criar uma por esta conexão responde 409", async () => {
    expect(modoDeCampanhaDoCanal("telegram")).toBeNull();

    const umaLinha = (provider: string) =>
      ({
        from: () => {
          const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: "sess-1", provider } }) };
          return q;
        },
      }) as never;
    const lido = await lerModoDoCanal(umaLinha("telegram"), "org-1", "sess-1");
    expect(lido).toEqual({ existe: true, modo: null, transmissao: false });
    const decisao = await decidirConteudo(umaLinha("telegram"), {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      extras: [],
      modoDoCanal: lido.existe ? lido.modo : null,
      pedido: { message_body: "Promoção!" },
    });
    expect(decisao).toMatchObject({ ok: false, codigo: "campanha_canal_indisponivel", status: 409 });

    // Controle: a mesma leitura com o número por QR devolve texto livre — o
    // null acima é do canal, não de um dublê que sempre responde null.
    expect(await lerModoDoCanal(umaLinha("waha"), "org-1", "sess-1")).toMatchObject({ modo: "text" });
  });
});
