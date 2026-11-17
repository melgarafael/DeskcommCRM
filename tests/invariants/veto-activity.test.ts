import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emitVetoActivity, vetoReason } from "@/lib/leads/veto-activity";

/**
 * Wave 3 (CORE 2), cenário 11 — o agente decidir NÃO falar é evento.
 *
 * Contra Postgres real porque as duas metades que importam são do banco: a
 * constraint de lastro (atividade de IA precisa de trace_id) e o roteamento do
 * contato para UM negócio — com o event_log recebendo o caso ambíguo em vez de
 * o card errado receber a atividade.
 */

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "0072aaaa-0000-4000-8000-000000000001";
const PIPE = "0072aaaa-3333-4000-8000-000000000001";
const STAGE = "0072aaaa-4444-4000-8000-000000000001";
const AGENT = "0072aaaa-2222-4000-8000-000000000001";
const SESSION = "0072aaaa-9999-4000-8000-000000000001";
const CONTATO_COM_LEAD = "0072aaaa-7777-4000-8000-000000000001";
const CONTATO_SEM_LEAD = "0072aaaa-7777-4000-8000-000000000002";
const LEAD = "0072aaaa-5555-4000-8000-000000000001";

async function novoTrace(contactId: string, gate: string, code: string): Promise<string> {
  // before_send_traces.job_id tem FK para job_queue — o trace é auditoria de UMA
  // tentativa de envio, e tentativa sem job não existe.
  const { rows: jobs } = await pool.query<{ id: string }>(
    `insert into job_queue (organization_id, contact_id, kind, payload)
     values ($1, $2, 'inbound_turn', '{}'::jsonb) returning id`,
    [ORG, contactId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into before_send_traces
       (organization_id, job_id, contact_id, channel_session_id, trace, vetoed_gate, vetoed_code)
     values ($1, $2, $3, $4, '[]'::jsonb, $5, $6)
     returning id`,
    [ORG, jobs[0]!.id, contactId, SESSION, gate, code],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  await pool.query(`
    insert into organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'org-0072', 'Org 0072', 'Org 0072') on conflict (id) do nothing;

    insert into ai_agents (id, organization_id, name, system_prompt)
    values ('${AGENT}', '${ORG}', 'Bot veto', 'p') on conflict (id) do nothing;

    -- Criar organização provisiona um pipeline default automaticamente; inserir
    -- outro com is_default=true bate em uniq_crm_pipelines_org_default. Usa-se o
    -- que existe — é também o cenário real de qualquer tenant.
    insert into crm_pipelines (id, organization_id, name, slug, is_default)
    values ('${PIPE}', '${ORG}', 'Pipeline 0072', 'pipeline-0072', false) on conflict do nothing;

    insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
    values ('${STAGE}', '${ORG}', '${PIPE}', 'Etapa', 'etapa', 1000) on conflict (id) do nothing;

    insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
    values ('${SESSION}', '${ORG}', 'sessao-0072', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing;

    insert into contacts (id, organization_id, name, display_name) values
      ('${CONTATO_COM_LEAD}', '${ORG}', 'Com negócio', 'Com negócio'),
      ('${CONTATO_SEM_LEAD}', '${ORG}', 'Sem negócio', 'Sem negócio')
    on conflict (id) do nothing;

    insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id, status)
    values ('${LEAD}', '${ORG}', '${PIPE}', '${STAGE}', 'Negócio do veto', '${CONTATO_COM_LEAD}', 'open')
    on conflict (id) do nothing;
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("veto vira atividade no negócio certo", () => {
  it("com agente identificado: actor 'ai' com o trace como lastro", async () => {
    const traceId = await novoTrace(CONTATO_COM_LEAD, "stop", "opted_out");
    const r = await emitVetoActivity({
      pool,
      organizationId: ORG,
      contactId: CONTATO_COM_LEAD,
      traceId,
      gate: "stop",
      code: "opted_out",
      agentId: AGENT,
    });
    expect(r.routed).toBe(true);

    const { rows } = await pool.query(
      `select actor_kind, actor_agent_id, reason, source_module, source_id,
              evidence->'trace_ids'->>0 as trace_no_lastro
         from crm_lead_activities
        where lead_id = $1 and type = 'send_vetoed'
        order by performed_at desc limit 1`,
      [LEAD],
    );
    expect(rows[0]).toMatchObject({
      actor_kind: "ai",
      actor_agent_id: AGENT,
      source_module: "agent_guardrails",
      source_id: traceId,
      trace_no_lastro: traceId,
      reason: "Não enviei: o contato pediu para parar de receber mensagens",
    });
  });

  // Sem agente identificado a linha ainda entra — o que se recusa é afirmar
  // QUAL agente calou, não registrar que houve decisão.
  it("sem agente: entra como 'system', e a decisão não se perde", async () => {
    const traceId = await novoTrace(CONTATO_COM_LEAD, "window", "outside_window");
    await emitVetoActivity({
      pool,
      organizationId: ORG,
      contactId: CONTATO_COM_LEAD,
      traceId,
      gate: "window",
      code: "outside_window",
    });
    const { rows } = await pool.query(
      `select actor_kind, actor_agent_id, reason from crm_lead_activities
        where lead_id = $1 and payload->>'gate' = 'window' order by performed_at desc limit 1`,
      [LEAD],
    );
    expect(rows[0]).toMatchObject({
      actor_kind: "system",
      actor_agent_id: null,
      reason: "Não enviei: fora da janela de horário permitida",
    });
  });
});

// Spec 34: o "Não enviei" da trava comercial diz QUAL pedaço do texto a acionou e
// guarda o texto na linha da timeline — nunca no rastro da cadeia.
describe("veto comercial grava o texto e o trecho na linha", () => {
  it("payload leva texto_barrado e trecho; o motivo cita o trecho", async () => {
    const traceId = await novoTrace(CONTATO_COM_LEAD, "commercial_restriction", "commercial_requires_human");
    const r = await emitVetoActivity({
      pool,
      organizationId: ORG,
      contactId: CONTATO_COM_LEAD,
      traceId,
      gate: "commercial_restriction",
      code: "commercial_requires_human",
      agentId: AGENT,
      textoBarrado: "Fica sem custo nenhum",
      trecho: "custo",
    });
    expect(r.routed).toBe(true);
    const { rows } = await pool.query(
      `select reason, payload->>'texto_barrado' as texto, payload->>'trecho' as trecho
         from crm_lead_activities
        where lead_id = $1 and source_id = $2 and type = 'send_vetoed'`,
      [LEAD, traceId],
    );
    expect(rows[0]).toEqual({
      reason: 'Não enviei: a mensagem tocava em valores ou negociação, que são só com a equipe (o texto tinha "custo")',
      texto: "Fica sem custo nenhum",
      trecho: "custo",
    });
  });

  it("sem texto nem trecho as chaves não existem no payload", async () => {
    const traceId = await novoTrace(CONTATO_COM_LEAD, "stop", "opted_out");
    await emitVetoActivity({
      pool,
      organizationId: ORG,
      contactId: CONTATO_COM_LEAD,
      traceId,
      gate: "stop",
      code: "opted_out",
      agentId: AGENT,
    });
    const { rows } = await pool.query(
      `select payload ? 'texto_barrado' as tem_texto, payload ? 'trecho' as tem_trecho
         from crm_lead_activities where lead_id = $1 and source_id = $2`,
      [LEAD, traceId],
    );
    expect(rows[0]).toEqual({ tem_texto: false, tem_trecho: false });
  });
});

describe("veto sem negócio para pendurar", () => {
  it("vai para o event_log, NÃO para o card de outra pessoa", async () => {
    const traceId = await novoTrace(CONTATO_SEM_LEAD, "pacing", "rate_limited");
    const r = await emitVetoActivity({
      pool,
      organizationId: ORG,
      contactId: CONTATO_SEM_LEAD,
      traceId,
      gate: "pacing",
      code: "rate_limited",
      agentId: AGENT,
    });
    expect(r).toEqual({ routed: false, reason: "no_open_lead" });

    const { rows } = await pool.query(
      `select payload->>'reason' as motivo, payload->>'activity_type' as tipo,
              -- O ponteiro de origem no metadata do unrouted é source_id (campo
              -- canônico do emissor genérico), não um trace_id só do veto.
              metadata->>'source_id' as trace
         from event_log
        where organization_id = $1 and event_type = 'agent.activity_unrouted'
          and entity_id = $2
        order by created_at desc limit 1`,
      [ORG, CONTATO_SEM_LEAD],
    );
    expect(rows[0]).toMatchObject({
      motivo: "no_open_lead",
      tipo: "send_vetoed",
      trace: traceId,
    });

    // E o negócio do OUTRO contato não recebeu nada por engano.
    const { rows: vazamento } = await pool.query(
      `select count(*)::int as n from crm_lead_activities
        where lead_id = $1 and payload->>'gate' = 'pacing'`,
      [LEAD],
    );
    expect(vazamento[0]!.n).toBe(0);
  });
});

describe("vetoReason", () => {
  it("traduz os gates conhecidos para linguagem de gente", () => {
    expect(vetoReason("stop", "opted_out")).toContain("pediu para parar");
    expect(vetoReason("budget", "exhausted")).toContain("orçamento");
  });

  it("gate desconhecido não vira linha vazia — mostra a regra e o código", () => {
    expect(vetoReason("gate_novo", "cod_x")).toBe(
      'Não enviei: bloqueado pela regra "gate_novo" (cod_x)',
    );
  });
});
