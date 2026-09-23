import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { triggerConfigSchema } from "@/lib/followup/api-schemas";
import type { FollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { noDeGatilhoDoGrafo } from "@/lib/followup/agent-followup-gate";
import {
  EVENTO_DE_ETAPA,
  aplicaGatilhoDeEtapa,
  type GatilhoEtapaDb,
  type PointerDeEtapa,
} from "@/lib/followup/gatilho-etapa";
import type { FlowGraph } from "@/lib/followup/graph-schema";

/**
 * Gatilho de ETAPA DO FUNIL contra Postgres real — o que o fake do teste unit
 * não pode provar.
 *
 * Congela: (1) fluxo armado na etapa + agente publicado que o arma → 1
 * enrollment nascendo no nó `trigger` com o `agent_id` pinado, e o MESMO evento
 * reprocessado não duplica (o índice org-wide `idx_followup_enrollments_one_live`
 * é quem barra, não uma condição no TS); (2) gate-out contra
 * `ai_agent_versions` REAL — versão em rascunho e `followup.enabled=false` não
 * liberam, provando que a query do gate é de fato chamada; (3) fluxo armado em
 * OUTRA etapa não dispara; (4) a proveniência (`enrolled_by_stage_change`) fica
 * gravada em `followup_enrollment_events` com o negócio e as duas etapas — é o
 * que permite à fila responder "por que este contato está aqui"; (5) um pointer
 * `kind='silence'` ATIVO na mesma org não é confundido com um de etapa (o parse
 * do `triggerConfigSchema` é o mesmo do publish); (6) contato já vivo num
 * OUTRO fluxo da org barra o enrollment — a regra "um follow-up vivo por lead"
 * é org-wide, não por fluxo.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

/**
 * QUEM SUJA, LIMPA — os pointers que ESTE arquivo criou, e nada além disso.
 *
 * Os invariantes compartilham um Postgres que não é resetado entre arquivos. Um
 * enrollment DEVIDO (`next_eval_at` no passado, status vivo) deixado aqui entra
 * no `runFollowupTick` do arquivo seguinte, consome vaga do lote — que é
 * pequeno — e contamina os agregados dele. O arquivo que reprova não é o que
 * sujou, e por isso o defeito é caro de achar: mediu-se cinco arquivos de
 * follow-up deixando 10 enrollments devidos contra um `limit` de 5.
 *
 * ⚠️ ISTO NÃO SUBSTITUI A DEFESA DE ENTRADA de quem consome (`beforeEach` que
 * limpa antes de rodar, como `followup-engine.test.ts` faz desde a Task 5.2, e
 * como `ab4ad829` estendeu para as irmãs). As duas existem porque FALHAM EM
 * CENÁRIOS DIFERENTES: o `afterAll` não roda se o processo morrer no meio
 * (crash, timeout do runner, kill) — aí só a defesa de entrada salva quem vem
 * depois; e a defesa de entrada não protege ninguém contra um arquivo NOVO cujo
 * autor esqueceu de se defender — aí só a limpeza na origem impede o vazamento
 * de chegar nele. Redundância entre defesas que falham juntas é desperdício;
 * entre defesas que falham separado é o que torna isto robusto.
 *
 * ⚠️ PELOS IDS QUE ESTE ARQUIVO CRIOU, jamais um `delete` amplo por tabela ou
 * por organização. Num banco compartilhado por 91 arquivos, apagar por critério
 * largo é a próxima geração do mesmo problema com o sinal trocado: em vez de
 * deixar sujeira para o próximo, você apaga a fixture de outro no meio do run
 * dele. O `on delete cascade` de `followup_enrollments.pointer_id` leva os
 * enrollments junto, então apagar os pointers basta — e é o mínimo que resolve.
 */
const pointersCriados: string[] = [];

afterAll(async () => {
  if (pointersCriados.length > 0) {
    // A CONTAGEM ANTES DA LIMPEZA é o que prova que esta limpeza não é
    // cerimônia: é exatamente o que este arquivo entregaria ao próximo se o
    // `afterAll` não existisse. Zero aqui significaria que a limpeza é
    // decorativa — e limpeza decorativa é pior que nenhuma, porque dá a
    // sensação de que o problema foi tratado.
    // ⚠️ DOIS NÚMEROS, E NÃO UM, porque zero significa duas coisas diferentes e
    // só uma delas autoriza a frase "limpeza decorativa":
    //   - DEVIDOS  → rouba vaga do lote do `runFollowupTick` de quem rodar
    //                depois, e contamina os agregados dele;
    //   - TOTAIS   → mesmo não-devido, um enrollment VIVO ocupa o índice único
    //                `idx_followup_enrollments_one_live` (org-wide por contato).
    //                Ele não rouba claim, mas pode BARRAR o insert de outro
    //                arquivo que use o mesmo contato — e lá o sintoma seria
    //                "enrolled 0, skipped 1" onde o autor esperava 1. Outro
    //                vazamento, por outra porta.
    // 0 e 0 é limpeza decorativa, e nesse caso é obrigação dizer isso em vez de
    // manter a cerimônia: sensação de tratado é o que impede o próximo de tratar.
    const { rows } = await pool.query<{ devidos: string; totais: string }>(
      `select
         count(*) filter (
           where status in ('active','waiting_reply')
             and next_eval_at is not null and next_eval_at <= now()
         ) as devidos,
         count(*) filter (
           where status in ('active','waiting_reply','paused_handoff','paused_manual')
         ) as totais
       from followup_enrollments where pointer_id = any($1::uuid[])`,
      [pointersCriados],
    );
    process.stdout.write(
      `[followup-gatilho-etapa] deixados para trás antes da limpeza — ` +
        `devidos: ${rows[0]!.devidos}, vivos no total: ${rows[0]!.totais}\n`,
    );
    await pool.query(`delete from followup_flow_pointers where id = any($1::uuid[])`, [pointersCriados]);

    // ⚠️ A SEGUNDA METADE, e sem ela o commit não estava provado. A contagem
    // acima mostra que a sujeira EXISTE; esta mostra que a limpeza a REMOVE, e
    // são afirmações diferentes — a ponte entre "havia sujeira" e "escrevi um
    // afterAll" seria suposição. Zero aqui é o que autoriza dizer que este
    // arquivo não vaza.
    const { rows: sobrou } = await pool.query<{ devidos: string; totais: string }>(
      `select
         count(*) filter (
           where status in ('active','waiting_reply')
             and next_eval_at is not null and next_eval_at <= now()
         ) as devidos,
         count(*) filter (
           where status in ('active','waiting_reply','paused_handoff','paused_manual')
         ) as totais
       from followup_enrollments where pointer_id = any($1::uuid[])`,
      [pointersCriados],
    );
    process.stdout.write(
      `[followup-gatilho-etapa] DEPOIS da limpeza — ` +
        `devidos: ${sobrou[0]!.devidos}, vivos no total: ${sobrou[0]!.totais}\n`,
    );
  }
  await pool.end();
});

// Pointers deste arquivo ficam `active` para sempre; um `it` anterior
// contaminaria o seguinte. Escopo do delete: só os kinds que este arquivo cria
// — não toca em pointers de outros invariantes (nenhum outro usa
// 'stage_change'; 'silence' é limpo pelo próprio arquivo do sweep, e o único
// que este cria vive no `it` de confusão de kind).
beforeEach(async () => {
  await pool.query(
    `delete from followup_flow_pointers where trigger_config->>'kind' = 'stage_change'
       or name like 'Gatilho Etapa %'`,
  );
});

// ---- GatilhoEtapaDb sobre pg puro (prod usa createSupabaseGatilhoEtapaDb) ----

function gatilhoDb(): GatilhoEtapaDb {
  return {
    async carregaPointersDeEtapa(orgId) {
      const { rows } = await pool.query<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: unknown;
      }>(
        `select id, organization_id, active_version_id, trigger_config
           from followup_flow_pointers
          where organization_id = $1 and status = 'active' and active_version_id is not null`,
        [orgId],
      );
      const pointers: PointerDeEtapa[] = [];
      for (const row of rows) {
        if (!row.active_version_id) continue;
        // O MESMO parse do adapter de produção e do publish: é ele que separa
        // um pointer de etapa de um de silêncio.
        const parsed = triggerConfigSchema.safeParse(row.trigger_config);
        if (!parsed.success || parsed.data.kind !== "stage_change") continue;
        pointers.push({
          id: row.id,
          organization_id: row.organization_id,
          active_version_id: row.active_version_id,
          stage_id: parsed.data.params.stage_id,
        });
      }
      return pointers;
    },
    async carregaContatoDoNegocio(orgId, leadId) {
      const { rows } = await pool.query<{ contact_id: string | null }>(
        `select contact_id from crm_leads where id = $1 and organization_id = $2`,
        [leadId, orgId],
      );
      return rows[0]?.contact_id ?? null;
    },
    async carregaNoDeGatilho(orgId, versionId) {
      const { rows } = await pool.query<{ graph: FlowGraph }>(
        `select graph from followup_flow_versions where organization_id = $1 and id = $2`,
        [orgId, versionId],
      );
      if (rows.length === 0) return null;
      return noDeGatilhoDoGrafo(rows[0]!.graph);
    },
    async insereEnrollment(input) {
      try {
        const { rows } = await pool.query<{ id: string }>(
          // ⚠️ ESPELHA O ADAPTER DE PRODUÇÃO: quando `next_eval_at` vem
          // ausente, a coluna é OMITIDA e o `default now()` do banco decide
          // (migration 0147). Um adapter de teste que preenchesse o campo
          // sozinho esconderia o defeito de relógio que a guarda mede.
          input.next_eval_at === undefined || input.next_eval_at === null
            ? `insert into followup_enrollments
                 (organization_id, pointer_id, version_id, contact_id, current_node_id, status, agent_id)
               values ($1, $2, $3, $4, $5, 'active', $6) returning id`
            : `insert into followup_enrollments
                 (organization_id, pointer_id, version_id, contact_id, current_node_id, status, agent_id, next_eval_at)
               values ($1, $2, $3, $4, $5, 'active', $6, $7) returning id`,
          [
            input.organization_id,
            input.pointer_id,
            input.version_id,
            input.contact_id,
            input.current_node_id,
            input.agent_id,
            ...(input.next_eval_at === undefined || input.next_eval_at === null ? [] : [input.next_eval_at]),
          ],
        );
        return { inserted: true, id: rows[0]!.id };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return { inserted: false, id: null };
        throw err;
      }
    },
    async insereEventoDoEnrollment(evento) {
      try {
        await pool.query(
          `insert into followup_enrollment_events
             (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            evento.organization_id,
            evento.enrollment_id,
            evento.node_id,
            evento.event_type,
            JSON.stringify(evento.payload),
            evento.idempotency_key,
          ],
        );
      } catch (err) {
        if ((err as { code?: string }).code !== "23505") throw err;
      }
    },
  };
}

/** Espelha `createSupabaseFollowupGateDb` contra `ai_agent_versions` real. */
function pgGateDb(): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupAgents(orgId) {
      const { rows } = await pool.query<{ agent_id: string; followup: unknown }>(
        `select agent_id, followup from ai_agent_versions where organization_id = $1 and status = 'published'`,
        [orgId],
      );
      const byAgent = new Map<string, Set<string>>();
      for (const row of rows) {
        const f = row.followup as { enabled?: unknown; flow_pointer_ids?: unknown } | null;
        if (!f || f.enabled !== true || !Array.isArray(f.flow_pointer_ids)) continue;
        const set = byAgent.get(row.agent_id) ?? new Set<string>();
        for (const id of f.flow_pointer_ids) if (typeof id === "string") set.add(id);
        if (set.size > 0) byAgent.set(row.agent_id, set);
      }
      return [...byAgent].map(([agentId, ids]) => ({ agentId, pointerIds: [...ids] }));
    },
  };
}

// ---- seeds ----

let orgSeq = 0;
function nextOrgId(): string {
  orgSeq += 1;
  return `eeeeee${String(orgSeq).padStart(2, "0")}-0000-4000-8000-000000000001`;
}

async function seedOrg(org: string): Promise<void> {
  const name = `followup-gatilho-etapa-${org.slice(0, 8)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, name, name, name],
  );
}

async function seedContact(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Contato do Gatilho') returning id`,
    [org],
  );
  return rows[0]!.id;
}

/** Funil com DUAS etapas e um negócio na primeira — o desenho mínimo do "entrou na etapa X". */
async function seedFunilComNegocio(
  org: string,
  contactId: string | null,
): Promise<{ etapaOrigem: string; etapaDestino: string; leadId: string }> {
  const marca = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const { rows: pipe } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug) values ($1, 'Funil', $2) returning id`,
    [org, `funil-${marca}`.slice(0, 40)],
  );
  const pipelineId = pipe[0]!.id;
  const { rows: origem } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1, $2, 'Contato', $3, 1000) returning id`,
    [org, pipelineId, `contato-${marca}`.slice(0, 40)],
  );
  const { rows: destino } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1, $2, 'Proposta enviada', $3, 2000) returning id`,
    [org, pipelineId, `proposta-${marca}`.slice(0, 40)],
  );
  const { rows: lead } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title) values ($1, $2, $3, $4, 'Negócio') returning id`,
    [org, pipelineId, destino[0]!.id, contactId],
  );
  return { etapaOrigem: origem[0]!.id, etapaDestino: destino[0]!.id, leadId: lead[0]!.id };
}

async function seedFluxo(
  org: string,
  trigger: Record<string, unknown>,
  opts?: { comIa?: boolean },
): Promise<{ pointerId: string; versionId: string }> {
  const graph = {
    nodes: [
      { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} },
      ...(opts?.comIa
        ? [{ id: "c1", type: "ai_classify" as const, label: "Class", position: { x: 0, y: 0 }, config: {} }]
        : []),
      { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
    ],
    edges: [{ id: "t1-e1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
  } as FlowGraph;
  const { rows: version } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(graph)],
  );
  const { rows: pointer } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, trigger_config)
     values ($1, $2, 'active', $3, $4) returning id`,
    [org, `Gatilho Etapa ${Date.now()}-${Math.random()}`, version[0]!.id, JSON.stringify(trigger)],
  );
  // Registrado para o `afterAll` apagar exatamente o que este arquivo criou —
  // é o cascade deste pointer que leva embora os enrollments devidos.
  pointersCriados.push(pointer[0]!.id);
  return { pointerId: pointer[0]!.id, versionId: version[0]!.id };
}

async function seedAgentePublicado(
  org: string,
  opts: { status?: string; enabled?: boolean; pointerIds?: string[] },
): Promise<string> {
  const { rows: sess } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'WORKING', '\\x00'::bytea) returning id`,
    [org, `gatilho-etapa-${Date.now()}-${Math.random()}`],
  );
  const { rows: agent } = await pool.query<{ id: string }>(
    `insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 'prompt') returning id`,
    [org, `Agente do Gatilho ${Date.now()}-${Math.random()}`],
  );
  const followup = { enabled: opts.enabled ?? true, flow_pointer_ids: opts.pointerIds ?? [] };
  await pool.query(
    `insert into ai_agent_versions
       (organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, followup)
     values ($1, $2, 1, 'prompt', 'anthropic', 'claude-sonnet-4-6', $3, $4, $5)`,
    [org, agent[0]!.id, sess[0]!.id, opts.status ?? "published", JSON.stringify(followup)],
  );
  return agent[0]!.id;
}

let eventSeq = 0;
function eventoDeEtapa(org: string, leadId: string, de: string | null, para: string): EventRow {
  eventSeq += 1;
  return {
    id: `f0000000-0000-4000-8000-${String(eventSeq).padStart(12, "0")}`,
    organization_id: org,
    event_type: EVENTO_DE_ETAPA,
    entity_kind: "crm_lead",
    entity_id: leadId,
    payload: { from_stage_id: de, to_stage_id: para },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

const CLOCK = () => new Date();
const deps = () => ({ db: gatilhoDb(), gateDb: pgGateDb(), clock: CLOCK });

// ---- 1. enrolla + não duplica -------------------------------------------

describe("gatilho de etapa — enrolla o negócio que entrou na etapa armada", () => {
  it("fluxo armado na etapa + agente publicado → 1 enrollment no nó trigger; reprocessar o evento não duplica", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { etapaOrigem, etapaDestino, leadId } = await seedFunilComNegocio(org, contactId);
    const { pointerId } = await seedFluxo(org, { kind: "stage_change", params: { stage_id: etapaDestino } });
    const agentId = await seedAgentePublicado(org, { pointerIds: [pointerId] });

    const row = eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino);
    const s1 = await aplicaGatilhoDeEtapa(deps(), row);
    expect(s1.matched).toBe(true);
    expect(s1.pointers_armados).toBe(1);
    expect(s1.enrolled).toBe(1);

    const { rows } = await pool.query<{ current_node_id: string; status: string; agent_id: string | null }>(
      `select current_node_id, status, agent_id from followup_enrollments where pointer_id = $1 and contact_id = $2`,
      [pointerId, contactId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.current_node_id).toBe("t1");
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.agent_id).toBe(agentId);

    // O índice org-wide é quem barra a 2ª vez — não uma condição no TS.
    const s2 = await aplicaGatilhoDeEtapa(deps(), row);
    expect(s2.enrolled).toBe(0);
    expect(s2.skipped_existing).toBe(1);
    const { rows: depois } = await pool.query<{ n: string }>(
      `select count(*) as n from followup_enrollments where pointer_id = $1 and contact_id = $2`,
      [pointerId, contactId],
    );
    expect(Number(depois[0]!.n)).toBe(1);
  });

  it("grava a proveniência na timeline do enrollment (de que negócio e de qual etapa para qual)", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { etapaOrigem, etapaDestino, leadId } = await seedFunilComNegocio(org, contactId);
    const { pointerId } = await seedFluxo(org, { kind: "stage_change", params: { stage_id: etapaDestino } });
    await seedAgentePublicado(org, { pointerIds: [pointerId] });

    await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));

    const { rows } = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `select e.event_type, e.payload
         from followup_enrollment_events e
         join followup_enrollments en on en.id = e.enrollment_id
        where en.pointer_id = $1 and en.contact_id = $2`,
      [pointerId, contactId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe("enrolled_by_stage_change");
    expect(rows[0]!.payload.lead_id).toBe(leadId);
    expect(rows[0]!.payload.from_stage_id).toBe(etapaOrigem);
    expect(rows[0]!.payload.to_stage_id).toBe(etapaDestino);
  });
});

// ---- 2. gate real contra ai_agent_versions -------------------------------

describe("gatilho de etapa — o gate do agente, contra ai_agent_versions real", () => {
  it("versão em RASCUNHO, grafo de IA, não libera o fluxo", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { etapaOrigem, etapaDestino, leadId } = await seedFunilComNegocio(org, contactId);
    const { pointerId } = await seedFluxo(
      org,
      { kind: "stage_change", params: { stage_id: etapaDestino } },
      { comIa: true },
    );
    await seedAgentePublicado(org, { status: "draft", pointerIds: [pointerId] });

    const s = await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));
    expect(s.pointers_barrados_pelo_gate).toBe(1);
    expect(s.enrolled).toBe(0);
  });

  it("agente publicado com follow-up DESLIGADO, grafo de IA, não libera o fluxo", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { etapaOrigem, etapaDestino, leadId } = await seedFunilComNegocio(org, contactId);
    const { pointerId } = await seedFluxo(
      org,
      { kind: "stage_change", params: { stage_id: etapaDestino } },
      { comIa: true },
    );
    await seedAgentePublicado(org, { enabled: false, pointerIds: [pointerId] });

    const s = await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));
    expect(s.pointers_barrados_pelo_gate).toBe(1);
    expect(s.enrolled).toBe(0);
  });

  it("sem agente, grafo só de texto enrolla com agent_id nulo", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { etapaOrigem, etapaDestino, leadId } = await seedFunilComNegocio(org, contactId);
    await seedFluxo(org, { kind: "stage_change", params: { stage_id: etapaDestino } });

    const s = await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));
    expect(s.enrolled).toBe(1);
    expect(s.pointers_barrados_pelo_gate).toBe(0);
  });
});

// ---- 3. o que não é este gatilho ----------------------------------------

describe("gatilho de etapa — não dispara no que não é dele", () => {
  it("fluxo armado em OUTRA etapa do mesmo funil não dispara", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { etapaOrigem, etapaDestino, leadId } = await seedFunilComNegocio(org, contactId);
    const { pointerId } = await seedFluxo(org, { kind: "stage_change", params: { stage_id: etapaOrigem } });
    await seedAgentePublicado(org, { pointerIds: [pointerId] });

    const s = await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));
    expect(s.pointers_armados).toBe(0);
    expect(s.enrolled).toBe(0);
  });

  it("fluxo de SILÊNCIO ativo na mesma org não é confundido com um de etapa", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { etapaOrigem, etapaDestino, leadId } = await seedFunilComNegocio(org, contactId);
    const { pointerId } = await seedFluxo(org, {
      kind: "silence",
      params: { threshold_minutes: 30 },
    });
    await seedAgentePublicado(org, { pointerIds: [pointerId] });

    const s = await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));
    expect(s.pointers_armados).toBe(0);
    expect(s.enrolled).toBe(0);
  });

  it("negócio SEM contato não enrolla — e o desfecho é contado, não engolido", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { etapaOrigem, etapaDestino, leadId } = await seedFunilComNegocio(org, null);
    const { pointerId } = await seedFluxo(org, { kind: "stage_change", params: { stage_id: etapaDestino } });
    await seedAgentePublicado(org, { pointerIds: [pointerId] });

    const s = await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));
    expect(s.sem_contato).toBe(1);
    expect(s.enrolled).toBe(0);
  });
});

// ---- 4. um follow-up vivo por lead, ORG-WIDE -----------------------------

describe("gatilho de etapa — respeita 'um follow-up vivo por lead' entre fluxos diferentes", () => {
  it("contato já vivo em OUTRO fluxo da org não é enrollado de novo", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { etapaOrigem, etapaDestino, leadId } = await seedFunilComNegocio(org, contactId);

    // Fluxo A: manual, com o contato JÁ vivo nele.
    const { pointerId: manualId, versionId: manualVersion } = await seedFluxo(org, { kind: "manual" });
    await pool.query(
      `insert into followup_enrollments
         (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
       values ($1, $2, $3, $4, 't1', 'active', now())`,
      [org, manualId, manualVersion, contactId],
    );

    // Fluxo B: o de etapa, devidamente armado e liberado.
    const { pointerId } = await seedFluxo(org, { kind: "stage_change", params: { stage_id: etapaDestino } });
    await seedAgentePublicado(org, { pointerIds: [pointerId] });

    const s = await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));
    expect(s.pointers_armados).toBe(1);
    expect(s.enrolled).toBe(0);
    expect(s.skipped_existing).toBe(1);
  });
});
