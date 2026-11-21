import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  linhasDaTabela,
  rpcsForaDaOrganizacao,
} from "./helpers/cliente-admin-falso";

/**
 * INGESTÃO DO CHAT NO SITE: mensagem do visitante → contato, conversa, mensagem.
 *
 * Molde: `channel-telegram-ingest.test.ts`. O que este arquivo vigia:
 *
 *   • `social_identity = webchat:<sessão>:<visitante>`, sem telefone: o visitante
 *     não tem número, e o contato nasce com o nome provisório do módulo.
 *   • `conversations.channel = 'webchat'` e `provider_conversation_id = <visitante>`:
 *     sem o endereço gravado a conversa aparece no inbox e o operador não responde.
 *   • `external_id = wc:<sessão>:<visitante>:<mensagem>`: o prefixo impede que o
 *     id de um visitante engula a mensagem de outro. Reenvio do mesmo id → duplicata.
 *   • efeitos pós-entrada recebem `canal: 'webchat'`, senão o negócio nasce
 *     com a origem errada.
 *   • toda escrita e toda RPC carregam a organização, e nenhuma cadeia sai dela.
 */

vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: vi.fn(async () => undefined),
}));

const { ingerirMensagemDoChat, NOME_DO_VISITANTE } = await import("@/lib/channels/webchat/ingest");
const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
const { marcarConversaComMensagem } = await import("@/lib/channels/marcar-conversa");

const ORG = "org-1";
const CS = "cs-1";
const VIS = "vis-1";
const AGORA = new Date("2026-11-20T12:00:00.000Z");

type Linhas = Record<string, Record<string, unknown>[]>;
type Falso = ReturnType<typeof criarClienteAdminFalso>;

function cenario(linhas: Linhas = {}): Falso {
  return criarClienteAdminFalso({
    orgDona: ORG,
    linhas: {
      conversations: [{ id: "conv-1", organization_id: ORG, channel: "whatsapp" }],
      contacts: [],
      messages: [],
      ...linhas,
    },
    rpc: { fn_upsert_wa_conversation: "conv-1" },
    tabelasSemOrganizacao: [],
  });
}

/**
 * O cliente falso não impõe `unique (organization_id, external_id)`. Este
 * envoltório impõe, do mesmo jeito que o banco: um INSERT com o `external_id`
 * já gravado volta `23505`, e nenhuma cadeia de escrita é registrada.
 */
function clienteComUnique(falso: Falso) {
  const bruto = falso.cliente as {
    from: (tabela: string) => unknown;
    rpc: (nome: string, args?: unknown) => unknown;
  };
  return {
    from(tabela: string) {
      if (tabela !== "messages") return bruto.from(tabela);
      return {
        insert(payload: { external_id: string }) {
          const duplicada = linhasDaTabela(falso, "messages").some(
            (l) => l.external_id === payload.external_id,
          );
          if (!duplicada) {
            return (bruto.from("messages") as { insert: (p: unknown) => unknown }).insert(payload);
          }
          const erro = { data: null, error: { code: "23505", message: "duplicate key" } };
          return { select: () => ({ maybeSingle: async () => erro }) };
        },
      };
    },
    rpc: bruto.rpc,
  };
}

function ingerir(falso: Falso, sobre: Partial<{ organizationId: string; visitanteId: string; mensagemId: string; texto: string }> = {}) {
  return ingerirMensagemDoChat(clienteComUnique(falso) as never, {
    organizationId: ORG,
    channelSessionId: CS,
    visitanteId: VIS,
    mensagemId: "m-1",
    texto: "oi",
    agora: AGORA,
    ...sobre,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ingestão de uma mensagem do visitante", () => {
  it("contato com identidade social da sessão+visitante, nome provisório e SEM telefone", async () => {
    const falso = cenario();
    const r = await ingerir(falso);
    expect(r).toMatchObject({ status: "ingested", conversationId: "conv-1" });

    const contato = linhasDaTabela(falso, "contacts")[0];
    expect(contato).toMatchObject({
      organization_id: ORG,
      social_identity: "webchat:cs-1:vis-1",
      name: NOME_DO_VISITANTE,
      source: "webchat",
    });
    expect(NOME_DO_VISITANTE).toBe("Visitante do site");
    expect(contato).not.toHaveProperty("phone_number");
  });

  it("a conversa ganha o canal `webchat` e o visitante como endereço", async () => {
    const falso = cenario();
    await ingerir(falso);

    const conversa = linhasDaTabela(falso, "conversations").find((l) => l.id === "conv-1");
    expect(conversa).toMatchObject({
      channel: "webchat",
      provider_conversation_id: "vis-1",
    });
  });

  it("grava a mensagem com o external_id prefixado pela sessão e pelo visitante", async () => {
    const falso = cenario();
    const r = await ingerir(falso);

    const msg = linhasDaTabela(falso, "messages")[0];
    expect(msg).toBeDefined();
    expect(msg).toMatchObject({
      organization_id: ORG,
      channel_session_id: CS,
      external_id: "wc:cs-1:vis-1:m-1",
      direction: "inbound",
      sent_via: "external_device",
      status: "delivered",
      type: "text",
      body: "oi",
      sent_at: AGORA.toISOString(),
    });
    expect(r).toMatchObject({ messageId: msg!.id });
  });

  it("a marcação da conversa usa a hora do envio e o canal webchat", async () => {
    await ingerir(cenario());
    expect(marcarConversaComMensagem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        conversationId: "conv-1",
        direction: "inbound",
        canal: "webchat",
        at: AGORA.toISOString(),
      }),
    );
    expect(marcarConversaComMensagem).toHaveBeenCalledTimes(1);
  });

  it("os efeitos pós-entrada rodam uma vez, com canal webchat", async () => {
    await ingerir(cenario());
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledTimes(1);
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        conversationId: "conv-1",
        channelSessionId: CS,
        texto: "oi",
        canal: "webchat",
      }),
    );
  });

  it("contato que já existe para o mesmo visitante é reaproveitado, não duplicado", async () => {
    const falso = cenario({
      contacts: [
        {
          id: "contact-9",
          organization_id: ORG,
          social_identity: "webchat:cs-1:vis-1",
          is_merged_into: null,
        },
      ],
    });
    await ingerir(falso);
    expect(linhasDaTabela(falso, "contacts")).toHaveLength(1);
  });
});

describe("idempotência — o widget reenvia o que não recebeu resposta", () => {
  it("mesmo mensagemId do mesmo visitante: `duplicate`, sem lançar, sem nova marcação", async () => {
    const falso = cenario();
    await ingerir(falso);
    const r = await ingerir(falso);

    expect(r).toMatchObject({ status: "duplicate", conversationId: "conv-1", messageId: null });
    expect(linhasDaTabela(falso, "messages")).toHaveLength(1);
    expect(marcarConversaComMensagem).toHaveBeenCalledTimes(1);
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledTimes(1);
  });

  it("mesmo mensagemId vindo de OUTRO visitante grava: o external_id é outro", async () => {
    const falso = cenario();
    await ingerir(falso);
    const r = await ingerir(falso, { visitanteId: "vis-2" });

    expect(r).toMatchObject({ status: "ingested" });
    const externos = linhasDaTabela(falso, "messages").map((l) => l.external_id);
    expect(externos).toEqual(["wc:cs-1:vis-1:m-1", "wc:cs-1:vis-2:m-1"]);
  });
});

describe("isolamento — nenhuma cadeia nem RPC sai da organização", () => {
  it("toda cadeia filtra ou grava a organização, e a RPC recebe a organização", async () => {
    const falso = cenario();
    await ingerir(falso);

    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG)).toEqual([]);
  });
});
