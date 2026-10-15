import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * #2887 — `fn_mover_leads_em_lote` NÃO sobrescreve o motivo de quem JÁ estava
 * perdido, e continua movendo todo mundo.
 *
 * ═══ A MEDIÇÃO QUE A ISSUE NÃO TINHA ═══
 *
 * A issue diz, em "Não medido": "Comportamento executado. Tudo acima vem da
 * leitura do SQL". Ela é exata sobre `lost_reason = $4` — a função escrevia o
 * motivo do lote em TODOS os leads do alvo, numa escrita só, e quem já estava
 * perdido perdia o motivo original em silêncio. Estes casos rodam a função no
 * Postgres de verdade, que é onde o defeito existe:
 *
 *  - o motivo de quem já estava perdido sobrevive ao lote (o `status`, não o
 *    `lost_reason`, decide: um card REABERTO carrega o motivo da perda anterior
 *    e uma perda NOVA o substitui, como faz a `/lose`);
 *  - o card preservado CONTINUA sendo movido — o conserto é do MOTIVO, não do
 *    movimento —, e as posições seguem DISTINTAS com os dois grupos no mesmo
 *    lote (a razão de existir da 0209);
 *  - um motivo APOSENTADO (saiu da configuração do funil depois de usado)
 *    sobrevive sem revalidar: quem separa os grupos num `update` por grupo não
 *    pode tocar a coluna de quem mantém o motivo, senão
 *    `trg_validate_lost_reason_required` (que é `before update of status,
 *    lost_reason`) derruba o LOTE INTEIRO com 22023 — o mesmo defeito da #917,
 *    com outro nome.
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

const ORG = "917e0000-0000-4000-8000-000000002887";
let funil = "";
let etapaAberta = "";
let etapaComum = "";
let etapaDePerda = "";

/** Um negócio ABERTO na etapa de entrada — o lote de todo dia. */
async function negocioAberto(titulo: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, status)
     values ($1, $2, $3, $4, 'open') returning id`,
    [ORG, funil, etapaAberta, titulo],
  );
  return rows[0]!.id;
}

/** Um negócio que JÁ estava perdido, com o motivo dele, na etapa de perda. */
async function negocioPerdido(motivo: string, titulo: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, status, lost_reason)
     values ($1, $2, $3, $4, 'lost', $5) returning id`,
    [ORG, funil, etapaDePerda, titulo, motivo],
  );
  return rows[0]!.id;
}

async function moverEmLote(
  ids: string[],
  etapa: string,
  motivo: string | null,
): Promise<{ rows: number }> {
  const { rows } = await pool.query("select * from fn_mover_leads_em_lote($1, $2, $3, $4)", [
    ORG,
    ids,
    etapa,
    motivo,
  ]);
  return { rows: rows.length };
}

async function motivoDe(ids: string[]): Promise<Map<string, string | null>> {
  const { rows } = await pool.query<{ id: string; lost_reason: string | null }>(
    "select id, lost_reason from crm_leads where id = any($1)",
    [ids],
  );
  return new Map(rows.map((l) => [l.id, l.lost_reason]));
}

async function vocabularioDoFunil(motivos: string[]): Promise<void> {
  await pool.query(
    `update crm_pipelines set settings = jsonb_set(coalesce(settings, '{}'::jsonb),
       '{lost_reasons}', $2::jsonb) where id = $1`,
    [funil, JSON.stringify(motivos)],
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-lote-2887', 'Lote 2887 LTDA', 'Lote 2887') on conflict (id) do nothing`,
    [ORG],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position)
     values ($1, 'Comercial 2887', 'comercial-2887', 100) returning id`,
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
  etapaAberta = await etapa("Entrada", "entrada-2887", 1, false);
  etapaComum = await etapa("Negociando", "negociando-2887", 2, false);
  etapaDePerda = await etapa("Perdido", "perdido-2887", 3, true);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("#2887 — o lote para uma etapa de PERDA", () => {
  it("o motivo de quem JÁ estava perdido sobrevive; quem não estava recebe o do lote", async () => {
    const jaPerdido = await negocioPerdido("price", "Perdido antes do lote");
    const abertoA = await negocioAberto("Aberto no lote A");
    const abertoB = await negocioAberto("Aberto no lote B");

    const r = await moverEmLote([jaPerdido, abertoA, abertoB], etapaDePerda, "no_response");

    // Os TRÊS foram movidos: o conserto é do MOTIVO, não do movimento.
    expect(r.rows).toBe(3);
    const motivos = await motivoDe([jaPerdido, abertoA, abertoB]);
    // ⬇ VEM VERMELHO sem o conserto: `lost_reason = $4` valia para todos.
    expect(motivos.get(jaPerdido)).toBe("price");
    expect(motivos.get(abertoA)).toBe("no_response");
    expect(motivos.get(abertoB)).toBe("no_response");
  });

  it("o card preservado continua sendo movido, com posição distinta dos demais", async () => {
    const jaPerdido = await negocioPerdido("price", "Perdido antes do lote 2");
    const aberto = await negocioAberto("Aberto no lote 2");

    const r = await moverEmLote([jaPerdido, aberto], etapaComum, null);
    expect(r.rows).toBe(2);

    const { rows } = await pool.query<{ id: string; stage_id: string; pos: string }>(
      "select id, stage_id, position_in_stage as pos from crm_leads where id = any($1)",
      [[jaPerdido, aberto]],
    );
    expect(rows.map((l) => l.stage_id)).toEqual([etapaComum, etapaComum]);
    // Posições DISTINTAS — a razão de existir da 0209, que a #2887 não pode ter
    // quebrado ao dividir a escrita em dois grupos.
    expect(new Set(rows.map((l) => l.pos)).size).toBe(2);
  });

  it("o card que JÁ está parado na própria etapa de perda também preserva o motivo", async () => {
    // O caso mais alcançável do produto: o negócio já está na coluna de perda, o
    // operador o seleciona junto com os abertos e usa o botão "marcar como
    // perdido". A etapa de origem e a de destino são a MESMA, então nem a
    // timeline nem a auditoria do lote falam desse card — a troca do motivo era
    // muda nos três lugares.
    const jaAlvo = await negocioPerdido("price", "Já perdido na etapa de destino");
    const aberto = await negocioAberto("Aberto no lote 4");

    const r = await moverEmLote([jaAlvo, aberto], etapaDePerda, "no_response");

    expect(r.rows).toBe(2);
    const motivos = await motivoDe([jaAlvo, aberto]);
    expect(motivos.get(jaAlvo)).toBe("price");
    expect(motivos.get(aberto)).toBe("no_response");
  });

  it("o motivo APOSENTADO de quem já estava perdido sobrevive ao lote com motivo", async () => {
    // O motivo sai da configuração do funil DEPOIS de usado: é o caso que a
    // 0263 protege, e ele não pode virar 22023 só porque o lote traz um motivo
    // para OUTROS cards.
    await vocabularioDoFunil(["achou_mais_perto"]);
    const jaPerdido = await negocioPerdido("achou_mais_perto", "Perdido com motivo aposentado");
    const aberto = await negocioAberto("Aberto no lote 3");
    await vocabularioDoFunil([]);

    const r = await moverEmLote([jaPerdido, aberto], etapaDePerda, "price");
    expect(r.rows).toBe(2);

    const motivos = await motivoDe([jaPerdido, aberto]);
    expect(motivos.get(jaPerdido)).toBe("achou_mais_perto");
    expect(motivos.get(aberto)).toBe("price");
  });
});
