import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * O CARD QUE NASCE DA CONVERSA ENTRA NO TOPO DA ETAPA (#3461; migration 9058).
 *
 * A issue nomeia este caminho primeiro: "quando uma conversa é iniciada (...)
 * o card aparece no final da coluna". O card nasce em
 * `fn_nascer_lead_da_conversa` (direto, ou por `fn_nascer_lead_da_mensagem`), e
 * o insert dela não citava `position_in_stage`: caía no DEFAULT 1000. Com a
 * criação pela API, o move e o lote passando a entrar no TOPO (`min − 1000`),
 * esse card ficaria ABAIXO de todo card que entrou pelos outros caminhos.
 *
 * Contra o Postgres de verdade:
 *  1. numa etapa onde o primeiro card já está ABAIXO de zero (entrou pelo topo),
 *     o card nascido da conversa é o novo primeiro;
 *  2. dois nascimentos seguidos: o segundo fica acima do primeiro;
 *  3. etapa vazia continua nascendo em 1000, como um card criado à mão.
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

const ORG = "d9058000-0000-4000-8000-000000000001";
const FUNIL = "d9058000-0000-4000-8000-000000000003";
const ETAPA_CHEIA = "d9058000-0000-4000-8000-000000000004";
const ETAPA_VAZIA = "d9058000-0000-4000-8000-000000000005";

let sequencia = 0;
function id(): string {
  sequencia += 1;
  return `d9058000-0000-4000-8000-${String(1000 + sequencia).padStart(12, "0")}`;
}

async function contato(): Promise<string> {
  const c = id();
  await pool.query(`insert into contacts (id, organization_id, name) values ($1, $2, 'Pessoa')`, [c, ORG]);
  return c;
}

async function cardEm(etapa: string, posicao: number): Promise<string> {
  const l = id();
  await pool.query(
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, position_in_stage)
     values ($1, $2, $3, $4, $5, 'Residente', $6)`,
    [l, ORG, FUNIL, etapa, await contato(), posicao],
  );
  return l;
}

async function nascer(etapa: string): Promise<string> {
  const { rows } = await pool.query<{ id: string | null }>(
    `select public.fn_nascer_lead_da_conversa($1, $2, $3, $4, 'Conversa nova', 'whatsapp') as id`,
    [ORG, await contato(), FUNIL, etapa],
  );
  expect(rows[0]!.id, "contato sem negócio aberto ganha card").not.toBeNull();
  return rows[0]!.id!;
}

/** A coluna como o quadro a desenha: posição crescente, `id` no empate. */
async function coluna(etapa: string): Promise<Array<{ id: string; pos: number }>> {
  const { rows } = await pool.query<{ id: string; pos: string }>(
    `select id, position_in_stage::text as pos from crm_leads
      where organization_id = $1 and stage_id = $2 and status <> 'archived'
      order by position_in_stage, id`,
    [ORG, etapa],
  );
  return rows.map((r) => ({ id: r.id, pos: Number(r.pos) }));
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-9058', 'Org 9058', 'Org 9058') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values ($1, $2, 'Funil', 'funil-9058')`,
    [FUNIL, ORG],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
     values ($1, $3, $4, 'Cheia', 'cheia-9058', 1), ($2, $3, $4, 'Vazia', 'vazia-9058', 2)`,
    [ETAPA_CHEIA, ETAPA_VAZIA, ORG, FUNIL],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("fn_nascer_lead_da_conversa — o card nasce no TOPO da etapa (9058, #3461)", () => {
  it("⭐ o card nascido da conversa fica ACIMA de quem entrou pelo topo antes dele", async () => {
    // -1000 é o que a criação pela API grava numa etapa cujo primeiro está em 0:
    // um card que já entrou pelo topo. O DEFAULT 1000 ficaria abaixo dele.
    await cardEm(ETAPA_CHEIA, 2000);
    await cardEm(ETAPA_CHEIA, -1000);

    const novo = await nascer(ETAPA_CHEIA);
    const ordem = await coluna(ETAPA_CHEIA);

    expect(ordem[0]!.id, "o primeiro da coluna é o recém-nascido").toBe(novo);
    expect(ordem[0]!.pos).toBe(-2000);
  });

  it("o segundo nascimento fica acima do primeiro — quem chega por último é o primeiro", async () => {
    const primeiro = await nascer(ETAPA_CHEIA);
    const segundo = await nascer(ETAPA_CHEIA);
    const ordem = (await coluna(ETAPA_CHEIA)).map((c) => c.id);

    expect(ordem.indexOf(segundo)).toBe(0);
    expect(ordem.indexOf(primeiro)).toBe(1);
  });

  it("etapa vazia: o card nasce em 1000, como um criado à mão", async () => {
    const novo = await nascer(ETAPA_VAZIA);
    expect(await coluna(ETAPA_VAZIA)).toEqual([{ id: novo, pos: 1000 }]);
  });
});
