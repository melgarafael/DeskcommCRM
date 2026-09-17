import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const db = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});
const org = randomUUID(),
  other = randomUUID(),
  session = randomUUID(),
  integration = randomUUID();
const payload = {
  channel_id: "test-social-channel",
  channel: "instagram",
  conversation_id: "thread",
  recipient_id: "00123456789012345678",
  name: "Pessoa de teste",
  external_id: "social-fixture-message",
  timestamp: Date.now(),
  type: "text",
  body: "Olá",
};
const ingest = (o = org, data = payload) =>
  db.query("select fn_ingest_social_dm($1,$2,$3) as result", [o, session, data]);
beforeAll(async () => {
  for (const id of [org, other])
    await db.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')",
      [id],
    );
  await db.query(
    "insert into social_connections(id,organization_id,account_id,credential) values($1::uuid,$2,$1::text,'{}')",
    [integration, org],
  );
  await db.query(
    "insert into channel_sessions(id,organization_id,provider,social_connection_id,social_channel_id,social_network,webhook_secret_encrypted) values($1,$2,'socios_hub',$3,$4,'instagram','\\x00')",
    [session, org, integration, payload.channel_id],
  );
});
afterAll(() => db.end());
describe("DMs sociais no banco real", () => {
  it("duplica entregas concorrentes sem duplicar contato, conversa ou mensagem", async () => {
    const results = await Promise.all([ingest(), ingest(), ingest()]);
    expect(new Set(results.map((r) => r.rows[0].result.message_id)).size).toBe(1);
    const { rows } = await db.query(
      "select c.channel,c.provider_recipient_id,p.phone_number from conversations c join contacts p on p.id=c.contact_id where c.organization_id=$1",
      [org],
    );
    expect(rows).toEqual([
      { channel: "instagram", provider_recipient_id: payload.recipient_id, phone_number: null },
    ]);
  });
  it("recusa organização, canal e identidade diferentes", async () => {
    await expect(ingest(other)).rejects.toThrow("social_channel_mismatch");
    await expect(ingest(org, { ...payload, channel_id: "outro" })).rejects.toThrow(
      "social_channel_mismatch",
    );
    await expect(ingest(org, { ...payload, recipient_id: "outro" })).rejects.toThrow(
      "social_identity_mismatch",
    );
  });
  it("não expõe credenciais nem RPC para anon ou usuário autenticado", async () => {
    const { rows } =
      await db.query(`select has_table_privilege('authenticated','social_connections','select') as member,
      has_table_privilege('anon','social_connections','select') as anon,
      has_function_privilege('authenticated','fn_ingest_social_dm(uuid,uuid,jsonb)','execute') as rpc,
      has_function_privilege('anon','fn_ingest_social_dm(uuid,uuid,jsonb)','execute') as anon_rpc`);
    expect(rows[0]).toEqual({ member: false, anon: false, rpc: false, anon_rpc: false });
  });
  it("nega SQL direto nas tabelas privadas e rejeita vínculo cross-tenant", async () => {
    for (const role of ["anon", "authenticated"]) {
      const client = await db.connect();
      try {
        for (const table of ["social_connections", "social_webhook_receipts"]) {
          await client.query("begin");
          await client.query(`set local role ${role}`);
          await expect(
            client.query(`select * from ${table} where organization_id=$1`, [org]),
          ).rejects.toThrow("permission denied");
          await client.query("rollback");
        }
      } finally {
        client.release();
      }
    }
    await expect(
      db.query("update channel_sessions set organization_id=$1 where id=$2", [other, session]),
    ).rejects.toThrow("channel_sessions_social_tenant_fk");
  });
  it("grava o trabalho uma única vez junto com a mensagem", async () => {
    await ingest();
    const r = await db.query(
      "select count(*)::int n from event_log where organization_id=$1 and event_type='social.dm_received'",
      [org],
    );
    expect(r.rows[0].n).toBe(1);
  });
  it("não reabre a IA ao receber outra mensagem", async () => {
    const { rows } = await db.query("select id from conversations where organization_id=$1", [org]);
    await db.query("update conversations set bot_silenced_until='infinity' where id=$1", [
      rows[0].id,
    ]);
    await ingest(org, { ...payload, external_id: "social-fixture-message-2" });
    expect(
      (
        await db.query("select bot_silenced_until::text as pause from conversations where id=$1", [
          rows[0].id,
        ])
      ).rows[0].pause,
    ).toBe("infinity");
  });
});

it("não aceita rede social nula e remove a identidade na cascata de anonimização", async () => {
  await expect(
    db.query("update channel_sessions set social_network=null where id=$1", [session]),
  ).rejects.toThrow("channel_sessions_social_network_required");
  const { rows } = await db.query("select contact_id from conversations where organization_id=$1", [
    org,
  ]);
  await db.query("select fn_lgpd_cascade_redact_contact($1,$2,null)", [org, rows[0].contact_id]);
  const identity = await db.query(
    "select provider_recipient_id,provider_conversation_id from conversations where organization_id=$1",
    [org],
  );
  expect(identity.rows[0]).toEqual({ provider_recipient_id: null, provider_conversation_id: null });
  const messages = await db.query(
    "select external_id,body from messages where organization_id=$1",
    [org],
  );
  expect(messages.rows.length).toBeGreaterThan(0);
  for (const msg of messages.rows)
    expect(msg).toEqual({ external_id: null, body: "[mensagem anonimizada]" });
});
