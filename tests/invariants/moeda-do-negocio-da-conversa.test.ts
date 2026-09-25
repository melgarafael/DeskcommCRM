import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * `fn_nascer_lead_da_conversa` (migration 0400) — o negócio que nasce de uma
 * mensagem nasce na moeda da ORGANIZAÇÃO, não no default da coluna.
 *
 * Medido numa organização em guarani: 229 de 229 negócios em BRL. O valor do
 * pedido, gravado depois pelo assistente, sairia para a plataforma de anúncio
 * como ₲125.000 lidos em real.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG_PYG = "d0400000-0000-4000-8000-000000000001";
const ORG_PADRAO = "d0400000-0000-4000-8000-000000000002";

async function montar(org: string, sufixo: string) {
  const funil = `d0400${sufixo}00-0000-4000-8000-000000000003`;
  const etapa = `d0400${sufixo}00-0000-4000-8000-000000000004`;
  const contato = `d0400${sufixo}00-0000-4000-8000-000000000005`;
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values ($1, $2, 'Funil', $3)`,
    [funil, org, `funil-0400-${sufixo}`],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
     values ($1, $2, $3, 'Entrada', 'entrada', 1)`,
    [etapa, org, funil],
  );
  await pool.query(`insert into contacts (id, organization_id, name) values ($1, $2, 'Cliente')`, [contato, org]);
  return { funil, etapa, contato };
}

async function nascer(org: string, f: { funil: string; etapa: string; contato: string }) {
  const { rows } = await pool.query<{ id: string }>(
    `select public.fn_nascer_lead_da_conversa($1, $2, $3, $4, 'Negócio', 'whatsapp') as id`,
    [org, f.contato, f.funil, f.etapa],
  );
  const { rows: l } = await pool.query<{ currency: string }>("select currency from crm_leads where id = $1", [rows[0]!.id]);
  return l[0]!.currency;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, currency)
     values ($1, 'org-0400-pyg', 'Loja em Guarani LTDA', 'Loja em Guarani', 'PYG'),
            ($2, 'org-0400-padrao', 'Padrão LTDA', 'Padrão', default)
     on conflict (id) do nothing`,
    [ORG_PYG, ORG_PADRAO],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id in ($1, $2)", [ORG_PYG, ORG_PADRAO]);
  await pool.end();
});

describe("fn_nascer_lead_da_conversa — a moeda do negócio", () => {
  it("organização em guarani: o negócio nasce em PYG", async () => {
    expect(await nascer(ORG_PYG, await montar(ORG_PYG, "1"))).toBe("PYG");
  });

  it("organização que não escolheu moeda: a da organização, que é o default BRL", async () => {
    expect(await nascer(ORG_PADRAO, await montar(ORG_PADRAO, "2"))).toBe("BRL");
  });
});
