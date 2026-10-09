import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { cancelJob } from "@/lib/agent-engine/queue/queue";
import { runFollowupTick, type FollowupJobRequest, type TickDeps } from "@/lib/followup/engine";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import { MAX_ACTION_RECHECKS } from "@/lib/followup/node-handlers";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";

import { isolarFixtureDeFollowup } from "./followup-isolamento";
import { relogioAncoradoNoBanco } from "./followup-relogio";
import { criarOrigemDeFollowup } from "./followup-service-origin";

/**
 * O MOTOR DE FOLLOW-UP COM A ORGANIZAÇÃO SUSPENSA (migration 0501; spec cobrança
 * do revendedor §1.3 — nada que custe ou saia roda com a org suspensa, e a
 * reativação não é rajada).
 *
 * Antes: o claim (`fn_claim_due_followup_enrollments`) não olhava
 * `organizations.status`. A org suspensa seguia avançando fluxos e enfileirando
 * turnos; o anti-backlog falhava o turno `pending` de uma inscrição parada num nó
 * `action`, e depois da reativação os rechecks retomavam até
 * `MAX_ACTION_RECHECKS`, que marcava `dead` com `action_turn_never_completed` e
 * abria `followup_dead` na Central com um motivo falso.
 *
 * Decisão do controlador: na reativação, a inscrição RETOMA — o claim faz rodízio
 * por organização com `p_limit` e o envio tem throttle, então não há rajada.
 *
 * Roda com o adaptador `pg` de produção (`createPgAdminClient`, o do worker) e
 * com o `enqueueJob` gravando o turno de verdade em `job_queue`, para a suspensão
 * alcançá-lo.
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

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
});

const ORG_SUSPENSA = "c0de0496-f011-4000-8000-00000000000a";
const ORG_ATIVA = "c0de0496-f011-4000-8000-00000000000b";

const TRIGGER_END: FlowGraph = flowGraphSchema.parse({
  nodes: [
    { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "t1-e1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
});

const ACTION_END: FlowGraph = flowGraphSchema.parse({
  nodes: [
    {
      id: "a1",
      type: "action",
      label: "Send",
      position: { x: 0, y: 0 },
      config: { mode: "ai_message", prompt_hint: "lembre o lead da proposta" },
    },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "a1-e1", source: "a1", target: "e1", priority: 0, condition: { type: "always" } }],
});

async function seedOrg(org: string): Promise<void> {
  const nome = `followup-org-suspensa-${org.slice(-2)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, nome, nome, nome],
  );
  // Cada teste parte da org ativa (a suspensão vem pela função de estado).
  await pool.query(
    `update organizations set status = 'active', suspended_kind = null, suspended_at = null,
       suspended_reason = null, suspended_by = null where id = $1`,
    [org],
  );
}

async function seedEnrollment(org: string, graph: FlowGraph, noAtual: string): Promise<string> {
  const { rows: contatos } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Contato do follow-up') returning id`,
    [org],
  );
  const contato = contatos[0]!.id;
  const { rows: versoes } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(graph)],
  );
  const { rows: ponteiros } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, $2, 'active', $3) returning id`,
    [org, `Fluxo ${Date.now()}-${Math.random()}`, versoes[0]!.id],
  );
  const fronteira = await criarOrigemDeFollowup(pool, org, contato);
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at,
        conversation_id, service_boundary)
     values ($1, $2, $3, $4, $5, 'active', now() - interval '1 second', $6, $7::jsonb)
     returning id`,
    [org, ponteiros[0]!.id, versoes[0]!.id, contato, noAtual, fronteira.conversation_id, JSON.stringify(fronteira)],
  );
  return rows[0]!.id;
}

/** O turno vai para a fila de verdade — é ela que a suspensão esvazia. */
function deps(): TickDeps {
  return {
    db: createPgAdminClient(pool),
    clock: relogioAncoradoNoBanco(),
    enqueueJob: async (job: FollowupJobRequest) => {
      await pool.query(
        `insert into job_queue (organization_id, contact_id, kind, payload) values ($1, $2, 'followup_turn', $3)`,
        [job.organization_id, job.contact_id, job.payload],
      );
    },
  };
}

async function vencer(enrollmentId: string): Promise<void> {
  await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [
    enrollmentId,
  ]);
}

async function turnos(enrollmentId: string): Promise<string[]> {
  const { rows } = await pool.query<{ estado: string }>(
    `select status || coalesce('|' || last_error, '') as estado from job_queue
      where kind = 'followup_turn' and payload->>'followup_enrollment_id' = $1 order by created_at, id`,
    [enrollmentId],
  );
  return rows.map((r) => r.estado);
}

const suspender = (org: string) =>
  pool.query(`select public.fn_suspender_organizacao($1, 'administrativa', 'invariante 0501', null)`, [org]);
const reativar = (org: string) =>
  pool.query(`select public.fn_reativar_organizacao($1, 'administrativa', null)`, [org]);

describe("fn_claim_due_followup_enrollments × organização parada", () => {
  it("⭐ não devolve o vencido da org suspensa; devolve o da org ativa (controle)", async () => {
    await seedOrg(ORG_SUSPENSA);
    await seedOrg(ORG_ATIVA);
    const daSuspensa = await seedEnrollment(ORG_SUSPENSA, TRIGGER_END, "t1");
    const daAtiva = await seedEnrollment(ORG_ATIVA, TRIGGER_END, "t1");
    await suspender(ORG_SUSPENSA);

    const { rows } = await pool.query<{ id: string }>(`select id from fn_claim_due_followup_enrollments(50, 60)`);
    const reclamados = rows.map((r) => r.id);
    expect(reclamados).toContain(daAtiva);
    expect(reclamados).not.toContain(daSuspensa);

    // Nem o lease foi tocado: a inscrição da suspensa segue intacta para a reativação.
    const { rows: linha } = await pool.query(`select claimed_until, status from followup_enrollments where id = $1`, [
      daSuspensa,
    ]);
    expect(linha[0]).toMatchObject({ claimed_until: null, status: "active" });
  });
});

describe("suspender e reativar com a inscrição parada num nó action", () => {
  it("⭐ a inscrição retoma na reativação: não morre, não abre followup_dead e sai num turno novo", async () => {
    await seedOrg(ORG_SUSPENSA);
    const inscricao = await seedEnrollment(ORG_SUSPENSA, ACTION_END, "a1");

    // Enfileira o turno e o espera o máximo que o dead-man tolera: o worker está
    // lento, e mais um recheck sem o turno fechar mataria a inscrição.
    await runFollowupTick(deps(), { limit: 5 });
    expect(await turnos(inscricao)).toEqual(["pending"]);
    for (let i = 0; i < MAX_ACTION_RECHECKS - 1; i++) {
      await vencer(inscricao);
      await runFollowupTick(deps(), { limit: 5 });
    }
    expect((await pool.query(`select status from followup_enrollments where id = $1`, [inscricao])).rows[0].status).toBe(
      "active",
    );

    await suspender(ORG_SUSPENSA);
    expect(await turnos(inscricao)).toEqual(["failed|org_nao_operante"]);

    // Suspensa: o motor não a toca.
    await vencer(inscricao);
    const suspensa = await runFollowupTick(deps(), { limit: 5 });
    expect(suspensa.claimed).toBe(0);

    await reativar(ORG_SUSPENSA);
    await vencer(inscricao);
    const retomada = await runFollowupTick(deps(), { limit: 5 });
    expect(retomada.dead).toBe(0);
    expect(await turnos(inscricao)).toEqual(["failed|org_nao_operante", "pending"]);

    // O turno novo fecha e a inscrição segue o fluxo.
    await completeTurnForEnrollment(createPgAdminClient(pool), ORG_SUSPENSA, inscricao, "a1", { kind: "sent" });
    const { rows } = await pool.query(`select status, current_node_id from followup_enrollments where id = $1`, [
      inscricao,
    ]);
    expect(rows[0]).toMatchObject({ status: "active", current_node_id: "e1" });
    const { rows: mortos } = await pool.query(
      `select count(*)::int as n from agent_inbox_items where organization_id = $1 and kind = 'followup_dead'`,
      [ORG_SUSPENSA],
    );
    expect(mortos[0].n).toBe(0);
  });
});

describe("o evento turn_discarded é só do servidor", () => {
  const MANAGER = "c0de0496-f011-4000-8000-0000000000aa";

  /** Roda o INSERT do evento como a sessão (PostgREST) ou como o servidor. */
  async function inserirDescarte(
    papel: "authenticated" | "service_role",
    inscricao: string,
    chave: string,
  ): Promise<void> {
    const cliente = await pool.connect();
    try {
      await cliente.query("begin");
      await cliente.query(`set local role ${papel}`);
      if (papel === "authenticated") {
        await cliente.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: MANAGER })]);
      }
      await cliente.query(
        `insert into public.followup_enrollment_events
           (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
         values ($1, $2, 'a1', 'turn_discarded', '{}', $3)`,
        [ORG_SUSPENSA, inscricao, chave],
      );
      await cliente.query("commit");
    } catch (err) {
      await cliente.query("rollback");
      throw err;
    } finally {
      cliente.release();
    }
  }

  it("⭐ manager pela sessão é recusado pelo gatilho (42501 followup_step_internal); service_role grava", async () => {
    await seedOrg(ORG_SUSPENSA);
    await pool.query(`insert into auth.users (id, email) values ($1, 'manager-0501@invariant.test') on conflict do nothing`, [
      MANAGER,
    ]);
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1, $2, 'manager', now())
       on conflict (user_id, organization_id) do update set role = 'manager', accepted_at = now()`,
      [MANAGER, ORG_SUSPENSA],
    );
    const inscricao = await seedEnrollment(ORG_SUSPENSA, ACTION_END, "a1");

    // Sem o gatilho, a policy de INSERT (manager) deixa passar e o motor enfileira
    // um 2º turno de envio. A chave não termina em `:<n>`: a recusa tem de vir da
    // regra do evento, não da do passo.
    const recusa = await inserirDescarte("authenticated", inscricao, "a1:1:descartado").then(
      () => null,
      (err: { code?: string; message?: string }) => err,
    );
    expect(recusa).toMatchObject({ code: "42501", message: "followup_step_internal" });

    await inserirDescarte("service_role", inscricao, "a1:1:descartado");
    const { rows } = await pool.query(
      `select count(*)::int as n from followup_enrollment_events where enrollment_id = $1 and event_type = 'turn_discarded'`,
      [inscricao],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("o turno de envio que já RODAVA no instante da suspensão", () => {
  /**
   * A C0 falha só o `pending`. O turno `running` segue, o envio é barrado com
   * `OrgNaoOperanteError` e o worker o cancela (`terminal`). Sem `turn_discarded`,
   * a reativação lê o cancelamento como worker morto e o dead-man mata a inscrição
   * com `action_turn_never_completed` — motivo falso, aviso `followup_dead` na Central.
   */
  async function ateOTurnoRodarNaSuspensao(): Promise<{ inscricao: string; turno: string }> {
    await seedOrg(ORG_SUSPENSA);
    const inscricao = await seedEnrollment(ORG_SUSPENSA, ACTION_END, "a1");
    await runFollowupTick(deps(), { limit: 5 });
    for (let i = 0; i < MAX_ACTION_RECHECKS - 1; i++) {
      await vencer(inscricao);
      await runFollowupTick(deps(), { limit: 5 });
    }
    // O worker pega o turno; a suspensão chega com ele rodando.
    const { rows } = await pool.query<{ id: string }>(
      `update job_queue set status = 'running', locked_by = 'w1', locked_at = now()
        where kind = 'followup_turn' and payload->>'followup_enrollment_id' = $1 returning id`,
      [inscricao],
    );
    await suspender(ORG_SUSPENSA);
    expect(await turnos(inscricao), "a C0 não toca o que está rodando").toEqual(["running"]);
    return { inscricao, turno: rows[0]!.id };
  }

  const descartar = async (turno: string): Promise<boolean> =>
    (await pool.query<{ gravou: boolean }>(`select public.fn_followup_turno_descartado($1, $2) as gravou`, [ORG_SUSPENSA, turno]))
      .rows[0]!.gravou;

  it("⭐ o worker grava turn_discarded antes de cancelar: a reativação enfileira um turno novo, sem followup_dead", async () => {
    const { inscricao, turno } = await ateOTurnoRodarNaSuspensao();

    expect(await descartar(turno)).toBe(true);
    expect(await descartar(turno), "idempotente: o 2º registro não duplica o evento").toBe(false);
    await cancelJob(pool, turno, "w1", "A conta desta empresa está suspensa.");

    await reativar(ORG_SUSPENSA);
    await vencer(inscricao);
    const retomada = await runFollowupTick(deps(), { limit: 5 });
    expect(retomada.dead).toBe(0);
    expect(await turnos(inscricao)).toEqual(["failed|A conta desta empresa está suspensa.", "pending"]);
    const { rows: mortos } = await pool.query(
      `select count(*)::int as n from agent_inbox_items where organization_id = $1 and kind = 'followup_dead'`,
      [ORG_SUSPENSA],
    );
    expect(mortos[0].n).toBe(0);
  });

  it("controle: sem o evento, a mesma sequência mata a inscrição (o defeito que o registro fecha)", async () => {
    const { inscricao, turno } = await ateOTurnoRodarNaSuspensao();
    await cancelJob(pool, turno, "w1", "A conta desta empresa está suspensa.");

    await reativar(ORG_SUSPENSA);
    await vencer(inscricao);
    const retomada = await runFollowupTick(deps(), { limit: 5 });
    expect(retomada.dead).toBe(1);
  });

  it("só o servidor executa fn_followup_turno_descartado", async () => {
    const { rows } = await pool.query(
      `select r as papel, has_function_privilege(r, 'public.fn_followup_turno_descartado(uuid, uuid)', 'execute') as pode
         from unnest(array['anon', 'authenticated', 'service_role']) r order by r`,
    );
    expect(rows).toEqual([
      { papel: "anon", pode: false },
      { papel: "authenticated", pode: false },
      { papel: "service_role", pode: true },
    ]);
  });
});

describe("0510: o aviso da volta não conta o turno de envio que o motor refaz", () => {
  it("⭐ turno send_message descartado COM turn_discarded não vira 'passo descartado' no org_reativada", async () => {
    await seedOrg(ORG_SUSPENSA);
    const inscricao = await seedEnrollment(ORG_SUSPENSA, ACTION_END, "a1");
    await runFollowupTick(deps(), { limit: 5 });
    expect(await turnos(inscricao)).toEqual(["pending"]);
    const { rows: marco } = await pool.query<{ agora: string }>(`select clock_timestamp()::text as agora`);

    await suspender(ORG_SUSPENSA);
    expect(await turnos(inscricao)).toEqual(["failed|org_nao_operante"]);
    const { rows: evento } = await pool.query(
      `select count(*)::int as n from followup_enrollment_events where enrollment_id = $1 and event_type = 'turn_discarded'`,
      [inscricao],
    );
    expect(evento[0].n).toBe(1);

    await reativar(ORG_SUSPENSA);
    const { rows: volta } = await pool.query(
      `select payload->>'passos_descartados' as passos from event_log
        where organization_id = $1 and event_type = 'tenant.reactivated' and created_at >= $2::timestamptz
        order by created_at desc limit 1`,
      [ORG_SUSPENSA, marco[0]!.agora],
    );
    expect(volta[0]?.passos).toBe("0");
    const { rows: avisos } = await pool.query(
      `select count(*)::int as n from agent_inbox_items
        where organization_id = $1 and kind = 'org_reativada' and created_at >= $2::timestamptz`,
      [ORG_SUSPENSA, marco[0]!.agora],
    );
    expect(avisos[0].n).toBe(0);
  });
});
