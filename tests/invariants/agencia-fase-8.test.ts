import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, seedGov } from "./gov-helpers";

/**
 * O banco da Fase 8 da agência (migration 9010, docs/agencia/SPEC-mapa-mental.md):
 * mapas, blocos e setas inalcançáveis pelo PostgREST; seta não aponta para o
 * próprio bloco e não se repete; cor e situação fechadas. E as publicações da
 * 8b (migration 9011, SPEC-publicacoes): mesma reclusão, vocabulário fechado,
 * mídia só https, e a aprovação aponta para a publicação.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
const TABELAS = ["agencia_mapas", "agencia_mapa_blocos", "agencia_mapa_ligacoes", "agencia_publicacoes"] as const;
const publicacao = randomUUID();
const cliente = randomUUID();
const mapa = randomUUID();
const a = randomUUID();
const b = randomUUID();

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
  await pool.query("insert into agencia_clientes(id,nome) values ($1,'Cliente F8')", [cliente]);
  await pool.query("insert into agencia_mapas(id,cliente_id,titulo) values ($1,$2,'Plano de novembro')", [mapa, cliente]);
  await pool.query("insert into agencia_mapa_blocos(id,mapa_id,titulo) values ($1,$3,'Roteiros'),($2,$3,'Gravação')", [a, b, mapa]);
});

afterAll(async () => {
  await pool.query("delete from agencia_clientes where id = $1", [cliente]);
  await pool.end();
});

describe("nenhuma tabela da fase 8 é alcançável pelo PostgREST", () => {
  it.each(TABELAS)("anon não lê %s", async (t) => {
    await expect(como(null, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
  it.each(TABELAS)("authenticated não lê %s", async (t) => {
    await expect(como(GOV_AGENT_A, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
});

describe("as regras que moram no banco", () => {
  it("seta não aponta para o próprio bloco nem se repete", async () => {
    await pool.query("insert into agencia_mapa_ligacoes(mapa_id,de_id,para_id) values ($1,$2,$3)", [mapa, a, b]);
    await expect(pool.query("insert into agencia_mapa_ligacoes(mapa_id,de_id,para_id) values ($1,$2,$3)", [mapa, a, b])).rejects.toThrow(/duplicate key/);
    await expect(pool.query("insert into agencia_mapa_ligacoes(mapa_id,de_id,para_id) values ($1,$2,$2)", [mapa, a])).rejects.toThrow(/agencia_mapa_ligacoes_sem_laco/);
  });

  it("apagar o bloco leva as setas dele", async () => {
    await pool.query("delete from agencia_mapa_blocos where id = $1", [a]);
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from agencia_mapa_ligacoes where mapa_id = $1", [mapa]);
    expect(rows[0]?.n).toBe(0);
  });

  it("cor e situação fechadas", async () => {
    await expect(pool.query("update agencia_mapa_blocos set cor = 'azul' where id = $1", [b])).rejects.toThrow(/agencia_mapa_blocos_cor/);
    await expect(pool.query("update agencia_mapas set situacao = 'pronto' where id = $1", [mapa])).rejects.toThrow(/agencia_mapas_situacao/);
  });
});

describe("publicações (8b)", () => {
  it("nasce rascunho, sem publicar sozinho", async () => {
    const { rows } = await pool.query<{ situacao: string; auto_publicar: boolean }>(
      "insert into agencia_publicacoes(id,cliente_id,titulo,quando) values ($1,$2,'Reels da promoção',now() + interval '1 day') returning situacao, auto_publicar",
      [publicacao, cliente],
    );
    expect(rows[0]).toEqual({ situacao: "rascunho", auto_publicar: false });
  });

  it("rede, formato e situação fechadas; mídia e post só https", async () => {
    await expect(pool.query("update agencia_publicacoes set rede = 'orkut' where id = $1", [publicacao])).rejects.toThrow(/agencia_publicacoes_rede/);
    await expect(pool.query("update agencia_publicacoes set formato = 'live' where id = $1", [publicacao])).rejects.toThrow(/agencia_publicacoes_formato/);
    await expect(pool.query("update agencia_publicacoes set situacao = 'pronta' where id = $1", [publicacao])).rejects.toThrow(/agencia_publicacoes_situacao/);
    await expect(pool.query("update agencia_publicacoes set midia_url = 'http://x/a.jpg' where id = $1", [publicacao])).rejects.toThrow(/agencia_publicacoes_midia/);
    await expect(pool.query("update agencia_publicacoes set post_url = 'javascript:alert(1)' where id = $1", [publicacao])).rejects.toThrow(/agencia_publicacoes_post_url/);
  });

  it("a aprovação aponta para a publicação, e apagar a publicação não apaga a aprovação", async () => {
    const { rows: col } = await pool.query("select 1 from information_schema.columns where table_name = 'agencia_aprovacoes' and column_name = 'publicacao_id'");
    expect(col).toHaveLength(1);
    const { rows } = await pool.query<{ confdeltype: string }>(
      "select confdeltype from pg_constraint where conrelid = 'public.agencia_aprovacoes'::regclass and confrelid = 'public.agencia_publicacoes'::regclass",
    );
    expect(rows.map((x) => x.confdeltype)).toEqual(["n"]);
  });

  it("apagar o cliente leva as publicações dele", async () => {
    const outro = randomUUID();
    await pool.query("insert into agencia_clientes(id,nome) values ($1,'Cliente F8b')", [outro]);
    await pool.query("insert into agencia_publicacoes(cliente_id,titulo,quando) values ($1,'Post',now())", [outro]);
    await pool.query("delete from agencia_clientes where id = $1", [outro]);
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from agencia_publicacoes where cliente_id = $1", [outro]);
    expect(rows[0]?.n).toBe(0);
  });
});
