import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, seedGov } from "./gov-helpers";

/**
 * O banco da Fase 5 da agência (migration 9007, docs/agencia/SPEC-cofre-e-formulario.md):
 * cofre e formulário inalcançáveis pelo PostgREST, senha só inteira (ct+iv+tag) ou
 * ausente, token do formulário único, motivo `formulario` aceito no WhatsApp.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const TABELAS = ["agencia_formularios", "agencia_cofre_itens", "agencia_cofre_visualizacoes"] as const;
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
  await pool.query("insert into agencia_clientes(id,nome) values ($1,'Cliente F5')", [cliente]);
});

afterAll(async () => {
  await pool.query("delete from agencia_clientes where id = $1", [cliente]);
  await pool.end();
});

describe("nenhuma tabela da fase 5 é alcançável pelo PostgREST", () => {
  it.each(TABELAS)("anon não lê %s", async (t) => {
    await expect(como(null, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
  it.each(TABELAS)("authenticated não lê %s", async (t) => {
    await expect(como(GOV_AGENT_A, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
});

describe("as regras que moram no banco", () => {
  it("senha só inteira (ct, iv e tag) ou nenhuma", async () => {
    await pool.query("insert into agencia_cofre_itens(cliente_id,plataforma,rotulo,login) values ($1,'site','Site','admin')", [cliente]);
    await expect(
      pool.query("insert into agencia_cofre_itens(cliente_id,plataforma,rotulo,senha_ct) values ($1,'x','X','\\x00')", [cliente]),
    ).rejects.toThrow(/agencia_cofre_itens_senha_inteira/);
  });

  it("o token do formulário é único e a situação é fechada", async () => {
    const hash = randomUUID();
    await pool.query("insert into agencia_formularios(cliente_id,token_hash,expira_em) values ($1,$2,now() + interval '72 hours')", [cliente, hash]);
    await expect(
      pool.query("insert into agencia_formularios(cliente_id,token_hash,expira_em) values ($1,$2,now())", [cliente, hash]),
    ).rejects.toThrow(/agencia_formularios_token/);
    await expect(pool.query("update agencia_formularios set situacao = 'lido' where token_hash = $1", [hash])).rejects.toThrow(
      /agencia_formularios_situacao/,
    );
  });

  it("o WhatsApp da agência aceita o motivo formulario", async () => {
    const id = randomUUID();
    await pool.query("insert into agencia_envios_whatsapp(id,motivo,telefone,corpo) values ($1,'formulario','+5511900000002','link')", [id]);
    await pool.query("delete from agencia_envios_whatsapp where id = $1", [id]);
  });
});
