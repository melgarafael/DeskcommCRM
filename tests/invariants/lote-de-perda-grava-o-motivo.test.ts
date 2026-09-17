import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * `fn_mover_leads_em_lote` COM o motivo da perda (migration 0263, issue #917).
 *
 * ═══ POR QUE ISTO PRECISA DE POSTGRES DE VERDADE ═══
 *
 * O `p_lost_reason` é a razão de existir da 0263, e nenhum teste o chamava:
 * `grep -rln "fn_mover_leads_em_lote" tests/` devolvia VAZIO antes deste
 * arquivo. O job `invariants` provava só que o baseline APLICA a função nova —
 * aplicar não é chamar, e a função tem um corpo que só o Postgres executa:
 *
 *  - `execute format(...) using` com CINCO valores, num texto que, no caminho
 *    SEM motivo, referencia apenas `$1,$2,$3,$5`. Nenhum duplo em JavaScript
 *    exercita um placeholder que sobra;
 *  - a coluna `lost_reason` entra na lista do `update` SÓ quando há motivo —
 *    e é isso que evita revalidar, por `trg_validate_lost_reason_required`, um
 *    motivo que saiu da configuração do funil depois de usado;
 *  - a recusa que o operador via como 500 vem da CHECK
 *    `crm_leads_lost_reason_required` (23514), disparada pelo fechamento que
 *    `trg_crm_lead_close_on_stage` faz — uma cascata de dois gatilhos e uma
 *    constraint, que só existe no banco.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = "917e0000-0000-4000-8000-000000000917";
let funil = "";
let etapaAberta = "";
let etapaDePerda = "";
let etapaComum = "";

/** Dois negócios ABERTOS na etapa de entrada, prontos para o lote. */
async function doisNegociosAbertos(): Promise<[string, string]> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, status)
     values ($1, $2, $3, 'Negócio A', 'open'), ($1, $2, $3, 'Negócio B', 'open')
     returning id`,
    [ORG, funil, etapaAberta],
  );
  return [rows[0]!.id, rows[1]!.id];
}

async function moverEmLote(
  ids: string[],
  etapa: string,
  motivo: string | null,
): Promise<{ rows: number }> {
  const { rows } = await pool.query(
    "select * from fn_mover_leads_em_lote($1, $2, $3, $4)",
    [ORG, ids, etapa, motivo],
  );
  return { rows: rows.length };
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-lote-perda', 'Lote LTDA', 'Lote') on conflict (id) do nothing`,
    [ORG],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position)
     values ($1, 'Comercial', 'comercial-lote-perda', 100) returning id`,
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
  etapaAberta = await etapa("Entrada", "entrada-lote", 1, false);
  etapaComum = await etapa("Negociando", "negociando-lote", 2, false);
  etapaDePerda = await etapa("Perdido", "perdido-lote", 3, true);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("o lote para uma etapa de PERDA", () => {
  it("SEM motivo, o banco recusa o lote inteiro — 23514, a CHECK", async () => {
    const ids = await doisNegociosAbertos();
    await expect(moverEmLote(ids, etapaDePerda, null)).rejects.toMatchObject({
      code: "23514",
      constraint: "crm_leads_lost_reason_required",
    });

    // E a transação única cumpriu a promessa: NENHUM dos dois se moveu.
    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from crm_leads where id = any($1) and stage_id = $2",
      [ids, etapaAberta],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it("COM motivo, os dois se movem e o motivo fica gravado na MESMA escrita", async () => {
    const ids = await doisNegociosAbertos();
    const r = await moverEmLote(ids, etapaDePerda, "price");
    expect(r.rows).toBe(2);

    const { rows } = await pool.query<{ status: string; lost_reason: string; closed_at: string }>(
      "select status, lost_reason, closed_at from crm_leads where id = any($1) order by title",
      [ids],
    );
    expect(rows).toHaveLength(2);
    for (const linha of rows) {
      expect(linha.status).toBe("lost");
      expect(linha.lost_reason).toBe("price");
      // Fechado na mesma escrita — se o motivo entrasse numa segunda, entre as
      // duas o negócio estaria `lost` sem motivo, que é o estado que a CHECK
      // existe para impedir.
      expect(linha.closed_at).not.toBeNull();
    }
  });

  it("motivo fora do vocabulário do funil é recusado — 22023 `lost_reason_invalid`", async () => {
    // Quando a coluna ENTRA na escrita, `trg_validate_lost_reason_required`
    // dispara e confere o valor. É a recusa que a rota traduz em 422.
    const ids = await doisNegociosAbertos();
    await expect(moverEmLote(ids, etapaDePerda, "moved_to_pipeline_X")).rejects.toMatchObject({
      code: "22023",
    });
  });

  it("motivo estendido pelo FUNIL passa (o vocabulário não é só o canônico)", async () => {
    await pool.query(
      `update crm_pipelines set settings = jsonb_set(coalesce(settings, '{}'::jsonb),
         '{lost_reasons}', '["achou_mais_perto"]'::jsonb) where id = $1`,
      [funil],
    );
    const ids = await doisNegociosAbertos();
    const r = await moverEmLote(ids, etapaDePerda, "achou_mais_perto");
    expect(r.rows).toBe(2);
    const { rows } = await pool.query<{ lost_reason: string }>(
      "select lost_reason from crm_leads where id = $1",
      [ids[0]],
    );
    expect(rows[0]!.lost_reason).toBe("achou_mais_perto");
  });
});

describe("o lote para uma etapa COMUM", () => {
  it("sem motivo, move normalmente — o caminho em que `$4` sobra no texto do format", async () => {
    // Este é o lote de todo dia: nenhum motivo, e o `execute format(...) using`
    // passa cinco valores para um texto que usa quatro. Se o placeholder que
    // sobra derrubasse a função, TODO movimento em lote do produto estouraria.
    const ids = await doisNegociosAbertos();
    const r = await moverEmLote(ids, etapaComum, null);
    expect(r.rows).toBe(2);

    const { rows } = await pool.query<{ status: string; lost_reason: string | null; pos: string }>(
      `select status, lost_reason, position_in_stage as pos from crm_leads
        where id = any($1) order by position_in_stage`,
      [ids],
    );
    expect(rows.map((l) => l.status)).toEqual(["open", "open"]);
    expect(rows.map((l) => l.lost_reason)).toEqual([null, null]);
    // Posições DISTINTAS — a razão de existir da 0209, que a 0263 não pode ter
    // quebrado ao acrescentar a coluna condicional à lista do `update`.
    expect(new Set(rows.map((l) => l.pos)).size).toBe(2);
  });

  it("o motivo APOSENTADO do card não é revalidado quando o lote não manda motivo", async () => {
    // A medição que o cabeçalho da 0263 afirma, feita aqui: um card cujo motivo
    // saiu da configuração do funil DEPOIS de usado continua podendo ser movido
    // em lote — porque `p_lost_reason` nulo deixa a coluna FORA da lista do
    // `update`, e `trg_validate_lost_reason_required` (que é `before update of
    // status, lost_reason`) não chega a disparar.
    //
    // Sem a coluna condicional, este lote falharia com 22023 enquanto o arrasto
    // do MESMO card, que não toca a coluna, continuaria passando — dois caminhos
    // respondendo diferente para o mesmo card, que é o defeito da #917.
    const vocabulario = async (motivos: string[]) =>
      pool.query(
        `update crm_pipelines set settings = jsonb_set(coalesce(settings, '{}'::jsonb),
           '{lost_reasons}', $2::jsonb) where id = $1`,
        [funil, JSON.stringify(motivos)],
      );

    await vocabulario(["achou_mais_perto"]);
    const ids = await doisNegociosAbertos();
    await moverEmLote(ids, etapaDePerda, "achou_mais_perto");
    await vocabulario([]); // o dono tirou esse motivo da configuração

    const r = await moverEmLote(ids, etapaDePerda, null);
    expect(r.rows).toBe(2);
    const { rows } = await pool.query<{ lost_reason: string }>(
      "select lost_reason from crm_leads where id = any($1)",
      [ids],
    );
    expect(rows.map((l) => l.lost_reason)).toEqual(["achou_mais_perto", "achou_mais_perto"]);

    // CONTROLE: o mesmo lote MANDANDO o motivo aposentado é recusado. Sem este
    // caso, o anterior ficaria verde mesmo se o trigger nunca validasse nada.
    await expect(moverEmLote(ids, etapaDePerda, "achou_mais_perto")).rejects.toMatchObject({
      code: "22023",
    });
  });
});
