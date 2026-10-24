import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, seedGov } from "./gov-helpers";

/**
 * O banco da Fase 3 da agência (migration 9005, docs/agencia/SPEC-calendario.md):
 * nenhuma tabela nova é alcançável pelo PostgREST, a reunião não termina antes de
 * começar, cada lembrete sai uma vez e o vocabulário fechado é do banco.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const TABELAS = [
  "agencia_reunioes",
  "agencia_reunioes_membros",
  "agencia_reunioes_convidados",
  "agencia_lembretes_de_reuniao",
] as const;

const reuniao = randomUUID();

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
  await pool.query(
    "insert into agencia_reunioes(id,tipo,titulo,inicio,fim) values ($1,'apresentacao','Apresentação',now() + interval '1 day',now() + interval '1 day 1 hour')",
    [reuniao],
  );
});

afterAll(async () => {
  await pool.query("delete from agencia_reunioes where id = $1", [reuniao]);
  await pool.end();
});

describe("nenhuma tabela da fase 3 é alcançável pelo PostgREST", () => {
  it.each(TABELAS)("anon não lê %s", async (t) => {
    await expect(como(null, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
  it.each(TABELAS)("authenticated não lê %s", async (t) => {
    await expect(como(GOV_AGENT_A, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
});

describe("as regras que moram no banco", () => {
  it("a reunião termina depois de começar", async () => {
    await expect(
      pool.query("insert into agencia_reunioes(tipo,titulo,inicio,fim) values ('interna','X',now(),now())"),
    ).rejects.toThrow(/agencia_reunioes_horario/);
  });

  it("tipo, formato e situação são fechados", async () => {
    await expect(
      pool.query("insert into agencia_reunioes(tipo,titulo,inicio,fim) values ('festa','X',now(),now() + interval '1 hour')"),
    ).rejects.toThrow(/agencia_reunioes_tipo/);
    await expect(pool.query("update agencia_reunioes set situacao = 'adiada' where id = $1", [reuniao])).rejects.toThrow(
      /agencia_reunioes_situacao/,
    );
  });

  it("cada marco de lembrete sai uma vez", async () => {
    await pool.query("insert into agencia_lembretes_de_reuniao(reuniao_id,marco) values ($1,'1440')", [reuniao]);
    await expect(
      pool.query("insert into agencia_lembretes_de_reuniao(reuniao_id,marco) values ($1,'1440')", [reuniao]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("os lembretes nascem 1 dia e 1 hora antes, e só aceitam os marcos da tela", async () => {
    const { rows } = await pool.query<{ l: number[] }>("select reunioes_lembretes as l from agencia_config where id");
    expect(rows[0]?.l).toEqual([1440, 60]);
    await expect(pool.query("update agencia_config set reunioes_lembretes = '{7}' where id")).rejects.toThrow(
      /agencia_config_lembretes/,
    );
  });

  it("o WhatsApp da agência aceita o motivo reuniao", async () => {
    const id = randomUUID();
    await pool.query("insert into agencia_envios_whatsapp(id,motivo,telefone,corpo) values ($1,'reuniao','+5511900000001','oi')", [id]);
    await pool.query("delete from agencia_envios_whatsapp where id = $1", [id]);
  });
});
