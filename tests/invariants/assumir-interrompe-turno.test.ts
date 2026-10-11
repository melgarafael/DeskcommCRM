/** A função nativa de assumir invalida somente o comando autônomo daquela conversa.
 * Roda no PostgreSQL descartável de scripts/test-db.sh, com o baseline inteiro.
 * Não mede LLM, tela ou transporte externo já iniciado.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireCurrentAutonomousTurn } from "@/lib/atendimento/fronteira-server";
import { descartarFollowupObsoleto } from "@/lib/atendimento/descartar-followup-obsoleto";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { sql } from "./psql-transporte";
const ORG = "05940001-0000-4000-8000-000000000001";
const CONTACT = "05940001-0000-4000-8000-000000000002";
const SESSION = "05940001-0000-4000-8000-000000000003";
const CONVERSATION = "05940001-0000-4000-8000-000000000004";
const OWNER = "05940001-0000-4000-8000-000000000005";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
afterAll(() => pool.end());
async function runningJob() {
  return (
    await pool.query<JobRow>(
      "select *, locked_at::text as claim_acquired_at from job_queue where organization_id=$1 and status='running'",
      [ORG],
    )
  ).rows[0]!;
}
function value(query: string) {
  return Number(sql(query).trim().split("\n").at(-1));
}
function assign(reason = "claim", owner: string | null = OWNER) {
  sql(
    `select public.fn_conversation_assign('${ORG}', '${CONVERSATION}', ${owner ? `'${owner}'` : "null"}, '${reason}', null, false);`,
  );
}
function seedJob(kind: string, status = "running", conversation = CONVERSATION) {
  sql(`insert into public.job_queue (organization_id, contact_id, kind, status, payload, locked_by, locked_at)
    values ('${ORG}', '${CONTACT}', '${kind}', '${status}',
      jsonb_build_object('service_boundary', jsonb_build_object('organization_id', '${ORG}', 'conversation_id', '${conversation}')),
      ${status === "running" ? "'worker-tomada'" : "null"}, ${status === "running" ? "now()" : "null"});`);
}
beforeAll(() => {
  sql(`insert into auth.users (id,email) values ('${OWNER}', 'tomada-0594@invariant.test') on conflict do nothing;
    insert into public.organizations (id,slug,legal_name,display_name) values ('${ORG}','tomada-0594','Tomada','Tomada') on conflict do nothing;
    insert into public.user_organizations (user_id,organization_id,role,accepted_at) values ('${OWNER}','${ORG}','agent',now()) on conflict do nothing;
    insert into public.contacts (id,organization_id,display_name) values ('${CONTACT}','${ORG}','Cliente fictício') on conflict do nothing;
    insert into public.channel_sessions (id,organization_id,waha_session_name,webhook_secret_encrypted)
      values ('${SESSION}','${ORG}','tomada-0594','\\x00'::bytea) on conflict do nothing;
    insert into public.conversations (id,organization_id,contact_id,channel_session_id,status)
      values ('${CONVERSATION}','${ORG}','${CONTACT}','${SESSION}','open') on conflict do nothing;`);
});
beforeEach(() => {
  sql(`delete from public.job_queue where organization_id='${ORG}';
    update public.conversations set assigned_to_user_id=null, assignee_kind=null, bot_silenced_until=null, last_handoff_at=null, status='open' where id='${CONVERSATION}';`);
});
describe("tomada humana invalida o comando autônomo", () => {
  it.each(["claim", "transfer"])(
    "%s encerra inbound/case pendentes e em execução, sem ressuscitar ao devolver",
    (reason) => {
      for (const kind of ["inbound_turn", "case_reply_turn"])
        for (const status of ["pending", "running"]) {
          sql(`delete from public.job_queue where organization_id='${ORG}';`);
          seedJob(kind, status);
          expect(
            value(
              `select count(*) from public.job_queue where organization_id='${ORG}' and status='${status}';`,
            ),
          ).toBe(1);
          assign(reason);
          assign("release", null);
          expect(
            value(
              `select count(*) from public.job_queue where organization_id='${ORG}' and status='failed' and locked_at is null and locked_by is null and last_error='conversation_command_taken';`,
            ),
          ).toBe(1);
          // Os predicados nativos de completeJob/failJob/reaper não alcançam o lease perdido.
          expect(
            value(
              `with completed as (update public.job_queue set status='done' where organization_id='${ORG}' and status='running' and locked_by='worker-tomada' returning id) select count(*) from completed;`,
            ),
          ).toBe(0);
        }
    },
  );
  it("preserva jobs independentes, follow-up futuro e a conversa vizinha", () => {
    for (const kind of ["transactional_delivery", "approved_reply", "operator_turn"])
      seedJob(kind, "pending");
    seedJob("followup_turn", "pending");
    seedJob("inbound_turn");
    seedJob("inbound_turn", "pending", "05940001-0000-4000-8000-000000000099");
    assign();
    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and status='failed';`,
      ),
    ).toBe(1);
    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and status in ('pending','running');`,
      ),
    ).toBe(5);
  });
  it.each(["transactional_delivery", "approved_reply", "operator_turn"])(
    "preserva %s em execução",
    (kind) => {
      seedJob(kind);
      assign();
      expect(
        value(
          `select count(*) from public.job_queue where organization_id='${ORG}' and status='running' and locked_by='worker-tomada';`,
        ),
      ).toBe(1);
    },
  );
  it.each(["routing", "handoff"])("%s intencional não interrompe o próprio turno", (reason) => {
    seedJob("inbound_turn");
    assign(reason);
    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and status='running';`,
      ),
    ).toBe(1);
  });
  it("login não fabrica revogação por emit_event, fn_log_event ou escrita direta", async () => {
    seedJob("followup_turn");
    const job = await runningJob();
    const commands = [
      {
        text: "select emit_event('conversation.autonomous_turn_revoked','job',$1,$2,'{}',$3)",
        values: [job.id, JSON.stringify({ conversation_id: CONVERSATION }), ORG],
      },
      {
        text: "select fn_log_event($1,'conversation.autonomous_turn_revoked',$2)",
        values: [ORG, JSON.stringify({ conversation_id: CONVERSATION, lead_id: job.id })],
      },
      {
        text: "insert into event_log(organization_id,event_type,entity_kind,entity_id,payload,status) values($1,'conversation.autonomous_turn_revoked','job',$2,$3,'done')",
        values: [ORG, job.id, JSON.stringify({ conversation_id: CONVERSATION })],
      },
    ];
    for (const command of commands) {
      const tx = await pool.connect();
      try {
        await tx.query("begin");
        await tx.query("set local role authenticated");
        await tx.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: OWNER }),
        ]);
        await expect(tx.query(command)).rejects.toMatchObject({ code: "42501" });
      } finally {
        await tx.query("rollback");
        tx.release();
      }
    }
    expect(
      (
        await pool.query(
          "select count(*)::int as n from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.autonomous_turn_revoked'",
          [ORG, job.id],
        )
      ).rows[0]!.n,
    ).toBe(0);
    await expect(requireCurrentAutonomousTurn(pool, job)).resolves.toBeUndefined();
  });
  it("a sessão humana assume sem atravessar a proteção de follow-ups", () => {
    seedJob("followup_turn");
    sql(`set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);
      select public.fn_conversation_assign('${ORG}','${CONVERSATION}','${OWNER}','claim',null,false);`);
    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and status='running';`,
      ),
    ).toBe(1);
  });
  it("revoga follow-up em execução mesmo após devolver e numa transação iniciada antes do lease", async () => {
    const tx = await pool.connect();
    try {
      await tx.query("begin");
      await tx.query("select now()");
      seedJob("followup_turn");
      const job = await runningJob();
      await requireCurrentAutonomousTurn(pool, job);
      await tx.query("select fn_conversation_assign($1,$2,$3,'claim',null,false)", [
        ORG,
        CONVERSATION,
        OWNER,
      ]);
      await tx.query("commit");
      assign("release", null);
      await expect(requireCurrentAutonomousTurn(pool, job)).rejects.toThrow(
        "service_boundary_stale",
      );
      expect(
        (
          await pool.query("select fn_followup_claim_current($1,$2,$3,$4) as current", [
            ORG,
            job.id,
            job.locked_by,
            job.claim_acquired_at,
          ])
        ).rows[0]!.current,
      ).toBe(false);
      await descartarFollowupObsoleto(pool, job, "worker-tomada");
      expect(
        value(
          `select count(*) from job_queue where id='${job.id}' and status='failed' and locked_by is null;`,
        ),
      ).toBe(1);
      seedJob("followup_turn");
      await expect(requireCurrentAutonomousTurn(pool, await runningJob())).resolves.toBeUndefined();
    } finally {
      await tx.query("rollback");
      tx.release();
    }
  });
  it.each(["paused_handoff", "cancelled"])(
    "o descarte preserva a decisão %s do fluxo e não inventa worker morto",
    async (status) => {
      const ver = (
        await pool.query(
          "insert into followup_flow_versions(organization_id,graph) values($1,'{}') returning id",
          [ORG],
        )
      ).rows[0]!.id;
      const ptr = (
        await pool.query(
          "insert into followup_flow_pointers(organization_id,name,handoff_policy,active_version_id) values($1,$2,$3,$4) returning id",
          [ORG, `tomada-${status}`, status === "cancelled" ? "cancel" : "pause", ver],
        )
      ).rows[0]!.id;
      const enrollment = (
        await pool.query(
          `insert into followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,status,next_eval_at)
      values($1,$2,$3,$4,$5,'enviar',$6,null) returning id`,
          [ORG, ptr, ver, CONTACT, CONVERSATION, status],
        )
      ).rows[0]!.id;
      await pool.query(
        `insert into job_queue(organization_id,contact_id,kind,status,locked_by,locked_at,payload)
        values($1::uuid,$2::uuid,'followup_turn','running','worker-tomada',clock_timestamp(),
          jsonb_build_object('service_boundary',jsonb_build_object('organization_id',$1::text,'conversation_id',$3::text),
            'purpose','send_message','followup_enrollment_id',$4::text,'node_id','enviar','source_step_key','tomada:0'))`,
        [ORG, CONTACT, CONVERSATION, enrollment],
      );
      const job = await runningJob();
      assign();
      await descartarFollowupObsoleto(pool, job, "worker-tomada");
      await descartarFollowupObsoleto(pool, job, "worker-tomada");
      expect(
        (await pool.query("select status from followup_enrollments where id=$1", [enrollment]))
          .rows[0]!.status,
      ).toBe(status);
      expect(
        value(
          `select count(*) from followup_enrollment_events where enrollment_id='${enrollment}' and event_type='turn_discarded';`,
        ),
      ).toBe(status === "cancelled" ? 0 : 1);
      expect(
        value(
          `select count(*) from job_queue where id='${job.id}' and status='failed' and locked_by is null;`,
        ),
      ).toBe(1);
    },
  );
  it("a tomada revertida não deixa cancelamento fora da transação", () => {
    seedJob("inbound_turn");
    sql(
      `begin; select public.fn_conversation_assign('${ORG}','${CONVERSATION}','${OWNER}','claim',null,false); rollback;`,
    );
    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and status='running' and locked_by='worker-tomada';`,
      ),
    ).toBe(1);
  });
  it("evento incoerente ou fronteira de outra organização não invalida comando", () => {
    seedJob("inbound_turn");
    sql(`insert into public.conversation_assignment_events (organization_id,conversation_id,to_user_id,reason)
      values ('${ORG}','${CONVERSATION}','${OWNER}','claim');`);
    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and status='running';`,
      ),
    ).toBe(1);
    sql(
      `update public.job_queue set payload=jsonb_set(payload,'{service_boundary,organization_id}','"05940001-0000-4000-8000-000000000099"') where organization_id='${ORG}';`,
    );
    assign();
    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and status='running';`,
      ),
    ).toBe(1);
  });
});
