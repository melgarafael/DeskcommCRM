import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, seedGov } from "./gov-helpers";

/**
 * O banco da Fase 6 da agência (migration 9008, docs/agencia/SPEC-contratos.md):
 * contratos e modelos inalcançáveis pelo PostgREST, o modelo inicial nasce, e as
 * unicidades que os webhooks usam (documento da ZapSign, order_nsu da InfinitePay) valem.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const TABELAS = ["agencia_contrato_modelos", "agencia_contratos"] as const;
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
  await pool.query("insert into agencia_clientes(id,nome) values ($1,'Cliente F6')", [cliente]);
});

afterAll(async () => {
  await pool.query("delete from agencia_clientes where id = $1", [cliente]);
  await pool.end();
});

describe("nenhuma tabela da fase 6 é alcançável pelo PostgREST", () => {
  it.each(TABELAS)("anon não lê %s", async (t) => {
    await expect(como(null, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
  it.each(TABELAS)("authenticated não lê %s", async (t) => {
    await expect(como(GOV_AGENT_A, `select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
  });
});

describe("as regras que moram no banco", () => {
  it("o modelo inicial nasce com os campos", async () => {
    const { rows } = await pool.query<{ corpo: string }>("select corpo from agencia_contrato_modelos where nome like 'Prestação de serviços%'");
    expect(rows[0]?.corpo).toContain("{{cliente.razao_social}}");
  });

  it("um documento da ZapSign e um order_nsu da InfinitePay apontam para um contrato só", async () => {
    const ins = (zap: string, nsu: string) =>
      pool.query(
        "insert into agencia_contratos(cliente_id,modelo_nome,titulo,texto,valido_ate,zapsign_doc_token,pagamento_order_nsu) values ($1,'M','T','x',current_date,$2,$3)",
        [cliente, zap, nsu],
      );
    await ins("doc-1", "nsu-1");
    await expect(ins("doc-1", "nsu-2")).rejects.toThrow(/agencia_contratos_zapsign/);
    await expect(ins("doc-2", "nsu-1")).rejects.toThrow(/agencia_contratos_order_nsu/);
  });

  it("valor não negativo e situação fechada", async () => {
    await expect(
      pool.query("insert into agencia_contratos(cliente_id,modelo_nome,titulo,texto,valido_ate,valor_mensal_cents) values ($1,'M','T','x',current_date,-1)", [cliente]),
    ).rejects.toThrow(/agencia_contratos_valor/);
    await expect(
      pool.query("insert into agencia_contratos(cliente_id,modelo_nome,titulo,texto,valido_ate,situacao) values ($1,'M','T','x',current_date,'pago')", [cliente]),
    ).rejects.toThrow(/agencia_contratos_situacao/);
  });
});
