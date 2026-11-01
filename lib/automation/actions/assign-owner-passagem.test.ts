/**
 * #3514 — a passagem SDR → Closer na ação `assign_owner`.
 *
 * São DUAS perguntas, e elas não se misturam:
 *
 *   1. **A opção desligada não muda nada.** Uma automação que hoje move só o
 *      negócio não pode passar a mover o cliente e a conversa porque o schema
 *      ganhou duas chaves. O desfecho (`detail`) e as chamadas ao banco ficam
 *      idênticos aos de antes: nem carteira, nem conversa, nem consulta de
 *      contato.
 *   2. **A opção ligada passa o cliente** pela PORTA que já existe — a carteira
 *      por `fn_definir_carteira_do_cliente` (sem ator, origem `automacao`) e as
 *      conversas por `fn_passar_conversas_do_contato` (que chama
 *      `fn_conversation_assign` com reason `transfer`), nunca por UPDATE direto.
 *
 * O que este arquivo NÃO prova (e o `tests/invariants/carteira-da-automacao.test.ts`
 * prova): que o banco aceita o ator nulo com a origem `automacao` e segue
 * recusando o ator nulo com qualquer outra origem; QUAIS conversas passam (só as
 * abertas com outra pessoa); e a contagem, que é a das linhas que a atribuição
 * devolveu.
 */
import { describe, it, expect, vi } from "vitest";

import type { ActionCtx } from "@/lib/automation/types";
import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/assign-owner";

const NOVO_DONO = "11111111-1111-4111-8111-111111111111";
const CONTATO = "33333333-3333-4333-8333-333333333333";

interface RpcRegistrada {
  nome: string;
  args: Record<string, unknown>;
}

interface EstadoDoBanco {
  membro?: { user_id: string; role: string } | null;
  /** Quantas conversas a função diz ter passado (o que a atribuição devolveu). */
  movidas?: number;
  erroDaCarteira?: string;
  /** A função das conversas recusa (tudo ou nada). */
  erroDasConversas?: string;
  /** contato do negócio quando o contexto não o traz (fallback da consulta). */
  contatoDoNegocio?: string | null;
}

/**
 * Um banco pequeno o bastante para o que a ação faz: consulta de membro, UPDATE
 * do negócio e as duas RPCs. Ele REGISTRA tudo — é o registro que transforma
 * "não fez nada" em asserção, inclusive o `from()` de qualquer outra tabela.
 */
function bancoFalso(estado: EstadoDoBanco = {}) {
  const rpcs: RpcRegistrada[] = [];
  const atualizacoes: Array<{ tabela: string; valores: Record<string, unknown> }> = [];
  const outrasTabelas: string[] = [];

  const admin = {
    rpc: vi.fn(async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      if (nome === "fn_definir_carteira_do_cliente") {
        return estado.erroDaCarteira
          ? { data: null, error: { message: estado.erroDaCarteira } }
          : { data: args.p_dono, error: null };
      }
      if (nome === "fn_passar_conversas_do_contato") {
        return estado.erroDasConversas
          ? { data: null, error: { message: estado.erroDasConversas } }
          : { data: estado.movidas ?? 0, error: null };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((tabela: string) => {
      if (tabela === "crm_leads") {
        return {
          update: (valores: Record<string, unknown>) => ({
            eq: () => ({
              eq: async () => {
                atualizacoes.push({ tabela, valores });
                return { error: null };
              },
            }),
          }),
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { contact_id: estado.contatoDoNegocio ?? null }, error: null }),
              }),
            }),
          }),
        };
      }
      if (tabela === "user_organizations") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({
                  maybeSingle: async () => ({ data: estado.membro ?? { user_id: NOVO_DONO, role: "agent" }, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      outrasTabelas.push(tabela);
      throw new Error(`a ação não deveria consultar ${tabela}`);
    }),
  };

  return { admin, rpcs, atualizacoes, outrasTabelas };
}

function ctx(
  admin: ReturnType<typeof bancoFalso>["admin"],
  negocio: { id: string; contact_id?: string | null } = { id: "lead-1", contact_id: CONTATO },
  contatoDoContexto = true,
): ActionCtx {
  return {
    admin: admin as unknown as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Passagem para o Closer",
    requestId: "evt-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "lead.stage_changed",
      entity_kind: "crm_lead",
      entity_id: negocio.id,
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context: contatoDoContexto ? { lead: negocio, contact: { id: CONTATO } } : { lead: negocio },
  };
}

const soONegocio = { user_id: NOVO_DONO };

describe("assign_owner — a passagem SDR → Closer (#3514)", () => {
  it("com as duas opções desligadas, faz EXATAMENTE o que fazia: só o negócio", async () => {
    const banco = bancoFalso();
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin), soONegocio);

    // O contrato antigo, byte a byte: nem chave nova no detalhe.
    expect(r).toEqual({ type: "assign_owner", status: "success", detail: { user_id: NOVO_DONO } });
    // Uma escrita, no negócio. Nenhuma RPC, nenhuma consulta de conversa.
    expect(banco.atualizacoes).toHaveLength(1);
    expect(banco.atualizacoes[0]?.tabela).toBe("crm_leads");
    expect(banco.rpcs).toEqual([]);
    expect(banco.outrasTabelas).toEqual([]);
  });

  it("a chave explícita `false` é o mesmo que ausente: ninguém liga a passagem por engano", async () => {
    const banco = bancoFalso();
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin), {
      ...soONegocio,
      contato: false,
      conversas: false,
    });
    expect(r.detail).toEqual({ user_id: NOVO_DONO });
    expect(banco.rpcs).toEqual([]);
  });

  it("com `contato` ligado, a carteira passa pela porta única, sem ator e com a origem do sistema", async () => {
    const banco = bancoFalso();
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin), { ...soONegocio, contato: true });

    expect(banco.rpcs).toEqual([
      {
        nome: "fn_definir_carteira_do_cliente",
        args: {
          p_org: "org-1",
          // Sem ator: a automação não tem sessão. A função só aceita isso com a
          // origem `automacao` — é o que o invariante do banco prova.
          p_actor: null,
          p_contact: CONTATO,
          p_dono: NOVO_DONO,
          p_origem: "automacao",
        },
      },
    ]);
    // Nada de UPDATE direto em contacts: a carteira tem UMA porta.
    expect(banco.atualizacoes.map((a) => a.tabela)).toEqual(["crm_leads"]);
    // As conversas não foram pedidas: nenhuma chamada além da carteira.
    expect(banco.outrasTabelas).toEqual([]);
    expect(r.status).toBe("success");
    expect(r.detail).toEqual({ user_id: NOVO_DONO, carteira: "ok" });
  });

  it("com `conversas` ligado, a passagem é UMA chamada à função do banco — e a contagem é a dela", async () => {
    const banco = bancoFalso({ movidas: 2 });
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin), { ...soONegocio, conversas: true });

    // Nada de ler conversas e chamar a atribuição uma a uma daqui: a leitura e a
    // troca precisam estar na MESMA transação, senão a conversa encerrada no
    // meio do caminho é reaberta.
    expect(banco.rpcs).toEqual([
      {
        nome: "fn_passar_conversas_do_contato",
        args: { p_org: "org-1", p_contact: CONTATO, p_dono: NOVO_DONO },
      },
    ]);
    expect(banco.outrasTabelas).toEqual([]);
    expect(banco.atualizacoes.map((a) => a.tabela)).toEqual(["crm_leads"]);
    expect(r.status).toBe("success");
    expect(r.detail).toEqual({ user_id: NOVO_DONO, conversas: { movidas: 2 } });
  });

  it("zero conversas passadas é sucesso com zero — não uma contagem inventada", async () => {
    const banco = bancoFalso({ movidas: 0 });
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin), { ...soONegocio, conversas: true });
    expect(r.status).toBe("success");
    expect(r.detail).toEqual({ user_id: NOVO_DONO, conversas: { movidas: 0 } });
  });

  it("as duas opções juntas: negócio, carteira e conversas, nesta ordem", async () => {
    const banco = bancoFalso({ movidas: 1 });
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin), {
      ...soONegocio,
      contato: true,
      conversas: true,
    });

    expect(banco.rpcs.map((c) => c.nome)).toEqual([
      "fn_definir_carteira_do_cliente",
      "fn_passar_conversas_do_contato",
    ]);
    expect(r).toEqual({
      type: "assign_owner",
      status: "success",
      detail: { user_id: NOVO_DONO, carteira: "ok", conversas: { movidas: 1 } },
    });
  });

  it("a carteira que falha não desfaz o negócio, mas a ação NÃO diz que deu tudo certo", async () => {
    const banco = bancoFalso({ erroDaCarteira: "carteira_dono_invalido" });
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin), { ...soONegocio, contato: true });

    expect(banco.atualizacoes).toHaveLength(1); // o negócio mudou de dono
    expect(r.status).toBe("failed");
    expect(r.error).toBe("carteira_nao_passou");
    expect(r.detail).toEqual({
      user_id: NOVO_DONO,
      carteira: "falhou",
      erro: "carteira_dono_invalido",
    });
  });

  it("a passagem das conversas que falha vira `conversas_nao_passaram`, com a mensagem no detalhe técnico", async () => {
    const banco = bancoFalso({ erroDasConversas: "assignee_not_eligible_member" });
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin), { ...soONegocio, conversas: true });

    expect(banco.atualizacoes).toHaveLength(1); // o negócio mudou de dono
    expect(r.status).toBe("failed");
    expect(r.error).toBe("conversas_nao_passaram");
    expect(r.detail).toEqual({
      user_id: NOVO_DONO,
      conversas: "falhou",
      erro: "assignee_not_eligible_member",
    });
  });

  it("quando as duas pernas falham, a carteira ocupa o detalhe e o código é o dela", async () => {
    const banco = bancoFalso({
      erroDasConversas: "assignee_not_eligible_member",
      erroDaCarteira: "carteira_dono_invalido",
    });
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin), {
      ...soONegocio,
      contato: true,
      conversas: true,
    });

    expect(r.error).toBe("carteira_nao_passou");
    expect(r.detail).toEqual({
      user_id: NOVO_DONO,
      carteira: "falhou",
      erro: "carteira_dono_invalido",
      conversas: "falhou",
    });
  });

  it("negócio sem contato: o dono muda e a passagem é declarada, sem inventar erro", async () => {
    const banco = bancoFalso();
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin, { id: "lead-1", contact_id: null }, false), {
      ...soONegocio,
      contato: true,
      conversas: true,
    });

    expect(banco.rpcs).toEqual([]);
    expect(r).toEqual({ type: "assign_owner", status: "success", detail: { user_id: NOVO_DONO, passagem: "sem_contato" } });
  });

  it("sem contato no contexto, o fallback lê o contato do NEGÓCIO", async () => {
    const banco = bancoFalso({ contatoDoNegocio: CONTATO });
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin, { id: "lead-1" }, false), {
      ...soONegocio,
      contato: true,
    });
    expect(banco.rpcs[0]?.args.p_contact).toBe(CONTATO);
    expect(r.detail).toEqual({ user_id: NOVO_DONO, carteira: "ok" });
  });

  it("no rodízio as duas caixas não existem: a ação segue andando a fila", async () => {
    const banco = bancoFalso();
    const r = await getAction("assign_owner")!.execute(
      ctx(banco.admin),
      { modo: "rodizio", fila: [{ user_id: NOVO_DONO, pausado: false }] },
    );
    expect(banco.rpcs.map((c) => c.nome)).toEqual(["fn_automation_rodizio_atribuir"]);
    expect(banco.outrasTabelas).toEqual([]);
    expect(r.status).toBe("failed"); // o dublê não devolve desfecho: `sem_rodizio`
  });
});
