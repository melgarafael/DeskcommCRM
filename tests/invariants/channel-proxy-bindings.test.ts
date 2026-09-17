import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const db = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres` });
afterAll(() => db.end());
async function fixture() {
  const org = randomUUID(), channel = randomUUID(), user = randomUUID();
  await db.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')", [org]);
  await db.query("insert into auth.users(id) values($1)", [user]);
  await db.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())", [org,user]);
  await db.query("insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status,engine) values($1::uuid,$2,$1::text,'\\x','STOPPED','GOWS')", [channel,org]);
  return { org, channel, user };
}
async function bind(org: string, channel: string, proxy: string, previous: string | null = null) {
  return db.query("select fn_bind_channel_proxy($1,$2,$3,'US','https://transport.test',$4) binding", [org,channel,proxy,previous]);
}
describe("vínculos de proxy", () => {
  it("reserva exclusiva sob concorrência e repetição sem duplicar", async () => {
    const a = await fixture(), b = await fixture(), id = randomUUID();
    const results = await Promise.allSettled([bind(a.org,a.channel,id),bind(b.org,b.channel,id)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? a : b;
    expect((await bind(winner.org,winner.channel,id)).rows[0].binding.proxy_id).toBe(id);
    expect((await db.query("select fn_reserved_channel_proxies($1) id", [[id, "missing"]])).rows).toEqual([{ id }]);
  });
  it("recusa tenant divergente, troca ativa e escrita autenticada direta", async () => {
    const a = await fixture(), b = await fixture(), id = randomUUID();
    await expect(bind(b.org,a.channel,id)).rejects.toThrow("proxy_channel_not_found");
    await bind(a.org,a.channel,id);
    await db.query("update channel_sessions set status='WORKING' where id=$1",[a.channel]);
    await expect(bind(a.org,a.channel,randomUUID(),id)).rejects.toThrow("proxy_change_requires_stop");
    const c = await db.connect();
    try {
      await c.query("begin; set local role authenticated");
      await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:b.user})]);
      expect((await c.query("select count(*)::int n from channel_proxy_bindings where organization_id=$1",[a.org])).rows[0].n).toBe(0);
      await expect(c.query("select fn_bind_channel_proxy($1,$2,$3,'US','https://transport.test',null)",[a.org,a.channel,id])).rejects.toThrow("permission denied");
    } finally { await c.query("rollback"); c.release(); }
  });
});
