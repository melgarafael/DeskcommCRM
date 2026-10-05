/**
 * AJUSTAR O RITMO DE UMA CAMPANHA PAUSADA, NUM POSTGRES DE VERDADE — issue #2095.
 *
 * `tests/unit/prospeccao-ajustar-ritmo.test.ts` prova o formato aceito e o texto do
 * `update`. Aqui se prova o que só uma linha de verdade responde:
 *
 * 1. a campanha pausada troca o limite e o intervalo e MANTÉM tudo o mais —
 *    conexão, agente, funil, base legal, instrução. O `||` entre jsonb preserva as
 *    outras chaves por construção, e este caso é o que reprova uma troca por
 *    `set config = $3`;
 * 2. outra organização, mesmo sabendo o id da campanha, não a alcança — e a prova
 *    é feita nos DOIS níveis: pela função (que lê antes de escrever) e pelo
 *    `update` cru (que é onde a organização precisa estar, porque a leitura de
 *    antes pode ser apagada num refactor e o teste da função continuaria verde);
 * 3. campanha rodando e campanha em rascunho não são tocadas.
 *
 * Cada arquivo de invariante recebe um banco novo (`tests/db/banco-limpo-por-arquivo.ts`),
 * então os ids abaixo não colidem com nenhum outro arquivo.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AJUSTE_DE_RITMO_SQL, adjustPace } from "@/lib/prospecting/store";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG_A = "0a120000-0000-4000-8000-000000000001";
const ORG_B = "0a120000-0000-4000-8000-000000000002";
const PAUSADA = "0a120000-1111-4000-8000-000000000001";
const RODANDO = "0a120000-1111-4000-8000-000000000002";
const RASCUNHO = "0a120000-1111-4000-8000-000000000003";
const OUTRA_ORG = "0a120000-1111-4000-8000-000000000004";
const PAUSADA_COM_HORARIO_FUTURO = "0a120000-1111-4000-8000-000000000005";
const PAUSADA_SEM_CONFIG = "0a120000-1111-4000-8000-000000000006";

const CONFIG = {
  agent_id: "0a120000-2222-4000-8000-000000000001",
  channel_session_id: "0a120000-2222-4000-8000-000000000002",
  pipeline_id: "0a120000-2222-4000-8000-000000000003",
  stage_id: "0a120000-2222-4000-8000-000000000004",
  qualified_stage_id: "0a120000-2222-4000-8000-000000000005",
  instruction: "Vender consultoria para clínicas.",
  qualification: "Confirmou a necessidade e a decisão.",
  daily_limit: 10,
  interval_minutes: 5,
  legal_basis_ref: "LIA-teste",
};

async function configDe(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query("select config from prospecting_campaigns where id = $1", [id]);
  return rows[0]?.config ?? null;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name) values
       ($1,'ritmo-a','A','A'), ($2,'ritmo-b','B','B')`,
    [ORG_A, ORG_B],
  );
  const insere = (id: string, org: string, nome: string, status: string, config: unknown) =>
    pool.query(
      `insert into prospecting_campaigns(id,organization_id,request_id,name,search,status,config)
       values ($1,$2,gen_random_uuid(),$3,'{}',$4,$5::jsonb)`,
      [id, org, nome, status, config === null ? null : JSON.stringify(config)],
    );
  await insere(PAUSADA, ORG_A, "pausada", "paused", CONFIG);
  await insere(RODANDO, ORG_A, "rodando", "running", CONFIG);
  await insere(RASCUNHO, ORG_A, "rascunho", "draft", null);
  await insere(OUTRA_ORG, ORG_B, "da outra org", "paused", { ...CONFIG, interval_minutes: 9 });
  await insere(PAUSADA_COM_HORARIO_FUTURO, ORG_A, "pausada com envio agendado", "paused", {
    ...CONFIG,
    interval_minutes: 120,
  });
  await pool.query(
    "update prospecting_campaigns set next_send_at = now() + interval '2 hours' where id = $1",
    [PAUSADA_COM_HORARIO_FUTURO],
  );
  await insere(PAUSADA_SEM_CONFIG, ORG_A, "pausada sem configuração", "paused", null);
});
afterAll(() => pool.end());

describe("ajustar o ritmo de uma campanha pausada", () => {
  it("troca só o limite e o intervalo, e preserva todo o resto da configuração", async () => {
    const resultado = await adjustPace(pool as unknown as pg.Pool, ORG_A, PAUSADA, {
      daily_limit: 7,
      interval_minutes: 20,
    });
    expect(resultado.previous).toEqual({ daily_limit: 10, interval_minutes: 5 });
    expect(resultado.next).toEqual({ daily_limit: 7, interval_minutes: 20 });
    expect(await configDe(PAUSADA)).toEqual({ ...CONFIG, daily_limit: 7, interval_minutes: 20 });
  });

  it("a campanha segue pausada depois do ajuste", async () => {
    const { rows } = await pool.query("select status from prospecting_campaigns where id = $1", [
      PAUSADA,
    ]);
    expect(rows[0]?.status).toBe("paused");
  });
});

describe("a hora do próximo envio acompanha o ritmo novo", () => {
  const proximoEnvioJaVenceu = async (id: string) =>
    (
      await pool.query<{ venceu: boolean }>(
        "select next_send_at <= now() as venceu from prospecting_campaigns where id = $1",
        [id],
      )
    ).rows[0]?.venceu;

  it("baixar o intervalo antecipa o envio que estava agendado com o ritmo velho", async () => {
    expect(await proximoEnvioJaVenceu(PAUSADA_COM_HORARIO_FUTURO)).toBe(false);
    await adjustPace(pool as unknown as pg.Pool, ORG_A, PAUSADA_COM_HORARIO_FUTURO, {
      daily_limit: 10,
      interval_minutes: 15,
    });
    expect(await proximoEnvioJaVenceu(PAUSADA_COM_HORARIO_FUTURO)).toBe(true);
  });

  it("nunca ADIA um envio que já venceu", async () => {
    const antes = (
      await pool.query<{ t: string }>(
        "select next_send_at::text as t from prospecting_campaigns where id = $1",
        [PAUSADA],
      )
    ).rows[0]?.t;
    await adjustPace(pool as unknown as pg.Pool, ORG_A, PAUSADA, {
      daily_limit: 7,
      interval_minutes: 1440,
    });
    const depois = (
      await pool.query<{ t: string }>(
        "select next_send_at::text as t from prospecting_campaigns where id = $1",
        [PAUSADA],
      )
    ).rows[0]?.t;
    expect(antes).toBeDefined();
    expect(depois).toBeDefined();
    expect((depois ?? "") <= (antes ?? "")).toBe(true);
  });
});

describe("quem não pode ajustar não altera nada", () => {
  it("outra organização, com o id certo da campanha, recebe 404 e a linha não muda", async () => {
    const antes = await configDe(PAUSADA);
    await expect(
      adjustPace(pool as unknown as pg.Pool, ORG_B, PAUSADA, {
        daily_limit: 1,
        interval_minutes: 1440,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await configDe(PAUSADA)).toEqual(antes);
  });

  it("o update cru também recusa a organização errada — a guarda não mora só na leitura de antes", async () => {
    const antes = await configDe(PAUSADA);
    const { rows } = await pool.query(AJUSTE_DE_RITMO_SQL, [ORG_B, PAUSADA, 1, 1440]);
    expect(rows).toHaveLength(0);
    expect(await configDe(PAUSADA)).toEqual(antes);
  });

  it("campanha rodando: 409 e a linha não muda", async () => {
    await expect(
      adjustPace(pool as unknown as pg.Pool, ORG_A, RODANDO, {
        daily_limit: 1,
        interval_minutes: 1440,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await configDe(RODANDO)).toEqual(CONFIG);
  });

  it("o update cru também recusa campanha que não está pausada", async () => {
    const { rows } = await pool.query(AJUSTE_DE_RITMO_SQL, [ORG_A, RODANDO, 1, 1440]);
    expect(rows).toHaveLength(0);
    expect(await configDe(RODANDO)).toEqual(CONFIG);
  });

  it("rascunho sem configuração: 409 e a configuração continua nula", async () => {
    await expect(
      adjustPace(pool as unknown as pg.Pool, ORG_A, RASCUNHO, {
        daily_limit: 5,
        interval_minutes: 30,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await configDe(RASCUNHO)).toBeNull();
  });

  it("o update cru recusa campanha pausada SEM configuração — `null || jsonb` apagaria tudo", async () => {
    const { rows } = await pool.query(AJUSTE_DE_RITMO_SQL, [ORG_A, PAUSADA_SEM_CONFIG, 5, 30]);
    expect(rows).toHaveLength(0);
    expect(await configDe(PAUSADA_SEM_CONFIG)).toBeNull();
  });

  it("a campanha da outra organização continua com o ritmo dela", async () => {
    expect((await configDe(OUTRA_ORG))?.interval_minutes).toBe(9);
  });
});
