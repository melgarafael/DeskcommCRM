/**
 * #3804 — a ação `assign_owner` entregando a quem NÃO está escrito na regra:
 * "responsável do negócio" e "dono da carteira do contato", com fallback.
 *
 * O que este arquivo prova:
 *
 *   1. o executor USA a resolução pura (`lib/automation/destino-do-atribuir`)
 *      — o negócio muda de dono para a pessoa resolvida, e o detalhe diz qual
 *      elo da cadeia decidiu;
 *   2. a pessoa resolvida passa pela MESMA régua de elegibilidade do modo fixo
 *      (membro ativo, não `viewer`): quem não pode receber é recusado e a
 *      cadeia segue — nunca "atribui para o id que estava no card";
 *   3. as opções da #3514 (`contato`, `conversas`) valem para os destinos novos,
 *      pelas mesmas portas do banco;
 *   4. quando não há ninguém qualificado, o fallback configurado decide — pessoa
 *      fixa ou rodízio (o mesmo `fn_automation_rodizio_atribuir` do #2041) — e o
 *      desfecho fica na Atividade com o motivo. Regra que não atribui e segue em
 *      silêncio é o defeito que a issue pede para não existir.
 */
import { describe, expect, it, vi } from "vitest";

import type { ActionCtx } from "@/lib/automation/types";
import { getAction } from "@/lib/automation/actions";
import { createAutomationRuleSchema } from "@/lib/schemas/webhooks";
import { traduzir } from "@/lib/i18n/dicionario";
import "@/lib/automation/actions/assign-owner";

const RESPONSAVEL = "11111111-1111-4111-8111-111111111111";
const CARTEIRA = "22222222-2222-4222-8222-222222222222";
const FALLBACK = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";

const DESTINOS = ["responsavel_do_negocio", "dono_da_carteira"] as const;

const DESTINO_COM_FIXO = {
  modo: "destino",
  destinos: [...DESTINOS],
  fallback: { modo: "fixo", user_id: FALLBACK },
};

interface EstadoDoBanco {
  /** Quem é membro ativo; quem não está no mapa é recusado (`user_not_in_org`). */
  membros?: Record<string, { user_id: string; role: string } | null>;
  /** O que `fn_automation_rodizio_atribuir` devolve. */
  rodizio?: { user_id: string; posicao: number } | { motivo: string };
  movidas?: number;
  erroDaConsultaDeMembro?: string;
}

function membrosPadrao(): Record<string, { user_id: string; role: string }> {
  return {
    [RESPONSAVEL]: { user_id: RESPONSAVEL, role: "agent" },
    [CARTEIRA]: { user_id: CARTEIRA, role: "agent" },
    [FALLBACK]: { user_id: FALLBACK, role: "agent" },
  };
}

/**
 * O banco mínimo desta ação: consulta de membro (UM usuário por chamada, como a
 * ação faz), UPDATE do negócio e as três RPCs. Tudo é registrado — é o registro
 * que transforma "não fez nada" em asserção.
 */
function bancoFalso(estado: EstadoDoBanco = {}) {
  const membros = estado.membros ?? membrosPadrao();
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const atualizacoes: Array<{ tabela: string; valores: Record<string, unknown> }> = [];
  const consultasDeMembro: string[] = [];

  const admin = {
    rpc: vi.fn(async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      if (nome === "fn_definir_carteira_do_cliente") return { data: args.p_dono, error: null };
      if (nome === "fn_passar_conversas_do_contato") return { data: estado.movidas ?? 0, error: null };
      if (nome === "fn_automation_rodizio_atribuir") {
        return { data: estado.rodizio ?? { user_id: FALLBACK, posicao: 1 }, error: null };
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
                maybeSingle: async () => ({ data: { contact_id: CONTATO }, error: null }),
              }),
            }),
          }),
        };
      }
      if (tabela === "user_organizations") {
        return {
          select: () => ({
            eq: () => ({
              eq: (_coluna: string, valor: string) => {
                consultasDeMembro.push(valor);
                return {
                  is: () => ({
                    maybeSingle: async () =>
                      estado.erroDaConsultaDeMembro
                        ? { data: null, error: { message: estado.erroDaConsultaDeMembro } }
                        : { data: membros[valor] ?? null, error: null },
                  }),
                };
              },
            }),
          }),
        };
      }
      throw new Error(`a ação não deveria consultar ${tabela}`);
    }),
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { id, user_metadata: { full_name: `Pessoa ${id.slice(0, 4)}` } } },
        }),
      },
    },
  };

  return { admin, rpcs, atualizacoes, consultasDeMembro };
}

function ctx(
  admin: ReturnType<typeof bancoFalso>["admin"],
  negocio: { id: string; owner_user_id: string | null; owner_kind?: string | null; contact_id?: string | null },
  contato: { id: string; carteira_user_id: string | null } | null = { id: CONTATO, carteira_user_id: CARTEIRA },
): ActionCtx {
  return {
    admin: admin as unknown as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Pós-venda do vendedor",
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
    context: contato ? { lead: negocio, contact: contato } : { lead: negocio },
  };
}

const NEGOCIO_COM_RESPONSAVEL = { id: "lead-1", owner_user_id: RESPONSAVEL, owner_kind: "user" };
const NEGOCIO_SEM_RESPONSAVEL = { id: "lead-1", owner_user_id: null, owner_kind: null };

describe("assign_owner — destino dinâmico (#3804)", () => {
  it("entrega ao RESPONSÁVEL DO NEGÓCIO e diz que foi ele quem decidiu", async () => {
    const banco = bancoFalso();
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin, NEGOCIO_COM_RESPONSAVEL), DESTINO_COM_FIXO);

    expect(banco.atualizacoes).toHaveLength(1);
    expect(banco.atualizacoes[0]?.valores.owner_user_id).toBe(RESPONSAVEL);
    expect(r).toMatchObject({
      type: "assign_owner",
      status: "success",
      detail: { user_id: RESPONSAVEL, destino: "responsavel_do_negocio" },
    });
    // O fallback não foi tocado: nenhuma RPC, nenhuma passagem sem pedido.
    expect(banco.rpcs).toEqual([]);
  });

  it("sem responsável no card, entrega ao DONO DA CARTEIRA DO CONTATO", async () => {
    const banco = bancoFalso();
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin, NEGOCIO_SEM_RESPONSAVEL), DESTINO_COM_FIXO);

    expect(banco.atualizacoes[0]?.valores.owner_user_id).toBe(CARTEIRA);
    expect(r.detail).toMatchObject({ user_id: CARTEIRA, destino: "dono_da_carteira" });
    // A cadeia registrada: o primeiro elo foi tentado e não havia ninguém.
    expect(r.detail?.descartes).toEqual([{ elo: "responsavel_do_negocio", motivo: "ausente" }]);
  });

  it("responsável que NÃO é membro ativo é recusado pela régua da ação, e a cadeia segue", async () => {
    const banco = bancoFalso({
      membros: {
        // O dono do card saiu da equipe.
        [RESPONSAVEL]: null,
        [CARTEIRA]: { user_id: CARTEIRA, role: "agent" },
        [FALLBACK]: { user_id: FALLBACK, role: "agent" },
      },
    });
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin, NEGOCIO_COM_RESPONSAVEL), DESTINO_COM_FIXO);

    expect(banco.consultasDeMembro).toEqual([RESPONSAVEL, CARTEIRA]);
    expect(banco.atualizacoes[0]?.valores.owner_user_id).toBe(CARTEIRA);
    expect(r.detail).toMatchObject({ user_id: CARTEIRA, destino: "dono_da_carteira" });
    expect(r.detail?.descartes).toEqual([{ elo: "responsavel_do_negocio", motivo: "recusado" }]);
  });

  it("`viewer` não recebe: a mesma régua do modo fixo vale para o destino resolvido", async () => {
    const banco = bancoFalso({
      membros: {
        [RESPONSAVEL]: { user_id: RESPONSAVEL, role: "viewer" },
        [CARTEIRA]: { user_id: CARTEIRA, role: "agent" },
        [FALLBACK]: { user_id: FALLBACK, role: "agent" },
      },
    });
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin, NEGOCIO_COM_RESPONSAVEL), DESTINO_COM_FIXO);

    expect(r.detail).toMatchObject({ user_id: CARTEIRA, destino: "dono_da_carteira" });
  });

  it("sem responsável e sem carteira, o FALLBACK DE PESSOA FIXA recebe", async () => {
    const banco = bancoFalso();
    const r = await getAction("assign_owner")!.execute(
      ctx(banco.admin, NEGOCIO_SEM_RESPONSAVEL, { id: CONTATO, carteira_user_id: null }),
      DESTINO_COM_FIXO,
    );

    expect(banco.atualizacoes[0]?.valores.owner_user_id).toBe(FALLBACK);
    expect(r.detail).toMatchObject({ user_id: FALLBACK, destino: "fallback_fixo" });
  });

  it("com o fallback em RODÍZIO, quem escolhe é a função do rodízio — e a passagem vale para quem ela escolheu", async () => {
    const banco = bancoFalso({ rodizio: { user_id: FALLBACK, posicao: 2 }, movidas: 3 });
    const r = await getAction("assign_owner")!.execute(
      ctx(banco.admin, NEGOCIO_SEM_RESPONSAVEL, { id: CONTATO, carteira_user_id: null }),
      {
        modo: "destino",
        destinos: [...DESTINOS],
        fallback: { modo: "rodizio", fila: [{ user_id: FALLBACK, pausado: false }] },
        contato: true,
        conversas: true,
      },
    );

    // O rodízio é a MESMA porta do #2041, com a regra e o evento do contexto.
    expect(banco.rpcs.map((c) => c.nome)).toEqual([
      "fn_automation_rodizio_atribuir",
      "fn_definir_carteira_do_cliente",
      "fn_passar_conversas_do_contato",
    ]);
    expect(banco.rpcs[0]?.args).toEqual({ p_org: "org-1", p_rule: "rule-1", p_lead: "lead-1", p_event: "evt-1" });
    // O dono do negócio foi gravado pela função do banco, não por um UPDATE daqui.
    expect(banco.atualizacoes).toEqual([]);
    expect(r.status).toBe("success");
    expect(r.detail).toMatchObject({
      user_id: FALLBACK,
      posicao: 2,
      destino: "fallback_rodizio",
      carteira: "ok",
      conversas: { movidas: 3 },
    });
  });

  it("o rodízio do fallback sem ninguém disponível NÃO vira sucesso: o motivo do banco aparece", async () => {
    const banco = bancoFalso({ rodizio: { motivo: "ninguem_disponivel" } });
    const r = await getAction("assign_owner")!.execute(
      ctx(banco.admin, NEGOCIO_SEM_RESPONSAVEL, { id: CONTATO, carteira_user_id: null }),
      { ...DESTINO_COM_FIXO, fallback: { modo: "rodizio", fila: [{ user_id: FALLBACK, pausado: true }] } },
    );

    expect(r.status).toBe("skipped");
    expect(r.detail).toEqual({ reason: "ninguem_disponivel" });
  });

  it("as opções da #3514 usam as MESMAS portas, com a pessoa que a cadeia resolveu", async () => {
    const banco = bancoFalso({ movidas: 1 });
    const r = await getAction("assign_owner")!.execute(
      ctx(banco.admin, NEGOCIO_COM_RESPONSAVEL),
      { ...DESTINO_COM_FIXO, contato: true, conversas: true },
    );

    expect(banco.rpcs).toEqual([
      {
        nome: "fn_definir_carteira_do_cliente",
        args: { p_org: "org-1", p_actor: null, p_contact: CONTATO, p_dono: RESPONSAVEL, p_origem: "automacao" },
      },
      {
        nome: "fn_passar_conversas_do_contato",
        args: { p_org: "org-1", p_contact: CONTATO, p_dono: RESPONSAVEL },
      },
    ]);
    expect(r.detail).toMatchObject({
      user_id: RESPONSAVEL,
      destino: "responsavel_do_negocio",
      carteira: "ok",
      conversas: { movidas: 1 },
    });
  });

  it("ninguém qualificado e fallback também inválido: FALHA com o motivo, não sucesso calado", async () => {
    const banco = bancoFalso({ membros: {} });
    const r = await getAction("assign_owner")!.execute(
      ctx(banco.admin, NEGOCIO_SEM_RESPONSAVEL, { id: CONTATO, carteira_user_id: null }),
      DESTINO_COM_FIXO,
    );

    expect(banco.atualizacoes).toEqual([]);
    expect(r.status).toBe("failed");
    expect(r.error).toBe("sem_destino");
    // A frase gravada é a que a Atividade traduz: chave do dicionário, com
    // espanhol. Uma variante dela ficava em português na tela em espanhol.
    const explicacao = String(r.detail?.explicacao);
    expect(traduzir(explicacao, "es")).toMatch(/^Nadie pudo recibir este negocio/);
    // O registro do que foi tentado: fica no detalhe para o suporte.
    expect(r.detail?.descartes).toEqual([
      { elo: "responsavel_do_negocio", motivo: "ausente" },
      { elo: "dono_da_carteira", motivo: "ausente" },
      { elo: "fallback_fixo", motivo: "recusado" },
    ]);
  });

  it("a consulta de membro indisponível continua sendo `membro_indeterminado`, não `sem_destino`", async () => {
    const banco = bancoFalso({ erroDaConsultaDeMembro: "timeout" });
    const r = await getAction("assign_owner")!.execute(ctx(banco.admin, NEGOCIO_COM_RESPONSAVEL), DESTINO_COM_FIXO);

    expect(r.status).toBe("failed");
    expect(r.error).toBe("membro_indeterminado");
  });
});

describe("a configuração do destino dinâmico na porta da API", () => {
  const regra = (config: Record<string, unknown>) => ({
    name: "Pós-venda do vendedor",
    trigger_event: "lead.stage_changed",
    conditions: [],
    actions: [{ type: "assign_owner", config }],
    trigger_config: {},
  });

  it("aceita o modo `destino` com os dois destinos e o fallback", () => {
    const r = createAutomationRuleSchema.safeParse(regra(DESTINO_COM_FIXO));
    expect(r.success).toBe(true);
  });

  it("recusa a regra sem fallback: a ação não pode ficar sem destino nenhum", () => {
    const r = createAutomationRuleSchema.safeParse(regra({ modo: "destino", destinos: [...DESTINOS] }));
    expect(r.success).toBe(false);
  });

  it("recusa destino repetido e lista vazia", () => {
    expect(
      createAutomationRuleSchema.safeParse(
        regra({
          modo: "destino",
          destinos: ["dono_da_carteira", "dono_da_carteira"],
          fallback: { modo: "fixo", user_id: FALLBACK },
        }),
      ).success,
    ).toBe(false);
    expect(
      createAutomationRuleSchema.safeParse(
        regra({ modo: "destino", destinos: [], fallback: { modo: "fixo", user_id: FALLBACK } }),
      ).success,
    ).toBe(false);
  });

  it("o rodízio do fallback conta no teto de UM rodízio por regra", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "Dois rodízios",
      trigger_event: "lead.stage_changed",
      conditions: [],
      actions: [
        { type: "assign_owner", config: { modo: "rodizio", fila: [{ user_id: FALLBACK, pausado: false }] } },
        {
          type: "assign_owner",
          config: {
            modo: "destino",
            destinos: [...DESTINOS],
            fallback: { modo: "rodizio", fila: [{ user_id: CARTEIRA, pausado: false }] },
          },
        },
      ],
      trigger_config: {},
    });
    expect(r.success).toBe(false);
  });
});
