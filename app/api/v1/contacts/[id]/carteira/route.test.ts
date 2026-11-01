import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";

/**
 * A PORTA DA CARTEIRA (#3026, herdada do #2591) — as DUAS pontas do gate.
 *
 * O bloco Carteira do painel do Inbox não tem regra própria de permissão: ele
 * chama a MESMA porta da ficha (`PATCH /api/v1/contacts/[id]/carteira`), e a
 * régua de escrita é a do servidor. Este arquivo mede o lado que a tela não
 * pode provar sozinha:
 *
 *   1. a rota COBRA `agent`+ de papel (o `requireRole` é a régua, não o
 *      `ROLE_RANK` da tela);
 *   2. com a autorização NEGADA, a rota devolve a própria recusa (403) e não
 *      toca no banco — nada de gravar antes de decidir;
 *   3. com `manager`, a gravação sai pela função do banco
 *      (`fn_definir_carteira_do_cliente`) — a mesma porta que a ficha usa, sem
 *      segunda regra;
 *   4. (#3746) com `agent`, a POSSE decide: o dono da conversa e o dono da
 *      carteira gravam (200); o Atendente que não é dono de nada leva 403 e
 *      NADA muda. `manager` continua passando — anti-regressão.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  contato: vi.fn(),
  /** As conversas do contato, lidas antes e depois da troca (#3732). */
  conversas: vi.fn(),
  /** A linha do tempo da conversa (`registrarTrocaDeComando`). */
  atividade: vi.fn(),
  /**
   * A leitura da régua de posse (#3746): a carteira do contato e o vínculo do
   * dono. Servidas por TABELA — a régua lê `contacts`, o #3732 lê
   * `conversations`, e o `qualificado` lê `user_organizations`.
   */
  contatoAdmin: vi.fn(),
  vinculo: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: mocks.rpc,
    from: (tabela: string) => {
      if (tabela === "contacts") return mocks.contatoAdmin();
      if (tabela === "user_organizations") return mocks.vinculo();
      return mocks.conversas();
    },
  }),
}));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: mocks.atividade,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => mocks.contato() }),
}));

import { GET, PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
const DONO = "22222222-2222-4222-8222-222222222222";
/** O Atendente que faz a pergunta do #3746: "posso mexer neste cliente?". */
const ATENDENTE = "33333333-3333-4333-8333-333333333333";
const OUTRO_ATENDENTE = "44444444-4444-4444-8444-444444444444";

/** A leitura do "antes" (audit) — encadeia os dois `.eq` como a rota escreve. */
function contatoAtual(carteira: string | null = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { id: CONTATO, carteira_user_id: carteira }, error: null }),
  };
  return chain;
}

/**
 * A leitura da CARTEIRA pela régua de posse (#3746). A rota lê o contato com a
 * sessão para o audit e de novo com o cliente admin para decidir a posse — este
 * dublê é o segundo, e é por ele que "o contato já está na carteira dele" passa.
 */
function contatoDoAdmin(carteira: string | null = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { carteira_user_id: carteira }, error: null }),
  };
  return chain;
}

/** O vínculo do dono (`donoQualificado`), que o GET usa para `qualificado`. */
function vinculoQueConta() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({
      data: { role: "agent", accepted_at: "2026-01-01T00:00:00Z", revoked_at: null },
      error: null,
    }),
  };
  return chain;
}

/**
 * A leitura das conversas do contato (#3732). A rota lê a foto ANTES da RPC e
 * outra DEPOIS, e compara — aqui a lista é uma fila: cada chamada consome a
 * próxima foto. Sem fila configurada, o contato não tem conversa nenhuma.
 */
function conversasFalsas(linhas: Array<Record<string, unknown>> = []) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
    Promise.resolve({ data: linhas, error: null }).then(ok, err);
  return chain;
}

function pedido(dono: string | null) {
  return new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/carteira`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dono_user_id: dono }),
  });
}

/** O GET da carteira — a leitura que alimenta o cartão da ficha (#2591/#3746). */
function leitura() {
  return new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/carteira`, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contato.mockReturnValue(contatoAtual());
  mocks.conversas.mockReturnValue(conversasFalsas());
  // Sem dono gravado, sem conversa atribuída a ninguém: a posse (#3746) só
  // existe para `manager`+ até o caso ligar o contrário.
  mocks.contatoAdmin.mockReturnValue(contatoDoAdmin());
  mocks.vinculo.mockReturnValue(vinculoQueConta());
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.auth.mockResolvedValue({
    ok: true,
    user: { id: DONO, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "manager" },
  });
});

describe("#3026 — a porta da carteira: quem não é agent+ não grava", () => {
  it("cobra a régua `agent`+ no servidor (não a da tela)", async () => {
    await PATCH(pedido(DONO), { params: Promise.resolve({ id: CONTATO }) });

    expect(mocks.auth).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "contacts" }));
  });

  it("com a autorização NEGADA devolve a recusa e não toca no banco", async () => {
    // É a recusa que o `requireRole` produz para um viewer/agent: 403 canônico.
    mocks.auth.mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Seu papel não permite esta ação.", 403),
    });

    const resposta = await PATCH(pedido(DONO), { params: Promise.resolve({ id: CONTATO }) });

    expect(resposta.status).toBe(403);
    expect(((await resposta.json()) as { error: { code: string } }).error.code).toBe("forbidden_role");
    // Nada de gravar antes de decidir: nem a RPC, nem a auditoria.
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("com `manager`, a gravação sai pela função do banco da carteira (mesma porta da ficha)", async () => {
    const resposta = await PATCH(pedido(DONO), { params: Promise.resolve({ id: CONTATO }) });

    expect(resposta.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fn_definir_carteira_do_cliente",
      expect.objectContaining({ p_org: ORG, p_actor: DONO, p_contact: CONTATO, p_dono: DONO }),
    );
  });
});

/**
 * #3732 — o número que a troca de carteira mudou entra na linha do tempo.
 *
 * A `fn_definir_carteira_do_cliente` passa as conversas abertas pela
 * `fn_conversation_assign`, e o número vai junto. A auditoria do contato conta a
 * troca de dono, não que o cliente passou a ser atendido por outro WhatsApp: quem
 * olha o histórico da conversa não sabia por que as respostas mudaram de número.
 */
describe("#3732 — a carteira registra o número que mudou", () => {
  it("⭐ a conversa que trocou de número ganha a linha \"Continua pelo número de {nome}\"", async () => {
    mocks.conversas
      .mockReturnValueOnce(
        conversasFalsas([{ id: "conv-1", channel_session_id: "numero-a", assigned_to_user_name: null }]),
      )
      .mockReturnValueOnce(
        conversasFalsas([
          { id: "conv-1", channel_session_id: "numero-b", assigned_to_user_name: "Bruno Vendedor" },
        ]),
      );

    const resposta = await PATCH(pedido(DONO), { params: Promise.resolve({ id: CONTATO }) });

    expect(resposta.status).toBe(200);
    expect(mocks.atividade).toHaveBeenCalledTimes(1);
    expect(mocks.atividade).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        contactId: CONTATO,
        tipo: "conversation_transferred",
        motivo: "Continua pelo número de Bruno Vendedor",
        payload: { numero_anterior: "numero-a", numero_novo: "numero-b" },
      }),
    );
  });

  it("CONTROLE: conversa que ficou no mesmo número não vira linha nenhuma", async () => {
    mocks.conversas
      .mockReturnValueOnce(
        conversasFalsas([{ id: "conv-1", channel_session_id: "numero-a", assigned_to_user_name: null }]),
      )
      .mockReturnValueOnce(
        conversasFalsas([{ id: "conv-1", channel_session_id: "numero-a", assigned_to_user_name: "Bruno Vendedor" }]),
      );

    await PATCH(pedido(DONO), { params: Promise.resolve({ id: CONTATO }) });

    expect(mocks.atividade).not.toHaveBeenCalled();
  });

  it("CONTROLE: tirar da carteira (dono nulo) não registra troca de número", async () => {
    await PATCH(pedido(null), { params: Promise.resolve({ id: CONTATO }) });

    expect(mocks.atividade).not.toHaveBeenCalled();
  });
});

/**
 * #3746 — O ATENDENTE MUDA A CARTEIRA DO CLIENTE QUE É DELE.
 *
 * A issue mediu duas funções do dia a dia travadas em `manager`+. A carteira é
 * uma delas, e a correção não é "baixar o piso e liberar geral": é liberar com
 * ESCOPO DE POSSE. Os casos abaixo são o escopo, um por um:
 *
 *   • `agent` dono da CONVERSA → 200, e a gravação sai pela função do banco;
 *   • `agent` com o CONTATO na carteira dele → 200;
 *   • `agent` que não é dono de nada → 403 `fora_da_posse` e NADA muda
 *     (nem RPC, nem audit, nem linha do tempo);
 *   • `manager` → 200, mesmo sem posse nenhuma (anti-regressão explícita).
 */
describe("#3746 — a carteira do cliente que o Atendente já atende", () => {
  /** Uma sessão de Atendente, que é o caso novo da issue. */
  function comoAtendente() {
    mocks.auth.mockResolvedValue({
      ok: true,
      user: { id: ATENDENTE, idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role: "agent" },
    });
  }

  it("⭐ `agent` dono da CONVERSA grava: 200 e a função do banco é chamada com ele", async () => {
    comoAtendente();
    mocks.conversas.mockReturnValue(
      conversasFalsas([
        {
          id: "conv-1",
          channel_session_id: "numero-a",
          assigned_to_user_name: null,
          assigned_to_user_id: ATENDENTE,
        },
      ]),
    );

    const resposta = await PATCH(pedido(ATENDENTE), { params: Promise.resolve({ id: CONTATO }) });

    expect(resposta.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fn_definir_carteira_do_cliente",
      expect.objectContaining({ p_org: ORG, p_actor: ATENDENTE, p_contact: CONTATO, p_dono: ATENDENTE }),
    );
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("`agent` com o CONTATO já na carteira dele grava (a posse não vem só da conversa)", async () => {
    comoAtendente();
    mocks.contatoAdmin.mockReturnValue(contatoDoAdmin(ATENDENTE));

    const resposta = await PATCH(pedido(null), { params: Promise.resolve({ id: CONTATO }) });

    expect(resposta.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("⭐ `agent` que NÃO é dono leva 403 `fora_da_posse` e nada muda", async () => {
    comoAtendente();
    // A conversa é de OUTRA pessoa e o contato está na carteira de outro.
    mocks.conversas.mockReturnValue(
      conversasFalsas([
        {
          id: "conv-1",
          channel_session_id: "numero-a",
          assigned_to_user_name: null,
          assigned_to_user_id: OUTRO_ATENDENTE,
        },
      ]),
    );
    mocks.contatoAdmin.mockReturnValue(contatoDoAdmin(OUTRO_ATENDENTE));

    const resposta = await PATCH(pedido(ATENDENTE), { params: Promise.resolve({ id: CONTATO }) });

    expect(resposta.status).toBe(403);
    expect(((await resposta.json()) as { error: { code: string } }).error.code).toBe("fora_da_posse");
    // Nada de gravar antes de decidir — e nada de linha do tempo de uma troca
    // que não aconteceu.
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.atividade).not.toHaveBeenCalled();
  });

  it("CONTROLE: `manager` continua gravando sem posse nenhuma (anti-regressão)", async () => {
    // O `beforeEach` já monta a sessão de `manager`, e a posse está vazia.
    const resposta = await PATCH(pedido(DONO), { params: Promise.resolve({ id: CONTATO }) });

    expect(resposta.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});

/**
 * #3746 — O GET DIZ SE A TELA PODE OFERECER O SELETOR.
 *
 * A tela não compara papel (#3746, requisito 2): ela lê `pode_alterar`, que o
 * servidor responde com a MESMA régua do PATCH. Estes casos prendem as duas
 * respostas que importam — e o `true` do Atendente dono é o que faz o seletor
 * aparecer para ele.
 */
describe("#3746 — o cartão sabe se pode mudar (#pode_alterar)", () => {
  it("`agent` dono do cliente recebe `pode_alterar: true`", async () => {
    mocks.auth.mockResolvedValue({
      ok: true,
      user: { id: ATENDENTE, idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role: "agent" },
    });
    mocks.contato.mockReturnValue(contatoAtual(ATENDENTE));
    mocks.conversas.mockReturnValue(
      conversasFalsas([{ id: "conv-1", assigned_to_user_id: ATENDENTE }]),
    );

    const resposta = await GET(leitura(), { params: Promise.resolve({ id: CONTATO }) });

    expect(resposta.status).toBe(200);
    expect((await resposta.json()) as { data: { pode_alterar: boolean } }).toMatchObject({
      data: { pode_alterar: true },
    });
  });

  it("`agent` de fora do cliente recebe `pode_alterar: false` (o seletor não aparece)", async () => {
    mocks.auth.mockResolvedValue({
      ok: true,
      user: { id: ATENDENTE, idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role: "agent" },
    });
    mocks.contatoAdmin.mockReturnValue(contatoDoAdmin(OUTRO_ATENDENTE));

    const resposta = await GET(leitura(), { params: Promise.resolve({ id: CONTATO }) });

    expect((await resposta.json()) as { data: { pode_alterar: boolean } }).toMatchObject({
      data: { pode_alterar: false },
    });
  });

  it("CONTROLE: `manager` recebe `pode_alterar: true` sem dono e sem conversa", async () => {
    const resposta = await GET(leitura(), { params: Promise.resolve({ id: CONTATO }) });

    expect((await resposta.json()) as { data: { pode_alterar: boolean } }).toMatchObject({
      data: { pode_alterar: true },
    });
  });
});
