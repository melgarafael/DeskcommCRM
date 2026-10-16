import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GOV_AGENT_A, GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * A recuperação de falta sobrevive à troca de `service_stale` de 40001 para PT409 (#2805).
 *
 * `fn_appointment_recover` chama `fn_service_event_origin` dentro de um bloco que
 * transforma a recusa em recibo 'stale' + aviso na Central. O bloco capturava só
 * `serialization_failure` (40001); com a 0654 a recusa sai `PT409` e escapava dele:
 * sem recibo, sem aviso, e o evento ia para dead depois de 5 tentativas.
 *
 * Arquivo próprio porque `agenda-presenca-recuperacao.test.ts` é congelado pelo
 * pre-commit; os auxiliares abaixo são o recorte mínimo dos de lá.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());

async function fixture() {
  const contact = randomUUID(),
    conversation = randomUUID(),
    id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Presença')", [contact, GOV_ORG]);
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversation, GOV_ORG, contact, GOV_SESSION],
  );
  await pool.query(
    "insert into calendar_appointments(id,organization_id,contact_id,conversation_id,title,starts_at,ends_at,status) values($1,$2,$3,$4,'Consulta',now()-interval '2 hours',now()-interval '1 hour','confirmed')",
    [id, GOV_ORG, contact, conversation],
  );
  return { conversation, id };
}

/** Desfecho "faltou" registrado por um humano — o caminho de produção que emite o evento. */
async function marcarFalta(id: string) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: GOV_AGENT_A, role: "authenticated" }),
    ]);
    await c.query("select fn_appointment_change($1,$2,1,$3)", [GOV_ORG, id, { status: "no_show" }]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** Um fluxo de recuperação publicado, para a recuperação chegar até `fn_service_event_origin`. */
async function fluxoDeRecuperacao() {
  await pool.query(
    "update followup_flow_pointers set status='disabled' where organization_id=$1 and trigger_config->>'kind'='appointment_no_show'",
    [GOV_ORG],
  );
  const graph = {
    nodes: [
      { id: "t", type: "trigger", label: "Falta", position: { x: 0, y: 0 }, config: {} },
      { id: "end", type: "end", label: "Fim", position: { x: 0, y: 1 }, config: { outcome: "converted" } },
    ],
    edges: [{ id: "e", source: "t", target: "end", priority: 0, condition: { type: "always" } }],
  };
  const v = (
    await pool.query("insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id", [GOV_ORG, graph])
  ).rows[0].id;
  const p = (
    await pool.query(
      "insert into followup_flow_pointers(organization_id,name,status,active_version_id,trigger_config) values($1,'Recuperação PT409 '||gen_random_uuid(),'active',$2,$3) returning id",
      [GOV_ORG, v, { kind: "appointment_no_show", cancel_on_reply: false }],
    )
  ).rows[0].id;
  const agent = (
    await pool.query(
      "insert into ai_agents(organization_id,name,system_prompt) values($1,'Recuperação PT409 '||gen_random_uuid(),'Prompt') returning id",
      [GOV_ORG],
    )
  ).rows[0].id;
  await pool.query(
    "insert into ai_agent_versions(organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,followup) values($1,$2,1,'Prompt','anthropic','claude-sonnet-4-6',$3,'published',$4)",
    [GOV_ORG, agent, GOV_SESSION, { enabled: true, flow_pointer_ids: [p] }],
  );
}

describe("recuperação de falta com a recusa em PT409 (#2805)", () => {
  it("atendimento encerrado entre o desfecho e a recuperação dá recibo 'stale' e aviso, não erro", async () => {
    await fluxoDeRecuperacao();
    const a = await fixture();
    await marcarFalta(a.id);
    const { service_revision } = (
      await pool.query("select service_revision from conversations where id=$1", [a.conversation])
    ).rows[0];
    await pool.query("select * from fn_service_status($1,$2,'closed',$3)", [GOV_ORG, a.conversation, service_revision]);
    const evento = (
      await pool.query(
        "select id from event_log where organization_id=$1 and entity_id=$2 and event_type='appointment.outcome_confirmed' order by created_at desc limit 1",
        [GOV_ORG, a.id],
      )
    ).rows[0].id;

    const r = (await pool.query("select fn_appointment_recover($1,$2) r", [GOV_ORG, evento])).rows[0].r;

    expect(r.result).toBe("stale");
    expect(
      (
        await pool.query(
          "select count(*)::int n from appointment_recovery_receipts where appointment_id=$1 and result='stale'",
          [a.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "select count(*)::int n from agent_inbox_items where ref_id=$1 and kind='appointment_recovery_review'",
          [a.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});
