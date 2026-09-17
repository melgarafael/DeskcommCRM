import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, expect, it } from "vitest";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const db = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres` });
afterAll(() => db.end());
it("cifra com donos distintos sem expor o helper aos papéis da API", async () => {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("create role oauth_cipher_owner_test nologin nosuperuser");
    await c.query("grant usage on schema public,extensions,private to oauth_cipher_owner_test");
    await c.query("alter function public.fn_encrypt_oauth(text) owner to oauth_cipher_owner_test; alter function public.fn_decrypt_oauth(bytea) owner to oauth_cipher_owner_test");
    await c.query("insert into private.app_secrets(name,value) values('nuvemshop_oauth_key',repeat('k',64)) on conflict(name) do update set value=excluded.value");
    // Controle positivo: sem a correção o chamador privilegiado também falha.
    await c.query("savepoint missing_permission; set local role service_role");
    await expect(c.query("select public.fn_encrypt_oauth('probe')")).rejects.toThrow(/permission denied for function fn_oauth_key/);
    await c.query("rollback to missing_permission; reset role");
    const fix = readFileSync("supabase/migrations/20260917173000_0284_permissoes_cifra_oauth.sql", "utf8");
    await c.query(fix);
    await c.query(fix);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const result = await c.query("select has_function_privilege($1,'private.fn_oauth_key()','execute') allowed", [role]);
      expect(result.rows[0].allowed).toBe(false);
    }
    await c.query("set local role service_role");
    expect((await c.query("select public.fn_decrypt_oauth(public.fn_encrypt_oauth('probe')) value")).rows[0].value).toBe("probe");
  } finally { await c.query("rollback"); c.release(); }
});
