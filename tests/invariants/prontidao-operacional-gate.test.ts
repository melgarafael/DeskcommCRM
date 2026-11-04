import pg from "pg";
import { afterAll, expect, it } from "vitest";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const db = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 1,
});
afterAll(() => db.end());
it("allowlist recusa identidade não listada e TTL inclui a fronteira", async () => {
  const {
    rows: [r],
  } = await db.query(`select
 fn_inbox_gate_autorizado('{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":["+5511999999999"]}', '+5511888888888', null, now(), 1000) denied,
 fn_inbox_gate_autorizado('{"ai_gate":"allowlist"}', '+5511999999999', '2026-01-01 00:00:00Z', '2026-01-01 00:00:01Z', 1000) boundary,
 fn_inbox_gate_autorizado('{"ai_gate":"allowlist"}', '+5511999999999', '2026-01-01 00:00:00Z', '2026-01-01 00:00:01.001Z', 1000) expired`);
  expect(r).toEqual({ denied: false, boundary: true, expired: false });
});
it("novo campo não substitui o wrapper otimizado e não é definer", async () => {
  const {
    rows: [r],
  } = await db.query(
    `select p.prosecdef extra_definer,pg_get_functiondef('public.comando_da_conversa(public.conversations)'::regprocedure) native from pg_proc p where p.oid='public.comando_operacional_da_conversa(public.conversations)'::regprocedure`,
  );
  expect(r.extra_definer).toBe(false);
  expect(r.native).toContain("contato_trava_humano");
  expect(r.native).not.toContain("fn_inbox_gate_autorizado");
});
