import { beforeAll, afterAll, vi, describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  reserveInternalTurn,
  finishInternalTurn,
  getInternalSession,
} from "@/lib/assistant-pilot/internal-store";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const url = `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`;
const i = {
  tenantId: "00000000-0000-4000-8000-000000000071",
  userId: "00000000-0000-4000-8000-000000000072",
  assistantId: "internal-assistant",
};
describe.skipIf(!url)("internal store real PostgreSQL isolated", () => {
  const db = new pg.Pool({ connectionString: url });
  beforeAll(async () => {
    vi.stubEnv("ASSISTANT_PILOT_ORGANIZATION_ID", i.tenantId);
    vi.stubEnv("ASSISTANT_PILOT_OWNER_USER_ID", i.userId);
    // Fixtures ONLY in explicitly supplied isolated DB, never default project env.
    await db.query("insert into auth.users(id) values($1) on conflict do nothing", [i.userId]);
    await db.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1,'fixture-pilot','Fixture Pilot','Fixture Pilot') on conflict do nothing",
      [i.tenantId],
    );
    await db.query(
      "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'admin',now()) on conflict(user_id,organization_id) do update set revoked_at=null,accepted_at=now()",
      [i.userId, i.tenantId],
    );
  });
  afterAll(async () => {
    await db.query("delete from organizations where id=$1", [i.tenantId]);
    await db.end();
    vi.unstubAllEnvs();
  });
  it("reserves once, blocks concurrency, detects hash conflict and preserves history", async () => {
    const id = randomUUID();
    const r = await Promise.allSettled([
      reserveInternalTurn(db, i, id, "Fixture one"),
      reserveInternalTurn(db, i, id, "Fixture one"),
    ]);
    expect(r.filter((x) => x.status === "fulfilled" && x.value)).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(1);
    await expect(reserveInternalTurn(db, i, randomUUID(), "other concurrent")).rejects.toThrow(
      "session_busy_or_uncertain",
    );
    await finishInternalTurn(db, i, id, "Fixture reply one");
    expect(await reserveInternalTurn(db, i, id, "Fixture one")).toBe(false);
    await expect(reserveInternalTurn(db, i, id, "different")).rejects.toThrow(
      "turn_identity_conflict",
    );
    const id2 = randomUUID();
    await reserveInternalTurn(db, i, id2, "Fixture two");
    await finishInternalTurn(db, i, id2, "Fixture reply two");
    const s = await getInternalSession(db, i);
    expect(s.messages.slice(-4).map((m) => m.text)).toEqual([
      "Fixture one",
      "Fixture reply one",
      "Fixture two",
      "Fixture reply two",
    ]);
  });
  it("denies other user or tenant and revoked membership", async () => {
    await expect(getInternalSession(db, { ...i, userId: randomUUID() })).rejects.toThrow(
      "pilot_identity_denied",
    );
    await expect(getInternalSession(db, { ...i, tenantId: randomUUID() })).rejects.toThrow(
      "pilot_identity_denied",
    );
    await db.query(
      "update user_organizations set revoked_at=now() where user_id=$1 and organization_id=$2",
      [i.userId, i.tenantId],
    );
    await expect(getInternalSession(db, i)).rejects.toThrow("pilot_membership_denied");
    await db.query(
      "update user_organizations set revoked_at=null where user_id=$1 and organization_id=$2",
      [i.userId, i.tenantId],
    );
  });
  it("RLS owner only; authenticated cannot mutate personal transcript", async () => {
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query("grant usage on schema auth,public to authenticated");
      await c.query("grant select on organizations,user_organizations to authenticated");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub',$1,true)", [i.userId]);
      expect((await c.query("select * from personal_assistant_turns")).rowCount).toBeGreaterThan(0);
      await c.query("select set_config('request.jwt.claim.sub',$1,true)", [randomUUID()]);
      expect((await c.query("select * from personal_assistant_turns")).rowCount).toBe(0);
      await c.query("rollback");
      expect(
        (
          await db.query(
            "select has_table_privilege('authenticated','personal_assistant_turns','INSERT') allowed",
          )
        ).rows[0].allowed,
      ).toBe(false);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
