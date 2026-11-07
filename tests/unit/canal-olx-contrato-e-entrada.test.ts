import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CANAL OLX (#2927) — contrato do adaptador e entrada do webhook.
 *
 * A fatia que este arquivo prova é a que NÃO precisa de credencial de terceiro:
 *
 *   1. o payload documentado da OLX (`developers.olx.com.br/chat/receive_message.html`)
 *      vira mensagem normalizada — texto, remetente, conversa;
 *   2. a resposta sai pelo `send`, no corpo documentado de
 *      `developers.olx.com.br/chat/send_message.html`;
 *   3. o MESMO evento entregue duas vezes deixa UMA mensagem;
 *   4. o vocábulo `olx` existe no tipo, no CHECK (migration + baseline) e a
 *      migration é de ALARGAMENTO — nada de canal existente muda.
 *
 * O que NÃO se prova aqui, e está declarado no PR: nada foi falado com a API da
 * OLX. Não há `client_id`, não há token e não há conta de anunciante. A fixture
 * abaixo é o corpo do exemplo da documentação, com valores sintéticos.
 */

const TOKEN = "token-sintetico-de-anunciante-nao-vaza";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

vi.mock("@/lib/channels/olx/credentials", () => ({
  resolverCredenciaisOlx: vi.fn(async () => ({
    channelSessionId: "sessao-olx",
    conta: "conta-olx-1",
    token: TOKEN,
  })),
}));

import { getAdapter } from "@/lib/channels";
import { olxAdapter } from "@/lib/channels/adapters/olx";
import { CHANNEL_PROVIDER_OLX, capabilitiesOf, transportaMensagem, PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";
import { acceptsInboundWebhook, handleInboundWebhook, verifyInboundWebhookSignature } from "@/lib/channels/inbound";
import { lerEnvelopeOlx, parseOlxInbound } from "@/lib/channels/olx/webhook";
import { resolveSessionRef } from "@/lib/channels/session-ref";

/** O corpo do exemplo da doc, com valores sintéticos. */
const FIXTURE = {
  chatId: "chat-sintetico-9f2",
  message: "Ainda está disponível?",
  senderType: "buyer",
  email: "comprador@exemplo.test",
  name: "Comprador Sintético",
  phone: "+5511900000000",
  messageTimestamp: "2026-11-06T14:32:11.000",
  messageId: "msg-sintetica-0001",
  origin: "buyer",
  listId: "anuncio-sintetico-77",
};

const SESSAO = { id: "sessao-olx", organization_id: "org-1", provider: "olx" };

function bancoDeMentira() {
  const gravadas = new Map<string, Record<string, unknown>>();
  const estado = {
    inserts: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    rpcs: [] as string[],
  };

  const admin = {
    async rpc(nome: string) {
      estado.rpcs.push(nome);
      if (nome === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (nome === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
    from(tabela: string) {
      if (tabela === "conversations") {
        return {
          update(patch: Record<string, unknown>) {
            estado.updates.push(patch);
            return { eq: async () => ({ data: null, error: null }) };
          },
        };
      }
      if (tabela === "messages") {
        return {
          insert(linha: Record<string, unknown>) {
            estado.inserts.push(linha);
            const chave = String(linha.external_id);
            const repetida = gravadas.has(chave);
            if (!repetida) gravadas.set(chave, linha);
            return {
              select: () => ({
                maybeSingle: async () =>
                  repetida
                    ? { data: null, error: { code: "23505", message: "duplicate key" } }
                    : { data: { id: `msg-${gravadas.size}` }, error: null },
              }),
            };
          },
        };
      }
      throw new Error(`tabela inesperada no dublê: ${tabela}`);
    },
  };

  return { admin, estado, gravadas };
}

async function entregar(admin: unknown, corpo: unknown, headers = new Headers()) {
  return handleInboundWebhook(admin as never, {
    session: SESSAO,
    rawBody: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    headers,
    secret: null,
  });
}

describe("contrato do adaptador OLX", () => {
  it("a fixture vira mensagem normalizada: texto, remetente e conversa", () => {
    const leitura = lerEnvelopeOlx(JSON.stringify(FIXTURE));
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;

    const mensagem = parseOlxInbound(leitura.envelope);
    expect(mensagem).not.toBeNull();
    expect(mensagem).toMatchObject({
      chatId: "chat-sintetico-9f2",
      texto: "Ainda está disponível?",
      messageId: "msg-sintetica-0001",
      origin: "buyer",
      nome: "Comprador Sintético",
      telefone: "+5511900000000",
      email: "comprador@exemplo.test",
      anuncioId: "anuncio-sintetico-77",
    });
    // `2026-11-06T14:32:11.000` sem fuso é lido como Brasília (-03), de forma
    // determinística: 17:32:11Z em QUALQUER host (o `TZ` do processo não manda).
    expect(mensagem?.recebidaEm.toISOString()).toBe("2026-11-06T17:32:11.000Z");
  });

  it("o adapter existe, é canal de mensagem e NÃO disca telefone", () => {
    expect(getAdapter("olx")).toBe(olxAdapter);
    expect(olxAdapter.provider).toBe(CHANNEL_PROVIDER_OLX);
    expect(transportaMensagem("olx")).toBe(true);
    // O endereço é o `chatId` da thread: quem escolhe uma conexão OLX para
    // discar um número escolheu um canal que não alcança o destino.
    expect((PROVIDERS_DE_TELEFONE as readonly string[]).includes("olx")).toBe(false);
    expect(olxAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: "+5511900000000", waIdentity: null })).toBe("olx-chat");
    expect(olxAdapter.resolveRecipient({ isGroup: true, groupChatId: "g", phoneNumber: null, waIdentity: null })).toBeNull();
    expect(olxAdapter.codes.notConfigured).toBe("olx_not_configured");
  });

  it("o sessionRef vem da conta de anunciante, e a coluna entra no select", () => {
    expect(resolveSessionRef({ provider: "olx", olx_account_id: "conta-olx-1" })).toBe("conta-olx-1");
  });

  it("`send` responde a thread no corpo documentado", async () => {
    const chamadas: Array<{ url: string; init: RequestInit }> = [];
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      chamadas.push({ url, init });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const r = await olxAdapter.send({
        organizationId: "org-1",
        sessionRef: "conta-olx-1",
        to: "olx-chat",
        kind: "text",
        body: "Sim, está disponível!",
        providerConversationId: FIXTURE.chatId,
      });

      expect(chamadas).toHaveLength(1);
      expect(chamadas[0].url).toBe("https://apps.olx.com.br/autoservice/v1/chat/send");
      const headers = chamadas[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      const corpo = JSON.parse(String(chamadas[0].init.body)) as Record<string, string>;
      expect(Object.keys(corpo).sort()).toEqual(["chatId", "messageId", "textMessage"]);
      expect(corpo.chatId).toBe(FIXTURE.chatId);
      expect(corpo.textMessage).toBe("Sim, está disponível!");
      // A OLX não devolve id: o `external_id` é o que NÓS mandamos.
      expect(r.externalId).toBe(corpo.messageId);
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });

  it("sem thread conhecida, `send` recusa em vez de inventar destinatário", async () => {
    await expect(
      olxAdapter.send({
        organizationId: "org-1",
        sessionRef: "conta-olx-1",
        to: "olx-chat",
        kind: "text",
        body: "oi",
        providerConversationId: null,
      }),
    ).rejects.toThrow(/olx_not_configured/);
  });

  it("a recusa da plataforma sobe SEM o token", async () => {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "token inválido" }), { status: 401 })) as typeof fetch;
    try {
      const erro = await olxAdapter
        .send({
          organizationId: "org-1",
          sessionRef: "conta-olx-1",
          to: "olx-chat",
          kind: "text",
          body: "oi",
          providerConversationId: FIXTURE.chatId,
        })
        .then(
          () => null,
          (e: Error) => e,
        );
      expect(erro).toBeInstanceOf(Error);
      expect(erro?.message).toContain("olx_401");
      expect(erro?.message).toContain("token inválido");
      // O segredo nunca entra na mensagem que vira `error_code` na mensagem e
      // linha no log.
      expect(erro?.message).not.toContain(TOKEN);
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });
});

describe("entrada do webhook OLX", () => {
  let banco: ReturnType<typeof bancoDeMentira>;

  beforeEach(() => {
    banco = bancoDeMentira();
  });

  it("aceita o canal e não exige assinatura que a OLX não manda", () => {
    expect(acceptsInboundWebhook("olx")).toBe(true);
    expect(verifyInboundWebhookSignature("olx", "{}", new Headers(), null)).toBe(true);
    // Controle: canal que assina continua fail-closed sem segredo.
    expect(verifyInboundWebhookSignature("zernio", "{}", new Headers(), null)).toBe(false);
  });

  it("a mensagem do comprador entra uma vez, na conversa da thread", async () => {
    const r = await entregar(banco.admin, FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.status).toBe("ingested");

    expect(banco.estado.inserts).toHaveLength(1);
    const linha = banco.estado.inserts[0];
    expect(linha).toMatchObject({
      organization_id: "org-1",
      conversation_id: "conversa-1",
      channel_session_id: "sessao-olx",
      contact_id: "contato-1",
      direction: "inbound",
      type: "text",
      body: "Ainda está disponível?",
      external_id: "msg-sintetica-0001",
    });
    // A thread é a conversa: sem esta coluna o atendente não consegue responder.
    expect(banco.estado.updates[0]).toEqual({ provider_conversation_id: FIXTURE.chatId });
    expect(banco.estado.rpcs).toContain("fn_mark_conversation_message");
  });

  it("IDEMPOTÊNCIA: o mesmo evento duas vezes deixa UMA mensagem", async () => {
    const primeira = await entregar(banco.admin, FIXTURE);
    const segunda = await entregar(banco.admin, FIXTURE);

    expect(primeira.ok && primeira.body.status).toBe("ingested");
    expect(segunda.ok && segunda.body.status).toBe("duplicate");
    expect(banco.estado.inserts).toHaveLength(2); // duas tentativas...
    expect(banco.gravadas.size).toBe(1); // ...e uma mensagem só.
  });

  it("eco do vendedor e aviso de sistema não viram mensagem do cliente", async () => {
    const eco = await entregar(banco.admin, { ...FIXTURE, origin: "seller", messageId: "m-eco" });
    const sistema = await entregar(banco.admin, { ...FIXTURE, senderType: "system", messageId: "m-sys" });

    expect(eco.ok && eco.body).toMatchObject({ status: "ignored", reason: "evento_sem_interesse" });
    expect(sistema.ok && sistema.body).toMatchObject({ status: "ignored" });
    expect(banco.estado.inserts).toHaveLength(0);
  });

  it("payload fora do contrato é recusado NOMEANDO o campo, sem ecoar valores", async () => {
    const semChat = { ...FIXTURE } as Record<string, unknown>;
    delete semChat.chatId;
    const r = await entregar(banco.admin, semChat);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("contrato_violado");
    expect(r.message).toContain("chatId");
    // O corpo traz nome, e-mail e telefone do comprador: nada disso pode ir
    // para a mensagem de erro, que é gravada e logada.
    expect(r.message).not.toContain(FIXTURE.name);
    expect(r.message).not.toContain(FIXTURE.email);
    expect(banco.estado.inserts).toHaveLength(0);
  });

  it("JSON quebrado é distinto de contrato violado", async () => {
    const r = await entregar(banco.admin, "{ isso não é json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_json");
  });
});

describe("vocabulário e migration do canal OLX", () => {
  const MIGRATION = "supabase/migrations/20261107120000_9242_canal_olx.sql";

  it("declara o perfil do canal: sem janela, sem modelo, sem telefone", () => {
    const caps = capabilitiesOf("olx");
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.canManageTemplates).toBe(false);
    expect(caps.freeformOutsideWindow).toBe(true);
    expect(caps.groups).toBe("none");
    expect(caps.phonebook).toBe(false);
  });

  it("migration e baseline conhecem o provider, o ramo do CHECK e o arquivo do webhook", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,600}'olx'::text/);
    expect(baseline).toMatch(/provider = 'olx'\s+and olx_account_id\s+is not null/);
    // O comentário da 0601 no meio da lista fecha parêntese, então o recorte é
    // por janela e não por "até o próximo `)`".
    expect(baseline).toMatch(/webhook_events_log_provider_check check \(provider in \([\s\S]{0,600}?'olx'/);
    expect(baseline).toContain("channel_sessions_olx_account_id_ativo_unique");
    // Colunas ANTES do CHECK que as referencia — senão o install quebra.
    expect(baseline.indexOf("add column if not exists olx_account_id")).toBeLessThan(
      baseline.indexOf("(provider = 'olx'"),
    );

    const mig = readFileSync(MIGRATION, "utf8");
    expect(mig.startsWith("-- manifest:")).toBe(true);
    expect(mig).toContain("add column if not exists olx_account_id");
    expect(mig).toMatch(/provider = 'olx' and olx_account_id is not null/);
    expect(mig).toContain("'olx'");
  });

  it("a migration só ALARGA: nenhum valor de canal existente sai dos CHECKs", () => {
    const mig = readFileSync(MIGRATION, "utf8");
    for (const canal of ["waha", "meta_cloud", "zernio", "zernio_social", "wacalls", "datafy"]) {
      expect(mig).toContain(`'${canal}'`);
    }
    // O arquivo do webhook também não pode perder os provedores que já grava.
    for (const provedor of ["nuvemshop", "generic", "stripe", "asaas"]) {
      expect(mig).toContain(`'${provedor}'`);
    }
  });
});
