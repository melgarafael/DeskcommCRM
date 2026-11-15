import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * APARÊNCIA DA ORGANIZAÇÃO (migration 9388) — `fn_definir_aparencia_da_organizacao`.
 *
 * Invariante de banco porque quem decide é o banco: a função confere papel,
 * suporte e segundo fator pelo `auth.uid()` e grava só a chave `aparencia` de
 * `organizations.settings`. Um dublê de `supabase` provaria só que o dublê
 * concorda comigo. As permissões vêm EM PAR (quem passa e quem é barrado).
 *
 *   A1  admin da própria organização grava, e a marca (`settings.branding`)
 *       e as outras chaves de `settings` ficam intactas
 *   A2  `null` e `{}` removem a chave — a organização volta à aparência de fábrica
 *   A3  gerente, atendente, observador e admin de OUTRA organização são barrados
 *   A4  sessão com fator verificado mas sem prova (aal1) é barrada; com aal2 passa
 *   A5  forma: chave desconhecida, valor não-texto, valor fora do formato e cor
 *       que não é `#rrggbb` são recusados com 22023, sem gravar nada
 *   A6  sem sessão (anon) nem chega a executar
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 5,
});

const ORG_A = "a9a40000-0000-4000-8000-000000000001";
const ORG_B = "a9a40000-0000-4000-8000-000000000002";
const ADMIN_A = "a9a41111-0000-4000-8000-000000000001";
const MANAGER_A = "a9a41111-0000-4000-8000-000000000002";
const AGENT_A = "a9a41111-0000-4000-8000-000000000003";
const VIEWER_A = "a9a41111-0000-4000-8000-000000000004";
const ADMIN_B = "a9a41111-0000-4000-8000-000000000005";

const RPC = "select fn_definir_aparencia_da_organizacao($1, $2::jsonb) as r";

type Resultado = { aparencia: Record<string, string> | null; mudou: boolean };

async function comoUsuario(
  uid: string | null,
  org: string,
  aparencia: unknown,
  aal: "aal1" | "aal2" = "aal2",
): Promise<Resultado> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
    const claims = uid ? { sub: uid, role: "authenticated", aal } : { role: "anon" };
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const r = await c.query<{ r: Resultado }>(RPC, [org, aparencia === null ? null : JSON.stringify(aparencia)]);
    await c.query("commit");
    return r.rows[0]!.r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function settingsDe(org: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{ s: Record<string, unknown> | null }>(
    "select settings as s from organizations where id = $1",
    [org],
  );
  return rows[0]!.s ?? {};
}

beforeAll(async () => {
  for (const u of [ADMIN_A, MANAGER_A, AGENT_A, VIEWER_A, ADMIN_B]) {
    await pool.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [
      u,
      `${u}@aparencia.test`,
    ]);
  }
  for (const [org, slug] of [
    [ORG_A, "aparencia-a"],
    [ORG_B, "aparencia-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name, settings)
       values ($1, $2, 'Aparência LTDA', 'Aparência',
               '{"branding": {"accent_hex": "#123456", "logo_path": "x/logo.png"}, "crm": {"cliente_pela_agenda": true}}'::jsonb)
       on conflict (id) do nothing`,
      [org, slug],
    );
  }
  for (const [u, org, papel] of [
    [ADMIN_A, ORG_A, "admin"],
    [MANAGER_A, ORG_A, "manager"],
    [AGENT_A, ORG_A, "agent"],
    [VIEWER_A, ORG_A, "viewer"],
    [ADMIN_B, ORG_B, "admin"],
  ] as const) {
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role, accepted_at)
       values ($1, $2, $3, now()) on conflict do nothing`,
      [u, org, papel],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

describe("fn_definir_aparencia_da_organizacao", () => {
  it("A1 · o admin grava só a chave `aparencia`; marca e outras chaves ficam intactas", async () => {
    const r = await comoUsuario(ADMIN_A, ORG_A, { template: "aurora", raio: "arredondado" });
    expect(r).toEqual({ aparencia: { template: "aurora", raio: "arredondado" }, mudou: true });

    const s = await settingsDe(ORG_A);
    expect(s.aparencia).toEqual({ template: "aurora", raio: "arredondado" });
    expect(s.branding).toEqual({ accent_hex: "#123456", logo_path: "x/logo.png" });
    expect(s.crm).toEqual({ cliente_pela_agenda: true });

    const deNovo = await comoUsuario(ADMIN_A, ORG_A, { template: "aurora", raio: "arredondado" });
    expect(deNovo.mudou, "gravar o mesmo valor não é mudança").toBe(false);
  });

  it("A2 · `null` e `{}` removem a chave e voltam à aparência de fábrica", async () => {
    await comoUsuario(ADMIN_A, ORG_A, { template: "safira" });
    const r = await comoUsuario(ADMIN_A, ORG_A, null);
    expect(r).toEqual({ aparencia: null, mudou: true });
    expect("aparencia" in (await settingsDe(ORG_A))).toBe(false);

    await comoUsuario(ADMIN_A, ORG_A, { template: "safira" });
    await comoUsuario(ADMIN_A, ORG_A, {});
    expect("aparencia" in (await settingsDe(ORG_A))).toBe(false);
    expect((await settingsDe(ORG_A)).branding, "a marca sobrevive à limpeza").toEqual({
      accent_hex: "#123456",
      logo_path: "x/logo.png",
    });
  });

  it("A3 · gerente, atendente, observador e admin de outra organização são barrados", async () => {
    await comoUsuario(ADMIN_A, ORG_A, { template: "carbono" });
    for (const uid of [MANAGER_A, AGENT_A, VIEWER_A, ADMIN_B]) {
      await expect(comoUsuario(uid, ORG_A, { template: "neon" }), uid).rejects.toMatchObject({
        code: "42501",
      });
    }
    expect((await settingsDe(ORG_A)).aparencia).toEqual({ template: "carbono" });
  });

  it("A4 · fator verificado sem prova na sessão (aal1) é barrado; com aal2 passa", async () => {
    const fator = randomUUID();
    await pool.query(
      "insert into auth.mfa_factors (id, user_id, status, factor_type) values ($1, $2, 'verified', 'totp')",
      [fator, ADMIN_A],
    );
    try {
      await expect(comoUsuario(ADMIN_A, ORG_A, { template: "lavanda" }, "aal1")).rejects.toMatchObject({
        code: "42501",
        message: expect.stringContaining("mfa_required"),
      });
      const r = await comoUsuario(ADMIN_A, ORG_A, { template: "lavanda" }, "aal2");
      expect(r.aparencia).toEqual({ template: "lavanda" });
    } finally {
      await pool.query("delete from auth.mfa_factors where id = $1", [fator]);
    }
  });

  it("A5 · forma errada é recusada com 22023 e não grava nada", async () => {
    await comoUsuario(ADMIN_A, ORG_A, { template: "vinho" });
    for (const lixo of [
      { template: "vinho", estilo: "body{display:none}" },
      { template: 7 },
      { template: "Vinho Tinto" },
      { template: "x".repeat(40) },
      { cor_secundaria: "red" },
      { cor_secundaria: "#ABCDEF" },
      ["template", "vinho"],
      "vinho",
    ]) {
      await expect(comoUsuario(ADMIN_A, ORG_A, lixo), JSON.stringify(lixo)).rejects.toMatchObject({
        code: "22023",
      });
    }
    expect((await settingsDe(ORG_A)).aparencia).toEqual({ template: "vinho" });
  });

  it("A6 · sem sessão (anon) não executa", async () => {
    await expect(comoUsuario(null, ORG_A, { template: "aurora" })).rejects.toMatchObject({ code: "42501" });
  });
});
