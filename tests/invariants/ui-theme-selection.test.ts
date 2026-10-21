import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Use pnpm test:db");
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DB_URL ??
    `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const org = randomUUID(),
  other = randomUUID(),
  admin = randomUUID(),
  reader = randomUUID();
const catalog = "a".repeat(64);
beforeAll(async () => {
  for (const id of [org, other])
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name,settings) values($1::uuid,$1::text,'Teste','Teste',$2)",
      [id, { branding: { accent_hex: "#123456" }, retained: true }],
    );
  for (const id of [admin, reader])
    await pool.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.test`]);
  await pool.query(
    "insert into user_organizations(user_id,organization_id,role) values($1,$2,'admin'),($3,$2,'viewer')",
    [admin, org, reader],
  );
});
beforeEach(async () => {
  await pool.query("delete from organization_ui_themes where organization_id in($1,$2)", [
    org,
    other,
  ]);
  await pool.query("insert into organization_ui_themes(organization_id) values($1)", [other]);
  await pool.query(
    "update user_organizations set revoked_at=null,role='admin' where user_id=$1 and organization_id=$2",
    [admin, org],
  );
});
afterAll(() => pool.end());
async function apply(
  args: {
    actor?: string;
    tenant?: string;
    revision?: number;
    request?: string;
    theme?: string;
    values?: unknown;
  } = {},
) {
  const result = await pool.query(
    "select fn_ui_theme_apply($1,$2,$3,'demo-install-1',$4,1,$5,$6,$7) result",
    [
      args.tenant ?? org,
      args.actor ?? admin,
      args.theme ?? "demo",
      catalog,
      args.values ?? { "global.spacing": "wide" },
      args.revision ?? 0,
      args.request ?? randomUUID(),
    ],
  );
  return result.rows[0].result;
}
describe("seleção de apresentação scoped e revalidada", () => {
  it("seleção, revisão e auditoria commitam juntas sem regravar marca/settings", async () => {
    const before = (await pool.query("select settings from organizations where id=$1", [org]))
      .rows[0].settings;
    const request = randomUUID();
    expect(await apply({ request })).toEqual({ revision: 1, applied_now: true });
    const row = (
      await pool.query(
        "select theme_id,revision,configurations,updated_by from organization_ui_themes where organization_id=$1",
        [org],
      )
    ).rows[0];
    expect(row).toMatchObject({
      theme_id: "demo",
      revision: 1,
      updated_by: admin,
      configurations: { demo: { version: 1, values: { "global.spacing": "wide" } } },
    });
    expect(
      (await pool.query("select settings from organizations where id=$1", [org])).rows[0].settings,
    ).toEqual(before);
    const audit = (
      await pool.query(
        "select action,actor_user_id,metadata from api_audit_log where organization_id=$1 and action='ui_theme.updated' and request_id=$2",
        [org, request],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: admin,
      metadata: { theme_id: "demo", revision: 1 },
    });
    expect(audit[0].metadata).not.toHaveProperty("values");
  });
  it("repetir o mesmo pedido não incrementa revisão e conteúdo diferente conflita", async () => {
    const request = randomUUID();
    await apply({ request });
    expect(await apply({ request })).toEqual({ revision: 1, applied_now: false });
    await expect(apply({ request, values: { "global.spacing": "normal" } })).rejects.toMatchObject({
      code: "PT409",
    });
    expect(
      (
        await pool.query(
          "select count(*)::int n from api_audit_log where organization_id=$1 and action='ui_theme.updated' and request_id=$2",
          [org, request],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("duas abas com mesma revisão têm uma única vencedora", async () => {
    const results = await Promise.allSettled([
      apply(),
      apply({ values: { "global.spacing": "normal" } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected");
    expect(failure).toMatchObject({ reason: { code: "PT409" } });
    expect(
      (
        await pool.query("select revision from organization_ui_themes where organization_id=$1", [
          org,
        ])
      ).rows[0].revision,
    ).toBe(1);
  });
  it("voltar ao Padrão conserva opções do outro tema", async () => {
    await apply();
    await apply({ revision: 1, theme: "padrao", values: {} });
    expect(
      (
        await pool.query(
          "select theme_id,configurations from organization_ui_themes where organization_id=$1",
          [org],
        )
      ).rows[0],
    ).toMatchObject({
      theme_id: "padrao",
      configurations: { demo: { version: 1, values: { "global.spacing": "wide" } } },
    });
  });
  it("viewer, outra organização e papel revogado não gravam nem repetem recibo", async () => {
    await expect(apply({ actor: reader })).rejects.toMatchObject({ code: "42501" });
    await expect(apply({ tenant: other })).rejects.toMatchObject({ code: "42501" });
    const request = randomUUID();
    await apply({ request });
    await pool.query(
      "update user_organizations set revoked_at=now() where user_id=$1 and organization_id=$2",
      [admin, org],
    );
    await expect(apply({ request })).rejects.toMatchObject({ code: "42501" });
  });
  it("leitura authenticated vê só sua organização e não tem escrita direta/RPC", async () => {
    await apply();
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: reader, role: "authenticated" }),
      ]);
      expect((await db.query("select organization_id from organization_ui_themes")).rows).toEqual([
        { organization_id: org },
      ]);
      await expect(
        db.query("update organization_ui_themes set theme_id='padrao' where organization_id=$1", [
          org,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback");
      db.release();
    }
    for (const role of ["anon", "authenticated"]) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(`set local role ${role}`);
        await expect(
          client.query("select fn_ui_theme_apply($1,$2,'demo','demo-install-1',$3,1,'{}',0,$4)", [
            org,
            admin,
            catalog,
            randomUUID(),
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("rollback");
        client.release();
      }
    }
  });
  it("nested data e nome malformado são recusados sem deixar estado parcial", async () => {
    await expect(apply({ values: { "global.spacing": { hidden: true } } })).rejects.toMatchObject({
      code: "22023",
    });
    await expect(apply({ theme: "<script>" })).rejects.toMatchObject({ code: "22023" });
    expect(
      (await pool.query("select * from organization_ui_themes where organization_id=$1", [org]))
        .rowCount,
    ).toBe(0);
  });
  it("revogação enquanto a gravação espera outra transação é relida antes de escrever", async () => {
    const holder = await pool.connect();
    await holder.query("begin");
    await holder.query("select id from organizations where id=$1 for update", [org]);
    const pending = apply();
    let released = false;
    try {
      const deadline = Date.now() + 2000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (
          await pool.query(
            "select exists(select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and query like 'select fn_ui_theme_apply(%' and wait_event_type='Lock') present",
          )
        ).rows[0].present;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await pool.query(
        "update user_organizations set revoked_at=clock_timestamp() where user_id=$1 and organization_id=$2",
        [admin, org],
      );
      await holder.query("rollback");
      released = true;
      await expect(pending).rejects.toMatchObject({ code: "42501" });
      expect(
        (await pool.query("select * from organization_ui_themes where organization_id=$1", [org]))
          .rowCount,
      ).toBe(0);
    } finally {
      if (!released) await holder.query("rollback");
      await pending.catch(() => {});
      holder.release();
    }
  });
});
