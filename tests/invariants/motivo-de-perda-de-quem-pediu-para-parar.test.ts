import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * O motivo com que a ingestão fecha o negócio de quem respondeu PARAR
 * (`opted_out_of_messages`, migration 0513, PR #2049) passa pelo trigger
 * `fn_validate_lost_reason_required` do baseline.
 *
 * Precisa de Postgres de verdade: o fechamento (`encerraDemanda`) NUNCA lança —
 * se o trigger recusasse o motivo com 22023, o negócio ficaria aberto e só o
 * log saberia. O controle negativo prova que o trigger está armado (um motivo
 * fora do vocabulário é recusado no MESMO funil).
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

const ORG = "20490000-0000-4000-8000-000000002049";
let funil = "";
let etapaAberta = "";
let etapaDePerda = "";

/** Perde um negócio aberto como `encerraDemanda` faz: etapa e motivo na MESMA escrita. */
async function perderCom(motivo: string): Promise<{ status: string; lost_reason: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, status)
     values ($1, $2, $3, 'Negócio', 'open') returning id`,
    [ORG, funil, etapaAberta],
  );
  const { rows: depois } = await pool.query<{ status: string; lost_reason: string }>(
    `update crm_leads set stage_id = $2, lost_reason = $3 where id = $1
     returning status, lost_reason`,
    [rows[0]!.id, etapaDePerda, motivo],
  );
  return depois[0]!;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-parar-2049', 'Parar LTDA', 'Parar') on conflict (id) do nothing`,
    [ORG],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position)
     values ($1, 'Comercial', 'comercial-parar-2049', 100) returning id`,
    [ORG],
  );
  funil = p[0]!.id;
  const etapa = async (nome: string, slug: string, pos: number, perda: boolean) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_lost)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [ORG, funil, nome, slug, pos, perda],
    );
    return rows[0]!.id;
  };
  etapaAberta = await etapa("Entrada", "entrada-parar-2049", 1, false);
  etapaDePerda = await etapa("Perdido", "perdido-parar-2049", 2, true);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("motivo de perda de quem pediu para não receber mensagens", () => {
  it("`opted_out_of_messages` fecha o negócio como perdido", async () => {
    expect(await perderCom("opted_out_of_messages")).toEqual({
      status: "lost",
      lost_reason: "opted_out_of_messages",
    });
  });

  it("controle: motivo fora do vocabulário é recusado — 22023 `lost_reason_invalid`", async () => {
    await expect(perderCom("pediu_silencio")).rejects.toMatchObject({ code: "22023" });
  });
});
