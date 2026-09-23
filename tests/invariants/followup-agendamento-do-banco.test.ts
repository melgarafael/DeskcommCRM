import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { FollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { noDeGatilhoDoGrafo } from "@/lib/followup/agent-followup-gate";
import { aplicaGatilhoDeEtapa, type GatilhoEtapaDb, type PointerDeEtapa } from "@/lib/followup/gatilho-etapa";
import { applyReactivityEvent, type ReactivityAdminClient, type LiveEnrollmentRef } from "@/lib/followup/reactivity";
import type { EnrollmentPatch } from "@/lib/followup/engine";
import type { FlowGraph } from "@/lib/followup/graph-schema";

/**
 * O LADO COMPORTAMENTAL da guarda de agendamento: quem agenda "para agora"
 * grava o relógio do BANCO, não o do processo.
 *
 * O lado ESTÁTICO — `tests/unit/followup-agendamento-declarado.test.ts` —
 * obriga todo módulo que escreve `next_eval_at` a se declarar, e é ele que
 * fecha a CLASSE (módulo novo derruba o teste). Este aqui prova o
 * COMPORTAMENTO dos produtores que existem hoje, contra Postgres real.
 *
 * ⚠️ O CLOCK INJETADO É ADIANTADO DE PROPÓSITO, E ISSO É O QUE IMPEDE A GUARDA
 * DE PASSAR POR VACUIDADE. Se ela apenas checasse "o valor gravado não é
 * futuro", ficaria verde numa máquina onde o desvio real entre processo e banco
 * fosse zero — e desvio zero é precisamente o que não se pode assumir de um
 * ambiente de CI. Adiantando o processo em 1 SEGUNDO contra um desvio real
 * medido de 17–34 ms, a margem é de ~30×: se o instante gravado vier do
 * processo, ele aparece obviamente no futuro e o teste cai.
 *
 * ⚠️ ELA OLHA O VALOR NO BANCO, NÃO O CÓDIGO. Por isso vale para as duas saídas
 * da migration 0147 — `default now()` no insert e `fn_agora()` no update — sem
 * saber qual foi usada. Guarda que não precisa conhecer a implementação não
 * quebra quando a implementação muda.
 *
 * ⚠️ E NÃO REPROVA QUEM AGENDA PARA O FUTURO. Espera de N minutos com o relógio
 * do processo é correta: 30 ms de desvio num intervalo de minutos não muda
 * nada. Guarda que reprova código certo é desligada pela equipe em uma semana.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const pointersCriados: string[] = [];

afterAll(async () => {
  if (pointersCriados.length > 0) {
    await pool.query(`delete from followup_flow_pointers where id = any($1::uuid[])`, [pointersCriados]);
  }
  await pool.end();
});

/** O processo 1 SEGUNDO à frente do banco — o desvio real é de dezenas de ms. */
const UM_SEGUNDO_A_FRENTE = () => new Date(Date.now() + 1_000);

/** `next_eval_at` gravado é futuro em relação ao relógio do BANCO? */
async function gravouFuturo(enrollmentId: string): Promise<{ futuro: boolean; delta_ms: number }> {
  const { rows } = await pool.query<{ delta_ms: string }>(
    `select extract(epoch from (next_eval_at - now())) * 1000 as delta_ms
       from followup_enrollments where id = $1`,
    [enrollmentId],
  );
  const delta = Number(rows[0]!.delta_ms);
  return { futuro: delta > 0, delta_ms: delta };
}

// ---- cenário mínimo ----

let seq = 0;
async function cenario(): Promise<{
  org: string;
  contactId: string;
  leadId: string;
  etapaDestino: string;
  pointerId: string;
  versionId: string;
}> {
  seq += 1;
  const org = `bbbbbb${String(seq).padStart(2, "0")}-0000-4000-8000-00000000000b`;
  const marca = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, `relogio-${marca}`.slice(0, 40), "Relógio", "Relógio"],
  );
  const { rows: contato } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Contato do Relógio') returning id`,
    [org],
  );
  const { rows: pipe } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug) values ($1, 'Funil', $2) returning id`,
    [org, `rel-${marca}`.slice(0, 40)],
  );
  const { rows: etapa } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1, $2, 'Proposta', $3, 1000) returning id`,
    [org, pipe[0]!.id, `rele-${marca}`.slice(0, 40)],
  );
  const { rows: lead } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title) values ($1, $2, $3, $4, 'Negócio') returning id`,
    [org, pipe[0]!.id, etapa[0]!.id, contato[0]!.id],
  );
  const graph: FlowGraph = {
    nodes: [
      { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
    ],
    edges: [{ id: "t1-e1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
  };
  const { rows: version } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(graph)],
  );
  const { rows: pointer } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, trigger_config)
     values ($1, $2, 'active', $3, $4) returning id`,
    [
      org,
      `Relogio ${marca}`,
      version[0]!.id,
      JSON.stringify({ kind: "stage_change", params: { stage_id: etapa[0]!.id } }),
    ],
  );
  pointersCriados.push(pointer[0]!.id);

  const { rows: sess } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'WORKING', '\\x00'::bytea) returning id`,
    [org, `relogio-${marca}`],
  );
  const { rows: agent } = await pool.query<{ id: string }>(
    `insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 'prompt') returning id`,
    [org, `Agente Relogio ${marca}`],
  );
  await pool.query(
    `insert into ai_agent_versions
       (organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, followup)
     values ($1, $2, 1, 'prompt', 'anthropic', 'claude-sonnet-4-6', $3, 'published', $4)`,
    [org, agent[0]!.id, sess[0]!.id, JSON.stringify({ enabled: true, flow_pointer_ids: [pointer[0]!.id] })],
  );

  return {
    org,
    contactId: contato[0]!.id,
    leadId: lead[0]!.id,
    etapaDestino: etapa[0]!.id,
    pointerId: pointer[0]!.id,
    versionId: version[0]!.id,
  };
}

/**
 * Adapter espelhando o de produção — inclusive na parte que importa aqui:
 * quando `next_eval_at` vem `undefined`, a coluna é OMITIDA do INSERT e o
 * `default now()` do banco decide. Um adapter que preenchesse o campo sozinho
 * esconderia exatamente o defeito que este arquivo mede.
 */
function gatilhoDb(): GatilhoEtapaDb {
  return {
    async carregaPointersDeEtapa(orgId) {
      const { rows } = await pool.query<{
        id: string;
        organization_id: string;
        active_version_id: string;
        trigger_config: { kind: string; params?: { stage_id: string } };
      }>(
        `select id, organization_id, active_version_id, trigger_config from followup_flow_pointers
          where organization_id = $1 and status = 'active' and active_version_id is not null`,
        [orgId],
      );
      const out: PointerDeEtapa[] = [];
      for (const r of rows) {
        if (r.trigger_config.kind !== "stage_change" || !r.trigger_config.params) continue;
        out.push({
          id: r.id,
          organization_id: r.organization_id,
          active_version_id: r.active_version_id,
          stage_id: r.trigger_config.params.stage_id,
        });
      }
      return out;
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
      return rows[0] ? noDeGatilhoDoGrafo(rows[0].graph) : null;
    },
    async insereEnrollment(input) {
      const comRelogio = input.next_eval_at !== undefined && input.next_eval_at !== null;
      const sql = comRelogio
        ? `insert into followup_enrollments
             (organization_id, pointer_id, version_id, contact_id, current_node_id, status, agent_id, next_eval_at)
           values ($1,$2,$3,$4,$5,'active',$6,$7) returning id`
        : `insert into followup_enrollments
             (organization_id, pointer_id, version_id, contact_id, current_node_id, status, agent_id)
           values ($1,$2,$3,$4,$5,'active',$6) returning id`;
      const args: unknown[] = [
        input.organization_id,
        input.pointer_id,
        input.version_id,
        input.contact_id,
        input.current_node_id,
        input.agent_id,
      ];
      if (comRelogio) args.push(input.next_eval_at);
      try {
        const { rows } = await pool.query<{ id: string }>(sql, args);
        return { inserted: true, id: rows[0]!.id };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return { inserted: false, id: null };
        throw err;
      }
    },
    async insereEventoDoEnrollment() {
      /* irrelevante para esta guarda */
    },
  };
}

function gateDb(): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupAgents(orgId) {
      const { rows } = await pool.query<{ agent_id: string; followup: { enabled?: boolean; flow_pointer_ids?: string[] } }>(
        `select agent_id, followup from ai_agent_versions where organization_id = $1 and status = 'published'`,
        [orgId],
      );
      return rows
        .filter((r) => r.followup?.enabled === true && Array.isArray(r.followup.flow_pointer_ids))
        .map((r) => ({ agentId: r.agent_id, pointerIds: r.followup.flow_pointer_ids! }));
    },
  };
}

describe("agendar 'para agora' usa o relógio do BANCO — nascimento", () => {
  it("gatilho de etapa: o enrollment nasce vencido mesmo com o processo 1s adiantado", async () => {
    const c = await cenario();
    const s = await aplicaGatilhoDeEtapa(
      { db: gatilhoDb(), gateDb: gateDb(), clock: UM_SEGUNDO_A_FRENTE },
      {
        id: "d0000000-0000-4000-8000-000000000001",
        organization_id: c.org,
        event_type: "lead.stage_changed",
        entity_kind: "crm_lead",
        entity_id: c.leadId,
        payload: { to_stage_id: c.etapaDestino },
        metadata: {},
        consumed_by: [],
        attempts: 0,
      } as EventRow,
    );
    expect(s.enrolled).toBe(1);

    const { rows } = await pool.query<{ id: string }>(
      `select id from followup_enrollments where pointer_id = $1 and contact_id = $2`,
      [c.pointerId, c.contactId],
    );
    const veredito = await gravouFuturo(rows[0]!.id);
    expect(
      veredito.futuro,
      `next_eval_at ficou ${veredito.delta_ms} ms no FUTURO em relação ao now() do banco — ` +
        "o instante veio do relógio do processo, e o claim (que compara com now()) vai pular este " +
        "enrollment até o tick seguinte. Agende omitindo a coluna (default now(), migration 0147).",
    ).toBe(false);
  });
});

describe("agendar 'para agora' usa o relógio do BANCO — retomada", () => {
  it("reactivity: acordar por inbound não grava instante do processo", async () => {
    const c = await cenario();
    const { rows: enr } = await pool.query<{ id: string }>(
      `insert into followup_enrollments
         (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, steps_taken)
       values ($1,$2,$3,$4,'t1','waiting_reply', now() + interval '1 hour', 0) returning id`,
      [c.org, c.pointerId, c.versionId, c.contactId],
    );
    const enrollmentId = enr[0]!.id;

    const db: ReactivityAdminClient = {
      async loadConversationContactId() {
        return c.contactId;
      },
      async loadContactBlocked() {
        return false;
      },
      async loadLiveEnrollmentsForContact(): Promise<LiveEnrollmentRef[]> {
        return [
          {
            id: enrollmentId,
            status: "waiting_reply",
            current_node_id: "t1",
            steps_taken: 0,
            pointer_id: c.pointerId,
            handoff_policy: "pause",
            trigger_config: null,
          },
        ];
      },
      async insertEnrollmentEvent() {
        return { inserted: true };
      },
      async agoraNoBanco() {
        const { rows } = await pool.query<{ agora: string }>(`select public.fn_agora() as agora`);
        return rows[0]!.agora;
      },
      async updateEnrollment(id: string, orgId: string, patch: EnrollmentPatch) {
        const campos = Object.entries(patch).filter(([, v]) => v !== undefined);
        if (campos.length === 0) return;
        const set = campos.map(([k], i) => `${k} = $${i + 3}`).join(", ");
        await pool.query(
          `update followup_enrollments set ${set} where id = $1 and organization_id = $2`,
          [id, orgId, ...campos.map(([, v]) => v)],
        );
      },
    };

    const s = await applyReactivityEvent(db, UM_SEGUNDO_A_FRENTE, {
      id: "d0000000-0000-4000-8000-000000000002",
      organization_id: c.org,
      event_type: "message.received",
      entity_kind: "message",
      entity_id: null,
      payload: { contact_id: c.contactId },
      metadata: {},
      consumed_by: [],
      attempts: 0,
    } as EventRow);
    expect(s.reacted).toBe(1);

    const veredito = await gravouFuturo(enrollmentId);
    expect(
      veredito.futuro,
      `next_eval_at ficou ${veredito.delta_ms} ms no FUTURO — o lead RESPONDEU e o follow-up vai ` +
        "esperar o tick seguinte para reagir. Leia o relógio do banco (fn_agora(), migration 0147).",
    ).toBe(false);
  });
});
