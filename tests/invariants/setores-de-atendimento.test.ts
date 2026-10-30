import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  seedGov,
  GOV_ORG as org,
  GOV_AGENT_A as ana,
  GOV_AGENT_B as bruno,
  GOV_MANAGER as manager,
} from "./gov-helpers";

/**
 * Setores de atendimento (migration 0801) — o que o BANCO segura, sem depender
 * das rotas:
 *
 *   - `authenticated` só LÊ: nem o manager escreve direto pela REST (a escrita
 *     é das rotas, que exigem manager e auditam). Um atendente que pudesse
 *     gravar o vínculo se mudaria de setor com a anon key.
 *   - leitura isolada por organização, com controle positivo;
 *   - nome único por organização sem diferenciar caixa nem espaço;
 *   - um setor por atendente (PK org+user) e setor de OUTRA org recusado pela
 *     FK composta;
 *   - apagar o setor solta os atendentes (o vínculo some, a filiação não).
 */
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 3,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const OUTRA_ORG = "dddddddd-0000-4000-8000-000000000767";
const OUTRO_USER = "dddddddd-1111-4000-8000-000000000767";

async function asUser(user: string, text: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user })]);
    const result = await c.query(text, args);
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

async function criarSetor(organizationId: string, name: string): Promise<string> {
  const r = await query(
    "insert into attendant_sectors(organization_id,name) values($1,$2) returning id",
    [organizationId, name],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  seedGov();
  await query(
    "insert into auth.users(id,email) values($1,'setor-outra@invariant.test') on conflict(id) do nothing",
    [OUTRO_USER],
  );
  await query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,'setor-outra-0801','Setor Outra','Setor Outra') on conflict(id) do nothing",
    [OUTRA_ORG],
  );
  await query(
    "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now()) on conflict do nothing",
    [OUTRO_USER, OUTRA_ORG],
  );
});
afterAll(async () => {
  await query("delete from attendant_sectors where organization_id = any($1)", [[org, OUTRA_ORG]]);
  await pool.end();
});
beforeEach(async () => {
  await query("delete from attendant_sectors where organization_id = any($1)", [[org, OUTRA_ORG]]);
});

describe("setores de atendimento (0801)", () => {
  it("cada org lê só os próprios setores e vínculos (com controle positivo)", async () => {
    const suporte = await criarSetor(org, "Suporte");
    await criarSetor(OUTRA_ORG, "Comercial");
    await query("insert into attendant_sector_members(organization_id,sector_id,user_id) values($1,$2,$3)", [org, suporte, ana]);

    const daAna = await asUser(ana, "select organization_id from attendant_sectors");
    expect(daAna.rows.map((r) => r.organization_id)).toEqual([org]);
    const vinculosDaAna = await asUser(ana, "select count(*)::int n from attendant_sector_members");
    expect(vinculosDaAna.rows[0].n).toBe(1);

    const daOutra = await asUser(OUTRO_USER, "select organization_id from attendant_sectors");
    expect(daOutra.rows.map((r) => r.organization_id)).toEqual([OUTRA_ORG]);
    const vinculosDaOutra = await asUser(OUTRO_USER, "select count(*)::int n from attendant_sector_members");
    expect(vinculosDaOutra.rows[0].n).toBe(0);
  });

  it("authenticated não escreve — nem o manager, nem o atendente sobre si mesmo", async () => {
    const suporte = await criarSetor(org, "Suporte");
    await expect(
      asUser(manager, "insert into attendant_sectors(organization_id,name) values($1,'Financeiro')", [org]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(ana, "insert into attendant_sector_members(organization_id,sector_id,user_id) values($1,$2,$3)", [org, suporte, ana]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(manager, "delete from attendant_sectors where id=$1", [suporte]),
    ).rejects.toThrow(/permission denied/);
  });

  it("nome é único por org sem diferenciar caixa e espaço; outra org pode repetir", async () => {
    await criarSetor(org, "Suporte");
    await expect(criarSetor(org, "  suporte ")).rejects.toMatchObject({ code: "23505" });
    await expect(criarSetor(OUTRA_ORG, "Suporte")).resolves.toBeTypeOf("string");
  });

  it("nome vazio é recusado pelo CHECK", async () => {
    await expect(criarSetor(org, "   ")).rejects.toMatchObject({ code: "23514" });
  });

  it("um setor por atendente, e setor de outra org é recusado pela FK composta", async () => {
    const suporte = await criarSetor(org, "Suporte");
    const comercial = await criarSetor(org, "Comercial");
    const deFora = await criarSetor(OUTRA_ORG, "Financeiro");

    await query("insert into attendant_sector_members(organization_id,sector_id,user_id) values($1,$2,$3)", [org, suporte, ana]);
    await expect(
      query("insert into attendant_sector_members(organization_id,sector_id,user_id) values($1,$2,$3)", [org, comercial, ana]),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      query("insert into attendant_sector_members(organization_id,sector_id,user_id) values($1,$2,$3)", [org, deFora, bruno]),
    ).rejects.toMatchObject({ code: "23503" });
    // Usuário que não é membro da org também não entra.
    await expect(
      query("insert into attendant_sector_members(organization_id,sector_id,user_id) values($1,$2,$3)", [org, suporte, OUTRO_USER]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("apagar o setor solta os atendentes e preserva a filiação", async () => {
    const suporte = await criarSetor(org, "Suporte");
    await query("insert into attendant_sector_members(organization_id,sector_id,user_id) values($1,$2,$3),($1,$2,$4)", [org, suporte, ana, bruno]);
    await query("delete from attendant_sectors where id=$1", [suporte]);

    const vinculos = await query("select count(*)::int n from attendant_sector_members where organization_id=$1", [org]);
    expect(vinculos.rows[0].n).toBe(0);
    const filiacoes = await query(
      "select count(*)::int n from user_organizations where organization_id=$1 and user_id = any($2)",
      [org, [ana, bruno]],
    );
    expect(filiacoes.rows[0].n).toBe(2);
  });
});
