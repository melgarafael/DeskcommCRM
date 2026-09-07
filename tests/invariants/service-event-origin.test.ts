import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGov, GOV_ORG, GOV_SESSION, GOV_AGENT_A, GOV_PIPELINE, GOV_STAGE } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
beforeAll(() => seedGov());
afterAll(async () => {
  await pool.end();
});
async function fixture(terminal = false) {
  const contact = randomUUID(),
    lead = randomUUID();
  await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Evento')", [
    contact,
    GOV_ORG,
  ]);
  await pool.query(
    "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title) values($1,$2,$3,$4,$5,'Evento')",
    [lead, GOV_ORG, contact, GOV_PIPELINE, GOV_STAGE],
  );
  if (terminal)
    await pool.query(
      "insert into conversations(organization_id,contact_id,channel_session_id,status) values($1,$2,$3,'closed')",
      [GOV_ORG, contact, GOV_SESSION],
    );
  const observed = (
    await pool.query("select fn_service_observe_command($1,$2) snapshot", [GOV_ORG, contact])
  ).rows[0].snapshot;
  const event = (
    await pool.query("select emit_event('lead.stage_changed','crm_lead',$1,$2::jsonb,'{}',$3) id", [
      lead,
      JSON.stringify({ service_origin: { kind: "command", observed } }),
      GOV_ORG,
    ])
  ).rows[0].id;
  return { contact, event };
}
const resolve = async (event: string, contact: string, org = GOV_ORG, session = GOV_SESSION) =>
  (
    await pool.query("select fn_service_event_origin($1,$2,$3,$4) boundary", [
      org,
      event,
      contact,
      session,
    ])
  ).rows[0].boundary;

describe("recibo imutável da origem do evento", () => {
  it.each([false, true])(
    "dois consumers e retry reutilizam abertura atômica (terminal=%s), close/reopen não renova",
    async (terminal) => {
      const { contact, event } = await fixture(terminal);
      const [a, b] = await Promise.all([resolve(event, contact), resolve(event, contact)]);
      expect(b).toEqual(a);
      expect(await resolve(event, contact)).toEqual(a);
      expect(
        (
          await pool.query("select count(*)::int n from event_service_origins where event_id=$1", [
            event,
          ])
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "select count(*)::int n from demandas where organization_id=$1 and contact_id=$2",
            [GOV_ORG, contact],
          )
        ).rows[0].n,
      ).toBe(0);
      await pool.query("select fn_service_status($1,$2,'closed',$3)", [
        GOV_ORG,
        a.conversation_id,
        a.service_revision,
      ]);
      await pool.query("select fn_service_begin($1,$2,$3)", [GOV_ORG, contact, GOV_SESSION]);
      await expect(resolve(event, contact)).rejects.toMatchObject({ code: "40001" });
      expect(
        (
          await pool.query("select service_boundary from event_service_origins where event_id=$1", [
            event,
          ])
        ).rows[0].service_boundary,
      ).toEqual(a);
      await pool.query("delete from event_log where id=$1 and organization_id=$2", [
        event,
        GOV_ORG,
      ]);
      expect(
        (
          await pool.query("select count(*)::int n from event_service_origins where event_id=$1", [
            event,
          ])
        ).rows[0].n,
      ).toBe(0);
    },
  );
  it("recibo recusa outro tenant real, contato e canal incoerentes", async () => {
    const { contact, event } = await fixture();
    const a = await resolve(event, contact);
    const orgB = randomUUID(),
      ctB = randomUUID(),
      channelB = randomUUID();
    await pool.query(
      "insert into organizations(id,slug,display_name,legal_name) values($1,$2,'B','B')",
      [orgB, orgB],
    );
    await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'B')", [
      ctB,
      orgB,
    ]);
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00')",
      [channelB, orgB, channelB],
    );
    await expect(resolve(event, ctB, orgB, channelB)).rejects.toMatchObject({ code: "P0002" });
    await expect(resolve(event, ctB)).rejects.toMatchObject({ code: "23503" });
    await expect(resolve(event, contact, GOV_ORG, channelB)).rejects.toMatchObject({
      code: "23503",
    });
    expect(await resolve(event, contact)).toEqual(a);
  });
  it("A mais recente e B configurada: destinos explícitos independentes, default fixo e continuação sem salto", async () => {
    const { contact } = await fixture();
    const channelB = randomUUID();
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00')",
      [channelB, GOV_ORG, channelB],
    );
    const a = (
      await pool.query("select fn_service_begin($1,$2,$3) b", [GOV_ORG, contact, GOV_SESSION])
    ).rows[0].b;
    await pool.query("update conversations set last_message_at=now() where id=$1", [
      a.conversation_id,
    ]);
    const observed = (
      await pool.query("select fn_service_observe_command($1,$2) b", [GOV_ORG, contact])
    ).rows[0].b;
    expect(observed.default_session_id).toBe(GOV_SESSION);
    const event = (
      await pool.query("select emit_event('contact.tag_added','contact',$1,$2::jsonb,'{}',$3) id", [
        contact,
        JSON.stringify({ service_origin: { kind: "command", observed } }),
        GOV_ORG,
      ])
    ).rows[0].id;
    const b = await resolve(event, contact, GOV_ORG, channelB);
    const first = await resolve(event, contact);
    expect(b.conversation_id).not.toBe(first.conversation_id);
    expect(first.conversation_id).toBe(a.conversation_id);
    expect(
      (
        await pool.query("select fn_service_event_origin($1,$2,$3,null) b", [
          GOV_ORG,
          event,
          contact,
        ])
      ).rows[0].b,
    ).toEqual(first);
    expect(await resolve(event, contact, GOV_ORG, channelB)).toEqual(b);
    const derivative = (await pool.query("select emit_event('contact.tag_added','contact',$1,$2::jsonb,'{}',$3) id", [contact,JSON.stringify({service_origin:{kind:"event",event_id:event,organization_id:GOV_ORG,contact_id:contact}}),GOV_ORG])).rows[0].id;
    expect(await resolve(derivative, contact, GOV_ORG, channelB)).toEqual(b);
    expect(await resolve(derivative, contact)).toEqual(first);
    await pool.query("select fn_service_status($1,$2,'closed',$3)", [
      GOV_ORG,
      b.conversation_id,
      b.service_revision,
    ]);
    await expect(resolve(event, contact, GOV_ORG, channelB)).rejects.toMatchObject({
      code: "40001",
    });
    expect(await resolve(event, contact)).toEqual(first);
    const continuation = (
      await pool.query("select emit_event('contact.tag_added','contact',$1,$2::jsonb,'{}',$3) id", [
        contact,
        JSON.stringify({ service_origin: { kind: "continuation", boundary: first } }),
        GOV_ORG,
      ])
    ).rows[0].id;
    await expect(resolve(continuation, contact, GOV_ORG, channelB)).rejects.toMatchObject({
      code: "23503",
    });
    expect(await resolve(continuation, contact)).toEqual(first);
    const childContinuation = (await pool.query("select emit_event('contact.tag_added','contact',$1,$2::jsonb,'{}',$3) id", [contact,JSON.stringify({service_origin:{kind:"event",event_id:continuation,organization_id:GOV_ORG,contact_id:contact}}),GOV_ORG])).rows[0].id;
    await expect(resolve(childContinuation,contact,GOV_ORG,channelB)).rejects.toMatchObject({code:"23503"});
    expect(await resolve(childContinuation,contact)).toEqual(first);
    await expect(resolve(derivative,contact,GOV_ORG,channelB)).rejects.toMatchObject({code:"40001"});
    expect(await resolve(derivative,contact)).toEqual(first);

  });
  it("authenticated não pode forjar origem nem ler/escrever recibos; evento público legado continua", async () => {
    const { contact, event } = await fixture();
    await resolve(event, contact);
    const client = await pool.connect();
    try {
      for (const statement of [
        "select * from event_service_origins",
        "insert into event_service_origins select * from event_service_origins",
        "select fn_service_event_origin($1,$2,$3,null)",
        "select emit_event('contact.tag_added','contact',$3,'{\"service_origin\":{\"kind\":\"command\"}}','{}',$1)",
        "select emit_event('contact.tag_added','contact',$3,'{}','{\"service_boundary\":{}}',$1)",
        "select fn_log_event($1,'contact.tag_added',jsonb_build_object('contact_id',$3::uuid,'service_origin','{}'::jsonb))",
      ]) {
        await client.query("begin");
        await client.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: GOV_AGENT_A }),
        ]);
        await client.query("set local role authenticated");
        await expect(
          client.query(
            statement.includes("$1")
              ? `with params as (select $1::uuid,$2::uuid,$3::uuid) ${statement}`
              : statement,
            statement.includes("$1") ? [GOV_ORG, event, contact] : [],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("rollback");
      }
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: GOV_AGENT_A }),
      ]);
      await client.query("set local role authenticated");
      expect(
        (
          await client.query("select emit_event('contact.updated','contact',$1,'{}','{}',$2) id", [
            contact,
            GOV_ORG,
          ])
        ).rows[0].id,
      ).toBeTruthy();
      await client.query("rollback");
      await client.query("begin");
      await client.query("set local role service_role");
      expect(
        (
          await client.query(
            "select count(*)::int n from event_service_origins where event_id=$1",
            [event],
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        client.query("delete from event_service_origins where event_id=$1", [event]),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
  it("emissão pública não reapresenta inbound: vazio/delegado recusados, INSERT interno continua", async () => {
    const { contact, event } = await fixture();
    const boundary = await resolve(event, contact);
    const message = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role service_role");
      await client.query(
        "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,sent_via,body,sent_at) values($1,$2,$3,$4,$5,'text','inbound','received','ai','Interna',clock_timestamp())",
        [message, GOV_ORG, contact, boundary.conversation_id, GOV_SESSION],
      );
      await client.query("commit");
      const emitted = (
        await pool.query(
          "select id from event_log where organization_id=$1 and event_type='message.received' and entity_id=$2",
          [GOV_ORG, message],
        )
      ).rows;
      expect(emitted).toHaveLength(1);
      expect((await resolve(emitted[0].id, contact)).conversation_id).toBe(
        boundary.conversation_id,
      );
      for (const statement of [
        "select emit_event('message.received','message',$1,'{}','{}',$2)",
        "select fn_log_event($2,'message.received',jsonb_build_object('message_id',$1::uuid))",
        "insert into messages(organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,sent_via,body,sent_at) select organization_id,contact_id,conversation_id,channel_session_id,'text','inbound','received','ai','Forjada',clock_timestamp() from messages where id=$1 and organization_id=$2",
      ]) {
        await client.query("begin");
        await client.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: GOV_AGENT_A }),
        ]);
        await client.query("set local role authenticated");
        await expect(client.query(statement, [message, GOV_ORG])).rejects.toMatchObject({
          code: "42501",
        });
        await client.query("rollback");
      }
      expect(
        (
          await pool.query(
            "select count(*)::int n from event_log where organization_id=$1 and event_type='message.received' and entity_id=$2",
            [GOV_ORG, message],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "select count(*)::int n from messages where organization_id=$1 and contact_id=$2",
            [GOV_ORG, contact],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("derivados usam recibo raiz por destino e não renovam após close; cadeia inválida falha fechada", async () => {
    const { contact, event } = await fixture(true);
    const derived = async (root: string, over: Record<string, unknown> = {}) =>
      (
        await pool.query(
          "select emit_event('contact.tag_added','contact',$1,$2::jsonb,'{}',$3) id",
          [
            contact,
            JSON.stringify({
              service_origin: {
                kind: "event",
                event_id: root,
                organization_id: GOV_ORG,
                contact_id: contact,
                ...over,
              },
            }),
            GOV_ORG,
          ],
        )
      ).rows[0].id;
    const first = await derived(event);
    const second = await derived(first);
    expect(
      (
        await pool.query(
          "select count(*)::int n from conversations where organization_id=$1 and contact_id=$2 and status='open'",
          [GOV_ORG, contact],
        )
      ).rows[0].n,
    ).toBe(0);
    const original = await resolve(event, contact);
    expect(await resolve(second, contact)).toEqual(original);
    expect(
      (
        await pool.query(
          "select count(*)::int n from event_service_origins where organization_id=$1 and event_id=any($2::uuid[])",
          [GOV_ORG, [event, first, second]],
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(resolve(await derived(randomUUID()), contact)).rejects.toMatchObject({
      code: "P0002",
    });
    await expect(
      resolve(await derived(event, { contact_id: randomUUID() }), contact),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      resolve(await derived(event, { organization_id: randomUUID() }), contact),
    ).rejects.toMatchObject({ code: "23503" });
    const cycle = await derived(event);
    await pool.query(
      "update event_log set payload=jsonb_set(payload,'{service_origin,event_id}',to_jsonb($1::text)) where id=$1::uuid",
      [cycle],
    );
    await expect(resolve(cycle, contact)).rejects.toMatchObject({ code: "40001" });
    await pool.query("select fn_service_status($1,$2,'closed',$3)", [
      GOV_ORG,
      original.conversation_id,
      original.service_revision,
    ]);
    await pool.query("select fn_service_begin($1,$2,$3)", [GOV_ORG, contact, GOV_SESSION]);
    await expect(resolve(second, contact)).rejects.toMatchObject({ code: "40001" });
  });
});
