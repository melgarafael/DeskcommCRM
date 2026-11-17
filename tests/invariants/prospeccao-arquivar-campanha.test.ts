/**
 * ARQUIVAR E DESARQUIVAR UMA CAMPANHA, NUM POSTGRES DE VERDADE — #4359 / #4430.
 *
 * `tests/unit/prospeccao-arquivar-campanha.test.ts` prova o texto dos `update` contra
 * um banco de mentira, que só aplica o que ele próprio imita. Aqui se prova o que só
 * o jsonb de verdade responde:
 *
 * 1. o rascunho que NÃO tinha configuração volta a `null` ao desarquivar — não a
 *    `{}`, que a tela tomaria por configuração gravada (perdendo os padrões);
 * 2. a campanha com configuração volta exatamente igual, e a rodando fica pausada;
 * 3. outra organização, sabendo o id, não alcança a campanha.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { arquivarCampanha, desarquivarCampanha } from "@/lib/prospecting/store";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG_A = "0a130000-0000-4000-8000-000000000001";
const ORG_B = "0a130000-0000-4000-8000-000000000002";
const RASCUNHO = "0a130000-1111-4000-8000-000000000001";
const RODANDO = "0a130000-1111-4000-8000-000000000002";

const CONFIG = {
  agent_id: "0a130000-2222-4000-8000-000000000001",
  channel_session_id: "0a130000-2222-4000-8000-000000000002",
  pipeline_id: "0a130000-2222-4000-8000-000000000003",
  stage_id: "0a130000-2222-4000-8000-000000000004",
  qualified_stage_id: "0a130000-2222-4000-8000-000000000005",
  instruction: "Vender consultoria para clínicas.",
  qualification: "Confirmou a necessidade e a decisão.",
  daily_limit: 10,
  interval_minutes: 5,
  legal_basis_ref: "LIA-teste",
};

const db = pool as unknown as pg.Pool;
async function linha(id: string): Promise<{ status: string; config: Record<string, unknown> | null }> {
  const { rows } = await pool.query("select status, config from prospecting_campaigns where id = $1", [id]);
  return rows[0];
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name) values
       ($1,'arquivar-a','A','A'), ($2,'arquivar-b','B','B')`,
    [ORG_A, ORG_B],
  );
  const insere = (id: string, status: string, config: unknown) =>
    pool.query(
      `insert into prospecting_campaigns(id,organization_id,request_id,name,search,status,config,channel_session_id)
       values ($1,$2,gen_random_uuid(),'arquivar','{}',$3,$4::jsonb,($4::jsonb->>'channel_session_id')::uuid)`,
      [id, ORG_A, status, config === null ? null : JSON.stringify(config)],
    );
  await insere(RASCUNHO, "draft", null);
  await insere(RODANDO, "running", CONFIG);
});
afterAll(() => pool.end());

describe("arquivar e desarquivar num banco de verdade", () => {
  it("rascunho sem configuração volta a null, não a {}", async () => {
    await arquivarCampanha(db, ORG_A, RASCUNHO);
    expect(Object.keys((await linha(RASCUNHO)).config ?? {})).toEqual(["arquivada_em"]);
    await desarquivarCampanha(db, ORG_A, RASCUNHO);
    expect((await linha(RASCUNHO)).config).toBeNull();
  });

  it("campanha rodando fica pausada e volta com a configuração inteira", async () => {
    await arquivarCampanha(db, ORG_A, RODANDO);
    expect((await linha(RODANDO)).status).toBe("paused");
    await desarquivarCampanha(db, ORG_A, RODANDO);
    expect(await linha(RODANDO)).toEqual({ status: "paused", config: CONFIG });
  });

  it("outra organização não arquiva a campanha, mesmo sabendo o id", async () => {
    await expect(arquivarCampanha(db, ORG_B, RASCUNHO)).rejects.toMatchObject({ status: 404 });
    expect((await linha(RASCUNHO)).config).toBeNull();
  });
});
