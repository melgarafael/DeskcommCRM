/**
 * O RASCUNHO QUE NASCE DA PLANILHA — e a barreira que ele não pula.
 *
 * `importarPlanilha` é a única escrita da importação: cria a campanha (`succeeded`, origem
 * `importacao`, sem `run_id`) e grava os candidatos. O que este teste protege:
 *
 *   1. os campos da campanha, que é o que faz "a prospecção de sempre" assumir depois;
 *   2. a supressão da LGPD — uma linha suprimida não pode nem chegar ao `insert` (o gatilho do
 *      banco é a segunda barreira, não a primeira), e o mesmo vale para quem já é contato;
 *   3. as contagens que a tela mostra.
 *
 * Sem banco: o `Pool` é um dublê que responde por SQL. `test:db` não roda aqui de propósito —
 * este arquivo prova a DECISÃO do serviço; o gatilho e o `unique` por organização têm o seu
 * invariante próprio (`tests/invariants/prospeccao-planilha-isolamento-e-supressao.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";

import type { CandidatoNaPlanilha } from "./importacao-previa";
import type { Prospect } from "./schema";
import { importarPlanilha } from "./store";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const CAMPANHA = "33333333-3333-4333-8333-333333333333";
const FONE_ENTRA = "+5511900000001";
const FONE_CONTATO = "+5511900000002";
const FONE_SUPRIMIDO = "+5511900000003";

function prospect(phone: string): Prospect {
  return {
    key: `planilha:${phone}`,
    name: "Empresa Exemplo",
    phone,
    website: null,
    category: null,
    address: null,
    maps_url: null,
    rating: null,
    reviews: null,
    emails: [],
    socials: [],
  };
}

const PLANILHA = {
  candidatos: [
    { linha: 2, prospect: prospect(FONE_ENTRA) },
    { linha: 3, prospect: prospect(FONE_CONTATO) },
    { linha: 4, prospect: prospect(FONE_SUPRIMIDO) },
  ] as CandidatoNaPlanilha[],
  erros: [],
};

function dublê(opcoes: { campanhaExistente?: Record<string, unknown> | null } = {}) {
  const sqls: { sql: string; params: unknown[] | undefined }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    sqls.push({ sql, params });
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql.includes("from prospecting_campaigns where organization_id=$1 and request_id=$2"))
      return { rows: opcoes.campanhaExistente ? [opcoes.campanhaExistente] : [], rowCount: 0 };
    // A ficha com o telefone: uma das três linhas já é contato do CRM.
    if (sql.includes("from contact_phones cp"))
      return { rows: [{ phone: FONE_CONTATO }], rowCount: 1 };
    if (sql.includes("from contacts c")) return { rows: [], rowCount: 0 };
    // A supressão da LGPD: uma das três linhas foi apagada a pedido do titular.
    if (sql.includes("from unnest($2::text[])"))
      return { rows: [{ phone: FONE_SUPRIMIDO }], rowCount: 1 };
    if (sql.includes("insert into prospecting_campaigns"))
      return {
        rows: [{ id: CAMPANHA, organization_id: ORG, name: params?.[2], search: params?.[3] }],
        rowCount: 1,
      };
    if (sql.includes("insert into prospecting_candidates")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  return { pool: { connect: async () => client, query } as never, sqls, client };
}

const CAMPOS = {
  name: "Lista da feira",
  niche: "padarias",
  origem_da_lista: "clientes da feira X",
  avaliar_site: true,
  gerar_previa: false,
  arquivo_bytes: 512,
  linhas: 3,
};

describe("importarPlanilha — a campanha em rascunho", () => {
  it("nasce `succeeded`, com origem `importacao` e sem execução de busca", async () => {
    const { pool, sqls } = dublê();
    await importarPlanilha(pool, ORG, REQUEST_ID, CAMPOS, PLANILHA);

    const insert = sqls.find((q) => q.sql.includes("insert into prospecting_campaigns"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("'succeeded'");
    // Nada de `run_id`/`dataset_id`: não há busca a sincronizar, e a esteira não pode tentar.
    expect(insert!.sql).not.toContain("run_id");
    expect(insert!.params?.slice(0, 3)).toEqual([ORG, REQUEST_ID, "Lista da feira"]);
    expect(insert!.params?.[3]).toMatchObject({
      origem: "importacao",
      name: "Lista da feira",
      niche: "padarias",
      origem_da_lista: "clientes da feira X",
      arquivo_bytes: 512,
      linhas: 3,
    });
  });

  it("grava só a linha que passou: contato do CRM e supressão da LGPD não viram candidato", async () => {
    const { pool, sqls } = dublê();
    await importarPlanilha(pool, ORG, REQUEST_ID, CAMPOS, PLANILHA);

    const inserts = sqls.filter((q) => q.sql.includes("insert into prospecting_candidates"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params?.[2]).toBe(`planilha:${FONE_ENTRA}`);
    expect(inserts[0]!.params?.[3]).toBe(FONE_ENTRA);
  });

  it("as recusas voltam com motivo e as contagens fecham", async () => {
    const { pool } = dublê();
    const r = await importarPlanilha(pool, ORG, REQUEST_ID, CAMPOS, PLANILHA);
    expect(r.inseridos).toBe(1);
    expect(r.total_linhas).toBe(3);
    expect(r.ja_na_base).toBe(2);
    expect(r.fora.map((f) => f.codigo)).toEqual(["contato_do_crm", "suprimido_lgpd"]);
    expect(r.resumo.suprimido_lgpd).toBe(1);
    expect(r.repetida).toBe(false);
  });

  it("`skipped_count` da campanha conta toda linha que não entrou", async () => {
    const { pool, sqls } = dublê();
    await importarPlanilha(pool, ORG, REQUEST_ID, CAMPOS, PLANILHA);
    const update = sqls.find((q) => q.sql.includes("update prospecting_campaigns"));
    expect(update!.params).toEqual([ORG, CAMPANHA, 1, 2]);
  });

  it("reenviar o mesmo request_id devolve a campanha existente e não grava candidato", async () => {
    const { pool, sqls } = dublê({
      campanhaExistente: { id: CAMPANHA, result_count: 1, skipped_count: 2 },
    });
    const r = await importarPlanilha(pool, ORG, REQUEST_ID, CAMPOS, PLANILHA);
    expect(r.repetida).toBe(true);
    expect(r.campaign.id).toBe(CAMPANHA);
    expect(sqls.some((q) => q.sql.includes("insert into prospecting_candidates"))).toBe(false);
    expect(sqls.some((q) => q.sql.includes("insert into prospecting_campaigns"))).toBe(false);
  });
});
