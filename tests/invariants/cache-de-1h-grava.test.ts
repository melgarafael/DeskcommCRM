/**
 * A COLUNA DA GRAVAÇÃO DE CACHE DE 1 HORA EXISTE E ACEITA O QUE O SEAM GRAVA (#5020).
 *
 * O seam (`runModelCall`) já separa a gravação de cache da Anthropic em 1 hora e
 * 5 minutos para COBRAR (`gravacaoDeUmaHora`), mas até a migration 9481 o banco só
 * recebia o total. Uma auditoria pelo banco não conseguia recontar `cost_cents`
 * com as duas tarifas — a diferença aparecia como custo errado sem prova.
 *
 * Este arquivo mede o outro lado do par: o `baseline.sql` (o artefato que o
 * instalador e o `update.sh` aplicam) cria `cache_write_1h_tokens` como integer
 * nulável, a linha com 3.500 totais / 3.000 de 1 hora entra e volta inteira, e
 * quem não mediu (linha antiga, outro provedor, outro escritor) fica NULO — não 0.
 *
 * Roda só no CI e em `pnpm test:db`.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = randomUUID();

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1::uuid, $1::text, 'Cache 1h', 'Cache 1h')`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from llm_calls where organization_id = $1", [ORG]);
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

interface Linha {
  cache_write_tokens: number;
  cache_write_1h_tokens: number | null;
}

async function linhaDoModelo(model: string): Promise<Linha | undefined> {
  const { rows } = await pool.query<Linha>(
    `select cache_write_tokens, cache_write_1h_tokens
       from llm_calls where organization_id = $1 and model = $2`,
    [ORG, model],
  );
  return rows[0];
}

describe("llm_calls.cache_write_1h_tokens no banco do baseline", () => {
  it("nasce integer, nulável e sem default — a coluna é aditiva, nada muda nas linhas antigas", async () => {
    const { rows } = await pool.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'llm_calls'
          and column_name = 'cache_write_1h_tokens'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      data_type: "integer",
      is_nullable: "YES",
      column_default: null,
    });
  });

  it("⭐ a linha do seam com 3500 totais e 3000 de 1 hora entra e volta; quem não mediu fica NULO", async () => {
    // A forma EXATA do insert do seam depois da #5020.
    await pool.query(
      `insert into llm_calls
         (organization_id, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_cents, cache_write_1h_tokens)
       values ($1, 'anthropic', 'claude-sonnet-5-5', 3500, 0, 0, 3500, 1.325, 3000)`,
      [ORG],
    );
    // Linha antiga (ou de outro escritor que não mediu a divisão): sem a coluna.
    await pool.query(
      `insert into llm_calls
         (organization_id, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_cents)
       values ($1, 'openrouter', 'anthropic/claude-sonnet-5', 1200, 10, 0, 1200, 2.4)`,
      [ORG],
    );

    const medida = await linhaDoModelo("claude-sonnet-5-5");
    const naoMedida = await linhaDoModelo("anthropic/claude-sonnet-5");
    expect(naoMedida).toEqual({
      cache_write_tokens: 1200,
      cache_write_1h_tokens: null,
    });
    expect(medida).toEqual({
      cache_write_tokens: 3500,
      cache_write_1h_tokens: 3000,
    });
    // A premissa que a auditoria usa: a parcela de 1 h nunca passa do total.
    expect(medida!.cache_write_1h_tokens!).toBeLessThanOrEqual(medida!.cache_write_tokens);
  });
});
