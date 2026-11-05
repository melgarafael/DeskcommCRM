// @vitest-environment node
/**
 * O validador de ids das ações de uma regra de automação (Spec 33, R1).
 *
 * Roda contra o cliente admin falso de duas organizações: uma consulta sem o filtro de
 * `organization_id` não alcança linha nenhuma, então "id da A aceito" prova que o filtro está lá, e
 * "id da B recusado" prova que ele faz diferença.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { validarIdsDasAcoes, validarIdsDoGatilho } from "@/lib/automation/validar-ids-das-acoes";

import { cadeiasForaDaOrganizacao, criarClienteAdminFalso } from "./helpers/cliente-admin-falso";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const FUNIL_A = "a1000000-0000-4000-8000-000000000001";
const FUNIL_B = "b1000000-0000-4000-8000-000000000001";
const ETAPA_A = "a2000000-0000-4000-8000-000000000001";
const ETAPA_B = "b2000000-0000-4000-8000-000000000001";
const CANAL_A = "a3000000-0000-4000-8000-000000000001";
const CANAL_B = "b3000000-0000-4000-8000-000000000001";
const AGENTE_A = "a4000000-0000-4000-8000-000000000001";
const AGENTE_B = "b4000000-0000-4000-8000-000000000001";
const FLUXO_A = "a5000000-0000-4000-8000-000000000001";
const PESSOA_A = "a6000000-0000-4000-8000-000000000001";
const PESSOA_A2 = "a6000000-0000-4000-8000-000000000002";
const PESSOA_B = "b6000000-0000-4000-8000-000000000001";
const PESSOA_REVOGADA_A = "a6000000-0000-4000-8000-000000000009";
const FONTE_A = "a7000000-0000-4000-8000-000000000001";
const FONTE_B = "b7000000-0000-4000-8000-000000000001";

const LINHAS = {
  crm_pipelines: [
    { id: FUNIL_A, organization_id: ORG_A },
    { id: FUNIL_B, organization_id: ORG_B },
  ],
  crm_stages: [
    { id: ETAPA_A, organization_id: ORG_A },
    { id: ETAPA_B, organization_id: ORG_B },
  ],
  channel_sessions: [
    { id: CANAL_A, organization_id: ORG_A },
    { id: CANAL_B, organization_id: ORG_B },
  ],
  ai_agents: [
    { id: AGENTE_A, organization_id: ORG_A },
    { id: AGENTE_B, organization_id: ORG_B },
  ],
  followup_flow_pointers: [{ id: FLUXO_A, organization_id: ORG_A }],
  user_organizations: [
    { user_id: PESSOA_A, organization_id: ORG_A, revoked_at: null },
    { user_id: PESSOA_A2, organization_id: ORG_A, revoked_at: null },
    { user_id: PESSOA_REVOGADA_A, organization_id: ORG_A, revoked_at: "2026-10-01T00:00:00Z" },
    { user_id: PESSOA_B, organization_id: ORG_B, revoked_at: null },
  ],
  webhook_sources: [
    { id: FONTE_A, organization_id: ORG_A },
    { id: FONTE_B, organization_id: ORG_B },
  ],
  organizations: [
    { id: ORG_A, settings: { task_plans: [{ id: "plano-a" }] } },
    { id: ORG_B, settings: { task_plans: [{ id: "plano-b" }] } },
  ],
};

function falso() {
  return criarClienteAdminFalso({ orgDona: ORG_A, linhas: LINHAS });
}

async function validar(org: string, acoes: unknown) {
  const f = falso();
  const r = await validarIdsDasAcoes(f.cliente as SupabaseClient, org, acoes);
  // Toda consulta, aceita ou recusada, ficou dentro da organização perguntada.
  expect(cadeiasForaDaOrganizacao(f.cadeias, org)).toEqual([]);
  return r;
}

const mover = (pipeline: string, etapa: string) => ({
  type: "create_or_move_lead",
  config: { pipeline_id: pipeline, stage_id: etapa },
});

describe("validarIdsDasAcoes", () => {
  it("ids da organização A, perguntando como A → aceito", async () => {
    expect(await validar(ORG_A, [mover(FUNIL_A, ETAPA_A)])).toEqual({ ok: true });
  });

  it("ids da organização A, perguntando como B → recusado, com o campo", async () => {
    expect(await validar(ORG_B, [mover(FUNIL_A, ETAPA_A)])).toEqual({
      ok: false,
      campo: "acoes[0].config.pipeline_id",
    });
  });

  it("um id de B no meio de ids de A recusa a regra inteira", async () => {
    expect(await validar(ORG_A, [mover(FUNIL_A, ETAPA_B)])).toEqual({
      ok: false,
      campo: "acoes[0].config.stage_id",
    });
  });

  it("id que não existe em lugar nenhum → recusado", async () => {
    expect(await validar(ORG_A, [mover(FUNIL_A, "a2000000-0000-4000-8000-0000000000ff")])).toMatchObject({
      ok: false,
    });
  });

  it("canal, agente e fluxo: A aceito, B recusado", async () => {
    const acoes = (canal: string, agente: string) => [
      { type: "send_whatsapp_message", config: { channel_session_id: canal, template: "Oi" } },
      { type: "send_ai_message", config: { agent_id: agente, channel_session_id: canal, instruction: "x" } },
      { type: "start_message_flow", config: { flow_pointer_id: FLUXO_A } },
    ];
    expect(await validar(ORG_A, acoes(CANAL_A, AGENTE_A))).toEqual({ ok: true });
    expect(await validar(ORG_A, acoes(CANAL_B, AGENTE_A))).toEqual({
      ok: false,
      campo: "acoes[0].config.channel_session_id",
    });
    expect(await validar(ORG_A, acoes(CANAL_A, AGENTE_B))).toEqual({
      ok: false,
      campo: "acoes[1].config.agent_id",
    });
    expect(await validar(ORG_B, [{ type: "start_message_flow", config: { flow_pointer_id: FLUXO_A } }])).toMatchObject({
      ok: false,
    });
  });

  it("pessoas: user_id fixo, fila do rodízio, fallback, destinatário de e-mail e tarefa", async () => {
    const acoes = (fila: string, fallback: string) => [
      { type: "assign_owner", config: { modo: "fixo", user_id: PESSOA_A } },
      { type: "assign_owner", config: { modo: "rodizio", fila: [{ user_id: PESSOA_A, pausado: false }, { user_id: fila, pausado: false }] } },
      {
        type: "assign_owner",
        config: { modo: "destino", destinos: ["responsavel_do_negocio"], fallback: { modo: "fixo", user_id: fallback } },
      },
      { type: "send_email", config: { destinatario: "membro_da_equipe", membro_id: PESSOA_A, assunto: "a", corpo: "b" } },
      { type: "create_task", config: { titulo: "t", vence_em_dias: 1, atribuir_a: { usuario_id: PESSOA_A }, prioridade: "low" } },
    ];
    expect(await validar(ORG_A, acoes(PESSOA_A2, PESSOA_A))).toEqual({ ok: true });
    expect(await validar(ORG_A, acoes(PESSOA_B, PESSOA_A))).toEqual({
      ok: false,
      campo: "acoes[1].config.fila[1].user_id",
    });
    expect(await validar(ORG_A, acoes(PESSOA_A2, PESSOA_B))).toEqual({
      ok: false,
      campo: "acoes[2].config.fallback.user_id",
    });
  });

  it("pessoa que saiu da organização (vínculo revogado) → recusada", async () => {
    expect(
      await validar(ORG_A, [{ type: "assign_owner", config: { modo: "fixo", user_id: PESSOA_REVOGADA_A } }]),
    ).toMatchObject({ ok: false });
  });

  it("fila dentro do fallback do destino dinâmico: pessoa de B → recusada", async () => {
    expect(
      await validar(ORG_A, [
        {
          type: "assign_owner",
          config: {
            modo: "destino",
            destinos: ["dono_da_carteira"],
            fallback: { modo: "rodizio", fila: [{ user_id: PESSOA_B, pausado: false }] },
          },
        },
      ]),
    ).toEqual({ ok: false, campo: "acoes[0].config.fallback.fila[0].user_id" });
  });

  it("plano de tarefas: o da própria organização aceito, o da outra recusado", async () => {
    const acao = [{ type: "apply_task_plan", config: { plano_id: "plano-a" } }];
    expect(await validar(ORG_A, acao)).toEqual({ ok: true });
    expect(await validar(ORG_B, acao)).toEqual({ ok: false, campo: "acoes[0].config.plano_id" });
  });

  it("ação aninhada em ai_decide: id da B recusado, com o caminho da opção", async () => {
    const decide = (canal: string) => [
      {
        type: "ai_decide",
        config: {
          custo_de_token: true,
          instrucao: "x",
          opcoes: [
            { id: "a", rotulo: "A", acao: { type: "notify_team", config: { canal: "whatsapp" } } },
            { id: "b", rotulo: "B", acao: { type: "send_whatsapp_message", config: { channel_session_id: canal, template: "Oi" } } },
          ],
        },
      },
    ];
    expect(await validar(ORG_A, decide(CANAL_A))).toEqual({ ok: true });
    expect(await validar(ORG_A, decide(CANAL_B))).toEqual({
      ok: false,
      campo: "acoes[0].config.opcoes[1].acao.config.channel_session_id",
    });
  });

  it("FALHA FECHADA: campo terminado em _id que o tipo não declara é recusado, nunca ignorado", async () => {
    expect(await validar(ORG_A, [{ type: "add_tag", config: { tags: ["x"], conta_id: FUNIL_A } }])).toEqual({
      ok: false,
      campo: "acoes[0].config.conta_id",
    });
    // `stage_id` existe em outro tipo, mas não neste: o mapa é por tipo.
    expect(
      await validar(ORG_A, [{ type: "send_whatsapp_message", config: { channel_session_id: CANAL_A, template: "x", stage_id: ETAPA_A } }]),
    ).toEqual({ ok: false, campo: "acoes[0].config.stage_id" });
    // `_ids` (lista) também.
    expect(await validar(ORG_A, [{ type: "add_tag", config: { tags: ["x"], pessoas_ids: [PESSOA_A] } }])).toMatchObject({
      ok: false,
    });
    // `user_id` solto em lugar não declarado (fora da fila).
    expect(
      await validar(ORG_A, [{ type: "create_task", config: { titulo: "t", vence_em_dias: 1, atribuir_a: "dono_do_lead", user_id: PESSOA_A, prioridade: "low" } }]),
    ).toMatchObject({ ok: false });
    // Chave `_id` na própria ação, fora de `config`.
    expect(await validar(ORG_A, [{ type: "add_tag", config: { tags: ["x"] }, agent_id: AGENTE_A }])).toMatchObject({
      ok: false,
    });
  });

  it("FALHA FECHADA: campo desconhecido dentro de uma opção do ai_decide e tipo desconhecido", async () => {
    const opcao = {
      id: "a",
      rotulo: "A",
      funil_id: FUNIL_A,
      acao: { type: "notify_team", config: { canal: "whatsapp" } },
    };
    expect(
      await validar(ORG_A, [{ type: "ai_decide", config: { custo_de_token: true, instrucao: "x", opcoes: [opcao, opcao] } }]),
    ).toEqual({ ok: false, campo: "acoes[0].config.opcoes[0].funil_id" });
    expect(await validar(ORG_A, [{ type: "acao_que_nao_existe", config: {} }])).toEqual({
      ok: false,
      campo: "acoes[0].type",
    });
  });

  it("ai_decide dentro de ai_decide além do limite é recusado", async () => {
    const dentro = (n: number): unknown =>
      n === 0
        ? { type: "notify_team", config: { canal: "whatsapp" } }
        : { type: "ai_decide", config: { custo_de_token: true, instrucao: "x", opcoes: [{ id: "a", rotulo: "A", acao: dentro(n - 1) }] } };
    expect(await validar(ORG_A, [dentro(6)])).toMatchObject({ ok: false });
  });

  it("entrada que não é lista, e id que não é texto, são recusados", async () => {
    expect(await validar(ORG_A, "nada")).toEqual({ ok: false, campo: "acoes" });
    expect(await validar(ORG_A, [{ type: "create_or_move_lead", config: { pipeline_id: 7, stage_id: ETAPA_A } }])).toMatchObject({
      ok: false,
    });
  });

  it("sem ids nas ações (só texto e etiquetas) não consulta o banco", async () => {
    const f = falso();
    const r = await validarIdsDasAcoes(f.cliente as SupabaseClient, ORG_A, [
      { type: "add_tag", config: { tags: ["x"] } },
      { type: "notify_team", config: { canal: "whatsapp" } },
    ]);
    expect(r).toEqual({ ok: true });
    expect(f.cadeias).toEqual([]);
  });
});

describe("validarIdsDoGatilho", () => {
  async function gatilho(org: string, config: unknown) {
    const f = falso();
    const r = await validarIdsDoGatilho(f.cliente as SupabaseClient, org, config);
    expect(cadeiasForaDaOrganizacao(f.cadeias, org)).toEqual([]);
    return r;
  }

  it("ausente e vazio passam", async () => {
    expect(await gatilho(ORG_A, undefined)).toEqual({ ok: true });
    expect(await gatilho(ORG_A, {})).toEqual({ ok: true });
  });

  it("funil, etapa e fonte: A aceito, B recusado", async () => {
    const cfg = { pipeline_id: FUNIL_A, stage_id: ETAPA_A, webhook_source_id: FONTE_A, dias: 3 };
    expect(await gatilho(ORG_A, cfg)).toEqual({ ok: true });
    expect(await gatilho(ORG_B, cfg)).toMatchObject({ ok: false });
    expect(await gatilho(ORG_A, { ...cfg, webhook_source_id: FONTE_B })).toEqual({
      ok: false,
      campo: "trigger_config.webhook_source_id",
    });
  });

  it("FALHA FECHADA: chave _id desconhecida no gatilho é recusada", async () => {
    expect(await gatilho(ORG_A, { dias: 3, conta_id: FUNIL_A })).toEqual({
      ok: false,
      campo: "trigger_config.conta_id",
    });
  });
});
