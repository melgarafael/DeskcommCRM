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
 *   • LGPD: a primeira mensagem do visitante só entra com o aceite; sem ele, ou sem um
 *     campo obrigatório, a ingestão recusa e não cria contato, conversa nem mensagem.
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
/** Versão do aviso (a constante `TEXTO_DO_AVISO_VERSAO` de config.ts; literal aqui para não carregar o env). */
const VERSAO = "v1";

type Linhas = Record<string, Record<string, unknown>[]>;
type Falso = ReturnType<typeof criarClienteAdminFalso>;
type Sobre = Partial<{
  organizationId: string;
  visitanteId: string;
  mensagemId: string;
  texto: string;
  aceite: { versao: string; em: string } | undefined;
  contato: { nome?: string; telefone?: string; email?: string } | undefined;
  coleta: Partial<Record<"nome" | "telefone" | "email", "oculto" | "opcional" | "obrigatorio">> | undefined;
}>;

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
/** Atualização que o banco recusa: encadeia `eq` e resolve com o erro, como o cliente real. */
function atualizacaoRecusada(erro: { code: string; message: string }) {
  const cadeia = {
    eq: () => cadeia,
    then: (ok: (v: unknown) => unknown, falha?: (m: unknown) => unknown) =>
      Promise.resolve({ data: null, error: erro }).then(ok, falha),
  };
  return cadeia;
}

function clienteComUnique(falso: Falso) {
  const bruto = falso.cliente as {
    from: (tabela: string) => unknown;
    rpc: (nome: string, args?: unknown) => unknown;
  };
  return {
    from(tabela: string) {
      if (tabela === "contacts") {
        // `uniq_contacts_org_phone` e `uniq_contacts_org_email`: o telefone e o e-mail são únicos
        // por organização. Um UPDATE que repete o de outro contato volta 23505.
        return {
          select: (...args: unknown[]) =>
            (bruto.from("contacts") as { select: (...a: unknown[]) => unknown }).select(...args),
          insert: (payload: unknown) =>
            (bruto.from("contacts") as { insert: (p: unknown) => unknown }).insert(payload),
          update(payload: Record<string, unknown>) {
            const colidiu = linhasDaTabela(falso, "contacts").some(
              (l) =>
                (payload.phone_number !== undefined && l.phone_number === payload.phone_number) ||
                (payload.email !== undefined && l.email === payload.email),
            );
            if (colidiu) return atualizacaoRecusada({ code: "23505", message: "duplicate key" });
            return (bruto.from("contacts") as { update: (p: unknown) => unknown }).update(payload);
          },
        };
      }
      if (tabela !== "messages") return bruto.from(tabela);
      return {
        select: (...args: unknown[]) =>
          (bruto.from("messages") as { select: (...a: unknown[]) => unknown }).select(...args),
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

function ingerir(falso: Falso, sobre: Sobre = {}) {
  return ingerirMensagemDoChat(clienteComUnique(falso) as never, {
    organizationId: ORG,
    channelSessionId: CS,
    visitanteId: VIS,
    mensagemId: "m-1",
    texto: "oi",
    agora: AGORA,
    aceite: { versao: VERSAO, em: AGORA.toISOString() },
    ...sobre,
  });
}

/**
 * O dublê não grava a conversa que a RPC `fn_upsert_wa_conversation` cria. Depois da
 * primeira entrada, esta função dá à conversa do cenário o contato e a sessão que a RPC
 * daria, para a checagem "é a primeira mensagem?" enxergar a conversa existente.
 */
function vincularConversa(falso: Falso): void {
  const contato = linhasDaTabela(falso, "contacts")[0];
  const conversa = linhasDaTabela(falso, "conversations").find((l) => l.id === "conv-1");
  if (!contato || !conversa) throw new Error("cenário sem contato ou conversa para vincular");
  Object.assign(conversa, { contact_id: contato.id, channel_session_id: CS });
}

function escritasEm(falso: Falso, tabela: string): number {
  return falso.cadeias.filter(
    (c) => c.tabela === tabela && (c.operacao === "insert" || c.operacao === "upsert"),
  ).length;
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

describe("aceite de LGPD na primeira mensagem", () => {
  it("(a) primeira mensagem sem aceite é recusada e não cria contato, conversa nem mensagem", async () => {
    const falso = cenario();
    const r = await ingerir(falso, { aceite: undefined });

    expect(r).toMatchObject({ status: "recusada", motivo: "aceite_ausente" });
    expect(linhasDaTabela(falso, "contacts")).toHaveLength(0);
    expect(linhasDaTabela(falso, "messages")).toHaveLength(0);
    expect(escritasEm(falso, "contacts")).toBe(0);
    expect(escritasEm(falso, "messages")).toBe(0);
    expect(falso.rpcs).toHaveLength(0);
    expect(marcarConversaComMensagem).not.toHaveBeenCalled();
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });

  it("(b) com aceite, a mensagem grava metadata.webchat_aceite com a hora que o servidor mandou", async () => {
    const falso = cenario();
    const r = await ingerir(falso, { aceite: { versao: VERSAO, em: AGORA.toISOString() } });

    expect(r).toMatchObject({ status: "ingested" });
    const msg = linhasDaTabela(falso, "messages")[0];
    expect(msg?.metadata).toEqual({ webchat_aceite: { versao: "v1", em: AGORA.toISOString() } });
  });

  it("(c) a segunda mensagem não exige aceite e não o regrava", async () => {
    const falso = cenario();
    await ingerir(falso);
    vincularConversa(falso);

    const semAceite = await ingerir(falso, { mensagemId: "m-2", texto: "segunda", aceite: undefined });
    const comAceiteDeNovo = await ingerir(falso, {
      mensagemId: "m-3",
      texto: "terceira",
      aceite: { versao: "v2", em: "2026-11-21T09:00:00.000Z" },
    });

    expect(semAceite).toMatchObject({ status: "ingested" });
    expect(comAceiteDeNovo).toMatchObject({ status: "ingested" });
    const mensagens = linhasDaTabela(falso, "messages");
    expect(mensagens).toHaveLength(3);
    expect((mensagens[1]?.metadata as Record<string, unknown> | undefined)?.webchat_aceite).toBeUndefined();
    expect((mensagens[2]?.metadata as Record<string, unknown> | undefined)?.webchat_aceite).toBeUndefined();
    expect(mensagens[0]?.metadata).toEqual({ webchat_aceite: { versao: "v1", em: AGORA.toISOString() } });
  });

  it("(g) reenvio de uma mensagem já gravada não pede aceite de novo: devolve duplicate", async () => {
    const falso = cenario();
    await ingerir(falso);
    const reenvio = await ingerir(falso, { aceite: undefined });

    expect(reenvio).toMatchObject({ status: "duplicate", conversationId: "conv-1", messageId: null });
    expect(linhasDaTabela(falso, "messages")).toHaveLength(1);
  });
});

describe("coleta de contato na primeira mensagem", () => {
  it("(d) campo obrigatório ausente é recusado, e nada é criado", async () => {
    const falso = cenario();
    const r = await ingerir(falso, {
      coleta: { nome: "obrigatorio", telefone: "opcional", email: "oculto" },
      contato: { telefone: "+5511999999999" },
    });

    expect(r).toMatchObject({ status: "recusada", motivo: "campo_obrigatorio" });
    expect(linhasDaTabela(falso, "contacts")).toHaveLength(0);
    expect(linhasDaTabela(falso, "messages")).toHaveLength(0);
    expect(falso.rpcs).toHaveLength(0);
  });

  it("(d) campo obrigatório vazio (só espaços) conta como ausente", async () => {
    const falso = cenario();
    const r = await ingerir(falso, {
      coleta: { nome: "obrigatorio" },
      contato: { nome: "   " },
    });
    expect(r).toMatchObject({ status: "recusada", motivo: "campo_obrigatorio" });
    expect(linhasDaTabela(falso, "messages")).toHaveLength(0);
  });

  it("(d) campo oculto enviado é ignorado: não grava e não recusa", async () => {
    const falso = cenario();
    const r = await ingerir(falso, {
      coleta: { nome: "opcional", telefone: "opcional", email: "oculto" },
      contato: { nome: "Ana", email: "ana@example.com" },
    });

    expect(r).toMatchObject({ status: "ingested" });
    const contato = linhasDaTabela(falso, "contacts")[0];
    expect(contato?.name).toBe("Ana");
    expect(contato).not.toHaveProperty("email");
  });

  it("(e) nome enviado substitui o provisório; telefone e e-mail vão para o contato, aparados", async () => {
    const falso = cenario();
    await ingerir(falso, {
      coleta: { nome: "obrigatorio", telefone: "opcional", email: "opcional" },
      contato: { nome: "  Ana Souza  ", telefone: " +5511999999999 ", email: " ana@example.com " },
    });

    const contato = linhasDaTabela(falso, "contacts")[0];
    expect(contato).toMatchObject({
      name: "Ana Souza",
      display_name: "Ana Souza",
      phone_number: "+5511999999999",
      email: "ana@example.com",
    });
  });

  it("(e) campo opcional vazio não apaga valor que o contato já tem", async () => {
    const falso = cenario({
      contacts: [
        {
          id: "contact-9",
          organization_id: ORG,
          social_identity: "webchat:cs-1:vis-1",
          is_merged_into: null,
          name: "Ana Souza",
          display_name: "Ana Souza",
          phone_number: "+5511999999999",
          email: "ana@example.com",
        },
      ],
    });
    await ingerir(falso, {
      coleta: { nome: "opcional", telefone: "opcional", email: "opcional" },
      contato: { nome: "", telefone: "", email: "" },
    });

    expect(linhasDaTabela(falso, "contacts")[0]).toMatchObject({
      name: "Ana Souza",
      phone_number: "+5511999999999",
      email: "ana@example.com",
    });
  });
});

describe("dados do contato — colisão, segunda mensagem e formato", () => {
  it("(a) telefone já usado por outro contato: a mensagem entra, o telefone não é gravado e o nome é", async () => {
    const falso = cenario({
      contacts: [
        {
          id: "outro",
          organization_id: ORG,
          social_identity: "webchat:cs-9:vis-9",
          is_merged_into: null,
          name: "Outra",
          phone_number: "+5511999999999",
        },
      ],
    });
    const r = await ingerir(falso, {
      contato: { nome: "Ana", telefone: "+5511999999999" },
      coleta: { nome: "opcional", telefone: "opcional" },
    });

    expect(r).toMatchObject({ status: "ingested" });
    const contato = linhasDaTabela(falso, "contacts").find((l) => l.social_identity === "webchat:cs-1:vis-1");
    expect(contato).toMatchObject({ name: "Ana", display_name: "Ana" });
    expect(contato).not.toHaveProperty("phone_number");
    expect(linhasDaTabela(falso, "messages")).toHaveLength(1);
  });

  it("(a) e-mail já usado por outro contato: a mensagem entra, o e-mail não é gravado e o nome é", async () => {
    const falso = cenario({
      contacts: [
        {
          id: "outro",
          organization_id: ORG,
          social_identity: "webchat:cs-9:vis-9",
          is_merged_into: null,
          name: "Outra",
          email: "ana@example.com",
        },
      ],
    });
    const r = await ingerir(falso, {
      contato: { nome: "Ana", email: "ana@example.com" },
      coleta: { nome: "opcional", email: "opcional" },
    });

    expect(r).toMatchObject({ status: "ingested" });
    const contato = linhasDaTabela(falso, "contacts").find((l) => l.social_identity === "webchat:cs-1:vis-1");
    expect(contato).toMatchObject({ name: "Ana" });
    expect(contato).not.toHaveProperty("email");
  });

  it("(b) contato enviado na segunda mensagem não altera nada do contato", async () => {
    const falso = cenario();
    await ingerir(falso, { contato: { nome: "Ana" } });
    vincularConversa(falso);

    const r = await ingerir(falso, {
      mensagemId: "m-2",
      texto: "segunda",
      aceite: undefined,
      contato: { nome: "Outro nome", telefone: "+5511888888888", email: "outro@example.com" },
      coleta: { nome: "opcional", telefone: "opcional", email: "opcional" },
    });

    expect(r).toMatchObject({ status: "ingested" });
    const contato = linhasDaTabela(falso, "contacts")[0];
    expect(contato).toMatchObject({ name: "Ana", display_name: "Ana" });
    expect(contato).not.toHaveProperty("phone_number");
    expect(contato).not.toHaveProperty("email");
  });

  it("(c) telefone vazio (formato inválido, vindo da rota) em campo opcional: a mensagem entra sem telefone", async () => {
    const falso = cenario();
    const r = await ingerir(falso, { contato: { telefone: "" }, coleta: { telefone: "opcional" } });

    expect(r).toMatchObject({ status: "ingested" });
    expect(linhasDaTabela(falso, "contacts")[0]).not.toHaveProperty("phone_number");
  });

  it("(d) telefone vazio (formato inválido) em campo obrigatório recusa e não cria nada", async () => {
    const falso = cenario();
    const r = await ingerir(falso, { contato: { telefone: "" }, coleta: { telefone: "obrigatorio" } });

    expect(r).toMatchObject({ status: "recusada", motivo: "campo_obrigatorio" });
    expect(linhasDaTabela(falso, "contacts")).toHaveLength(0);
    expect(linhasDaTabela(falso, "messages")).toHaveLength(0);
    expect(falso.rpcs).toHaveLength(0);
  });

  it("(e) campo oculto com formato inválido é ignorado: a mensagem entra e nada é gravado", async () => {
    const falso = cenario();
    const r = await ingerir(falso, {
      contato: { telefone: "abc", email: "nao-e-email" },
      coleta: { telefone: "oculto", email: "oculto" },
    });

    expect(r).toMatchObject({ status: "ingested" });
    const contato = linhasDaTabela(falso, "contacts")[0];
    expect(contato).not.toHaveProperty("phone_number");
    expect(contato).not.toHaveProperty("email");
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

  it("a checagem de primeira mensagem e a atualização do contato também ficam na organização", async () => {
    const falso = cenario();
    await ingerir(falso, {
      coleta: { nome: "opcional" },
      contato: { nome: "Ana" },
    });
    vincularConversa(falso);
    await ingerir(falso, { mensagemId: "m-2", texto: "de novo", aceite: undefined, contato: { nome: "Ana B" } });

    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG)).toEqual([]);
  });
});
