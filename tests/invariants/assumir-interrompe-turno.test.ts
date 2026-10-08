/** A função nativa de assumir invalida somente o comando autônomo daquela conversa.
 * Roda no PostgreSQL descartável de scripts/test-db.sh, com o baseline inteiro.
 * Não mede LLM, tela ou transporte externo já iniciado.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "./psql-transporte";
const ORG = "05920001-0000-4000-8000-000000000001";
const CONTACT = "05920001-0000-4000-8000-000000000002";
const SESSION = "05920001-0000-4000-8000-000000000003";
const CONVERSATION = "05920001-0000-4000-8000-000000000004";
const OWNER = "05920001-0000-4000-8000-000000000005";
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
  sql(`insert into auth.users (id,email) values ('${OWNER}', 'tomada-0592@invariant.test') on conflict do nothing;
    insert into public.organizations (id,slug,legal_name,display_name) values ('${ORG}','tomada-0592','Tomada','Tomada') on conflict do nothing;
    insert into public.user_organizations (user_id,organization_id,role,accepted_at) values ('${OWNER}','${ORG}','agent',now()) on conflict do nothing;
    insert into public.contacts (id,organization_id,display_name) values ('${CONTACT}','${ORG}','Cliente fictício') on conflict do nothing;
    insert into public.channel_sessions (id,organization_id,waha_session_name,webhook_secret_encrypted)
      values ('${SESSION}','${ORG}','tomada-0592','\\x00'::bytea) on conflict do nothing;
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
    seedJob("followup_turn");
    seedJob("inbound_turn", "pending", "05920001-0000-4000-8000-000000000099");
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
  it.each(["routing", "handoff"])("%s intencional não interrompe o próprio turno", (reason) => {
    seedJob("inbound_turn");
    assign(reason);
    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and status='running';`,
      ),
    ).toBe(1);
  });
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
      `update public.job_queue set payload=jsonb_set(payload,'{service_boundary,organization_id}','"05920001-0000-4000-8000-000000000099"') where organization_id='${ORG}';`,
    );
    assign();
    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and status='running';`,
      ),
    ).toBe(1);
  });
});
