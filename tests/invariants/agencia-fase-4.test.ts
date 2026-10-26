import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, seedGov } from "./gov-helpers";

/**
 * O banco da Fase 4 da agência (migration 9006, docs/agencia/SPEC-trilhas.md):
 * nenhuma tabela nova é alcançável pelo PostgREST, o modelo "Cliente
 * recorrente" nasce com os 20 passos e as funções certas, e as unicidades que o
 * motor da trilha usa valem.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const TABELAS = [
  "agencia_trilha_modelos",
  "agencia_trilha_modelo_passos",
  "agencia_trilhas",
  "agencia_trilha_passos",
  "agencia_avisos_de_trilha",
] as const;

const cliente = randomUUID();

async function como(user: string | null, sql: string): Promise<pg.QueryResult> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(user ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify(user ? { sub: user, role: "authenticated" } : { role: "anon" }),
    ]);
    const r = await c.query(sql);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await seedGov();
  await pool.query("insert into agencia_clientes(id,nome) values ($1,'Cliente F4')", [cliente]);
});

afterAll(async () => {
  await pool.query("delete from agencia_clientes where id = $1", [cliente]);
  await pool.end();
});

describe("nenhuma tabela da fase 4 é alcançável pelo PostgREST", () => {
  it.each(TABELAS)("anon não lê %s", async (t) => {
    await expect(como(null, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
  it.each(TABELAS)("authenticated não lê %s", async (t) => {
    await expect(como(GOV_AGENT_A, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
});

describe("o modelo que nasce pronto", () => {
  it("Cliente recorrente tem 20 passos, só a Apresentação sem dependência", async () => {
    const { rows } = await pool.query<{ chave: string; depende_de: string[] }>(
      `select p.chave, p.depende_de from agencia_trilha_modelo_passos p
         join agencia_trilha_modelos m on m.id = p.modelo_id where m.nome = 'Cliente recorrente'`,
    );
    expect(rows).toHaveLength(20);
    expect(rows.filter((r) => r.depende_de.length === 0).map((r) => r.chave)).toEqual(["apresentacao"]);
    // Toda dependência aponta para um passo que existe no modelo.
    const chaves = new Set(rows.map((r) => r.chave));
    expect(rows.flatMap((r) => r.depende_de).every((c) => chaves.has(c))).toBe(true);
  });

  it("os passos de tarefa com função apontam para as funções que nascem prontas", async () => {
    const { rows } = await pool.query<{ chave: string; funcao: string | null }>(
      `select p.chave, f.nome as funcao from agencia_trilha_modelo_passos p
         left join agencia_funcoes f on f.id = p.funcao_id where p.chave in ('edicao_videos','roteiros','campanha_conversao')`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.chave, r.funcao]))).toEqual({
      edicao_videos: "Editor",
      roteiros: "Roteirista",
      campanha_conversao: "Gestor de tráfego",
    });
  });
});

describe("as regras que moram no banco", () => {
  it("um cliente tem uma trilha ativa por vez", async () => {
    await pool.query("insert into agencia_trilhas(cliente_id, modelo_nome) values ($1,'Cliente recorrente')", [cliente]);
    await expect(
      pool.query("insert into agencia_trilhas(cliente_id, modelo_nome) values ($1,'Cliente recorrente')", [cliente]),
    ).rejects.toThrow(/agencia_trilhas_uma_ativa_por_cliente/);
    // Cancelada não conta: dá para recomeçar.
    await pool.query("update agencia_trilhas set situacao = 'cancelada' where cliente_id = $1", [cliente]);
    await pool.query("insert into agencia_trilhas(cliente_id, modelo_nome) values ($1,'Cliente recorrente')", [cliente]);
  });

  it("a chave do passo é única na trilha e o aviso do relógio sai uma vez", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "select id from agencia_trilhas where cliente_id = $1 and situacao = 'ativa'",
      [cliente],
    );
    const trilha = rows[0]!.id;
    const passo = await pool.query<{ id: string }>(
      "insert into agencia_trilha_passos(trilha_id,chave,titulo,tipo) values ($1,'assinou_pagou','Contrato','marco') returning id",
      [trilha],
    );
    await expect(
      pool.query("insert into agencia_trilha_passos(trilha_id,chave,titulo,tipo) values ($1,'assinou_pagou','X','marco')", [trilha]),
    ).rejects.toThrow(/agencia_trilha_passos_chave/);
    await pool.query("insert into agencia_avisos_de_trilha(passo_id,marco) values ($1,'atrasou')", [passo.rows[0]!.id]);
    await expect(
      pool.query("insert into agencia_avisos_de_trilha(passo_id,marco) values ($1,'atrasou')", [passo.rows[0]!.id]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("chave do modelo só com letras minúsculas, números e _", async () => {
    await expect(
      pool.query(
        "insert into agencia_trilha_modelo_passos(modelo_id,chave,titulo) select id,'Passo X','X' from agencia_trilha_modelos limit 1",
      ),
    ).rejects.toThrow(/agencia_trilha_modelo_passos_chave_formato/);
  });
});
