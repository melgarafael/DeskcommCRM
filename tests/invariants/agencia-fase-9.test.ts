import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, seedGov } from "./gov-helpers";

/**
 * O banco da Fase 9 da agência (migration 9012, docs/agencia/SPEC-ia-da-agencia.md):
 * o registro das execuções da IA fora do alcance do PostgREST, e o catálogo de
 * ações fechado no banco — na tarefa, no bloco e no registro.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
const cliente = randomUUID();
const mapa = randomUUID();
const tarefa = randomUUID();

async function como(user: string | null, sql: string): Promise<pg.QueryResult> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(user ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(user ? { sub: user, role: "authenticated" } : { role: "anon" })]);
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
  await pool.query("insert into agencia_clientes(id,nome) values ($1,'Cliente F9')", [cliente]);
  await pool.query("insert into agencia_mapas(id,cliente_id,titulo) values ($1,$2,'Plano F9')", [mapa, cliente]);
  await pool.query("insert into agencia_tarefas(id,titulo,cliente_id) values ($1,'Roteiros',$2)", [tarefa, cliente]);
});

afterAll(async () => {
  await pool.query("delete from agencia_tarefas where id = $1", [tarefa]);
  await pool.query("delete from agencia_clientes where id = $1", [cliente]);
  await pool.end();
});

describe("o registro da IA não é alcançável pelo PostgREST", () => {
  it("anon e authenticated não leem agencia_execucoes_ia", async () => {
    await expect(como(null, "select * from public.agencia_execucoes_ia limit 1")).rejects.toThrow(/permission denied/);
    await expect(como(GOV_AGENT_A, "select * from public.agencia_execucoes_ia limit 1")).rejects.toThrow(/permission denied/);
  });
});

describe("o catálogo fechado no banco", () => {
  it("tarefa e bloco só aceitam ação do catálogo (ou nenhuma)", async () => {
    await pool.query("update agencia_tarefas set acao_ia = 'roteiro', resultado_ia = 'Cena 1' where id = $1", [tarefa]);
    await pool.query("update agencia_tarefas set acao_ia = null where id = $1", [tarefa]);
    await expect(pool.query("update agencia_tarefas set acao_ia = 'criar_campanha' where id = $1", [tarefa])).rejects.toThrow(/agencia_tarefas_acao_ia/);
    await expect(pool.query("insert into agencia_mapa_blocos(mapa_id,titulo,acao_ia) values ($1,'X','gastar')", [mapa])).rejects.toThrow(/agencia_mapa_blocos_acao_ia/);
  });

  it("o registro aceita propor_mapa e o catálogo, e situação ok/falhou", async () => {
    await pool.query("insert into agencia_execucoes_ia(mapa_id,acao,situacao) values ($1,'propor_mapa','ok')", [mapa]);
    await pool.query("insert into agencia_execucoes_ia(tarefa_id,acao,situacao,erro) values ($1,'legenda','falhou','sem chave')", [tarefa]);
    await expect(pool.query("insert into agencia_execucoes_ia(acao,situacao) values ('outra','ok')")).rejects.toThrow(/agencia_execucoes_ia_acao/);
    await expect(pool.query("insert into agencia_execucoes_ia(acao,situacao) values ('roteiro','rodando')")).rejects.toThrow(/agencia_execucoes_ia_situacao/);
  });

  it("apagar a tarefa ou o mapa preserva o registro (custo e quem pediu)", async () => {
    const t2 = randomUUID();
    await pool.query("insert into agencia_tarefas(id,titulo) values ($1,'Temporária')", [t2]);
    const { rows } = await pool.query<{ id: string }>("insert into agencia_execucoes_ia(tarefa_id,acao,situacao) values ($1,'ideias','ok') returning id", [t2]);
    await pool.query("delete from agencia_tarefas where id = $1", [t2]);
    const { rows: depois } = await pool.query<{ tarefa_id: string | null }>("select tarefa_id from agencia_execucoes_ia where id = $1", [rows[0]!.id]);
    expect(depois).toEqual([{ tarefa_id: null }]);
  });
});
