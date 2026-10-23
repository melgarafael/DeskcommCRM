import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, seedGov } from "./gov-helpers";

/**
 * O isolamento da área da agência no BANCO (migration 9003,
 * docs/agencia/SPEC-equipe.md e SPEC-avisos.md).
 *
 * As tabelas `agencia_*` são da instalação, sem organization_id: o isolamento
 * não é entre tenants, é entre a agência e todo o resto. anon não alcança nada;
 * authenticated só lê e marca como lido o próprio aviso.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const TABELAS = [
  "agencia_funcoes",
  "agencia_membros",
  "agencia_membros_funcoes",
  "agencia_convites",
  "agencia_config",
  "agencia_envios_whatsapp",
  "agencia_avisos",
] as const;

const membroA = randomUUID();
const membroB = randomUUID();
const avisoA = randomUUID();
const avisoB = randomUUID();

async function como<T extends pg.QueryResultRow>(
  user: string | null,
  sql: string,
  args: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(user ? "set local role authenticated" : "set local role anon");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify(user ? { sub: user, role: "authenticated" } : { role: "anon" }),
    ]);
    const r = await client.query<T>(sql, args);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await seedGov();
  await pool.query(
    `insert into agencia_membros(id,user_id,nome,whatsapp,email,situacao)
     values ($1,$2,'Membro A','+5511900000001',$3,'ativo'),
            ($4,$5,'Membro B','+5511900000002',$6,'ativo')`,
    [membroA, GOV_AGENT_A, `a-${membroA}@agencia.test`, membroB, GOV_AGENT_B, `b-${membroB}@agencia.test`],
  );
  await pool.query(
    `insert into agencia_avisos(id,membro_id,tipo,titulo) values ($1,$2,'teste','Aviso A'),($3,$4,'teste','Aviso B')`,
    [avisoA, membroA, avisoB, membroB],
  );
});

afterAll(async () => {
  await pool.query("delete from agencia_membros where id = any($1)", [[membroA, membroB]]);
  await pool.end();
});

describe("anon", () => {
  it.each(TABELAS)("não lê %s", async (tabela) => {
    await expect(como(null, `select * from public.${tabela} limit 1`)).rejects.toThrow(/permission denied/);
  });

  it("não executa fn_agencia_membro_atual", async () => {
    const { rows } = await pool.query<{ pode: boolean }>(
      "select has_function_privilege('anon','public.fn_agencia_membro_atual()','execute') as pode",
    );
    expect(rows[0]?.pode).toBe(false);
  });
});

describe("authenticated", () => {
  it.each(TABELAS.filter((t) => t !== "agencia_avisos"))("não lê %s", async (tabela) => {
    await expect(como(GOV_AGENT_A, `select * from public.${tabela} limit 1`)).rejects.toThrow(/permission denied/);
  });

  it("lê só os próprios avisos", async () => {
    const { rows } = await como<{ id: string }>(GOV_AGENT_A, "select id from public.agencia_avisos");
    expect(rows.map((r) => r.id)).toEqual([avisoA]);
  });

  it("não marca como lido o aviso de outro membro", async () => {
    const r = await como(GOV_AGENT_A, "update public.agencia_avisos set lido_em = now() where id = $1", [avisoB]);
    expect(r.rowCount).toBe(0);
  });

  it("marca o próprio como lido, mas não muda outra coluna", async () => {
    const r = await como(GOV_AGENT_A, "update public.agencia_avisos set lido_em = now() where id = $1", [avisoA]);
    expect(r.rowCount).toBe(1);
    await expect(
      como(GOV_AGENT_A, "update public.agencia_avisos set titulo = 'x' where id = $1", [avisoA]),
    ).rejects.toThrow(/permission denied/);
  });

  it("não cria aviso", async () => {
    await expect(
      como(GOV_AGENT_A, "insert into public.agencia_avisos(membro_id,tipo,titulo) values ($1,'teste','x')", [membroA]),
    ).rejects.toThrow(/permission denied/);
  });

  it("membro desativado deixa de ver os próprios avisos", async () => {
    await pool.query("update agencia_membros set situacao = 'desativado' where id = $1", [membroA]);
    try {
      const { rows } = await como(GOV_AGENT_A, "select id from public.agencia_avisos");
      expect(rows).toEqual([]);
    } finally {
      await pool.query("update agencia_membros set situacao = 'ativo' where id = $1", [membroA]);
    }
  });
});

describe("schema", () => {
  it("nasce com as sete funções da equipe", async () => {
    const { rows } = await pool.query<{ nome: string }>("select nome from agencia_funcoes order by ordem");
    expect(rows.map((r) => r.nome)).toEqual([
      "Roteirista",
      "Videomaker",
      "Editor",
      "Designer",
      "Social media",
      "Gestor de tráfego",
      "Programador",
    ]);
  });

  it("tem uma linha de configuração, e só uma", async () => {
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from agencia_config");
    expect(rows[0]?.n).toBe(1);
    await expect(pool.query("insert into agencia_config(id) values (false)")).rejects.toThrow();
  });
});
