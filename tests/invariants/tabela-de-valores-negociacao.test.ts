/**
 * A TABELA DE VALORES DE NEGOCIAÇÃO — importar, conferir e não duplicar.
 *
 * Os quatro casos que a fatia 1 (issue #4612) promete, contra o Postgres de
 * verdade (o baseline aplicado pelo `scripts/test-db.sh`), porque as três
 * cercas que importam aqui são do BANCO:
 *
 *   1. a PRÉVIA não grava — nem item, nem registro de importação;
 *   2. confirmar grava 100% das linhas válidas, com partida e limite;
 *   3. linha com limite menor que a partida é recusada com motivo na leitura —
 *      e o INSERT direto, burlando a aplicação, também é recusado pela
 *      constraint `faixa_brl`;
 *   4. a mesma planilha duas vezes não duplica procedimento: a segunda devolve
 *      `repetida: true`; e o mesmo código vindo de outro arquivo conta em
 *      `ja_existe`, sem sobrescrever preço.
 *
 * O quinto caso é o isolamento: tabela de uma organização não é lida pela outra.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SheetMatrix } from "@/lib/planilha/ler-arquivo";
import { chaveDoArquivo, montarPrevia } from "@/lib/tabela-de-valores/importacao";
import { lerPlanilhaDaTabelaDeValores } from "@/lib/tabela-de-valores/planilha";
import {
  buscarTabelaDeValores,
  criarTabelaDeValores,
  importarTabelaDeValores,
  lerItemPorCodigo,
  previaDaPlanilha,
} from "@/lib/tabela-de-valores/store";

import { countAs, GOV_AGENT_A, GOV_ORG, seedGov, sql } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});

const ORG = randomUUID();
const OUTRA_ORG = randomUUID();
let tabelaId = "";

/**
 * Cabeçalho como a empresa escreve: com "R$" na coluna, "US$" na outra e a
 * linha 47 com o limite digitado ABAIXO da partida — o erro que motiva a fatia.
 */
const PLANILHA: SheetMatrix = {
  headers: [
    "Código",
    "Descrição",
    "Valor de partida (R$)",
    "Valor limite (R$)",
    "Valor de partida (US$)",
    "Valor limite (US$)",
  ],
  rows: [
    ["1010", "Consulta clínica", "R$ 120,00", "R$ 180,00", "30,00", "36,00"],
    ["2020", "Radiografia periapical", "45,50", "70,00", "", ""],
    ["3030", "Urgência 24h", "300,00", "250,00", "60,00", "60,00"],
  ],
  rowNumbers: [2, 3, 47],
};

function leitura() {
  const lida = lerPlanilhaDaTabelaDeValores(PLANILHA);
  if ("erro" in lida) throw new Error(lida.erro);
  return lida;
}

async function contarItens(tabela = tabelaId): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from tabela_de_valores_itens where tabela_id=$1",
    [tabela],
  );
  return Number(rows[0]!.n);
}

async function contarImportacoes(tabela = tabelaId): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from tabela_de_valores_importacoes where tabela_id=$1",
    [tabela],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  for (const org of [ORG, OUTRA_ORG]) {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Clínica fictícia','Clínica fictícia')",
      [org],
    );
  }
  const tabela = await criarTabelaDeValores(pool, ORG, { nome: "Credenciamento 2026" }, null);
  tabelaId = tabela.id;
});

afterAll(() => pool.end());

describe("tabela de valores — importar com prévia", () => {
  it("a prévia não grava: nenhum item e nenhuma importação registrada", async () => {
    const previa = await previaDaPlanilha(pool, ORG, tabelaId, leitura(), "chave-da-previa");

    expect(previa.entram.map((l) => l.item.codigo)).toEqual(["1010", "2020"]);
    expect(previa.fora).toHaveLength(1);
    expect(previa.total_linhas).toBe(3);

    expect(await contarItens()).toBe(0);
    expect(await contarImportacoes()).toBe(0);
  });

  it("a linha com limite menor que a partida é recusada com motivo e número da linha", async () => {
    const previa = await previaDaPlanilha(pool, ORG, tabelaId, leitura(), "chave-da-previa");
    const recusada = previa.fora[0]!;

    expect(recusada.linha).toBe(47);
    expect(recusada.codigo).toBe("limite_menor_que_partida");
    expect(recusada.codigo_do_procedimento).toBe("3030");
    expect(recusada.detalhe).toBe("R$");
    expect(recusada.motivo).toBe("O valor limite é menor que o valor de partida.");
    expect(previa.resumo.limite_menor_que_partida).toBe(1);
  });

  it("o banco recusa a mesma faixa invertida por INSERT direto (a aplicação não é a única cerca)", async () => {
    await expect(
      pool.query(
        "insert into tabela_de_valores_itens(organization_id,tabela_id,codigo,descricao,valor_brl_partida_cents,valor_brl_limite_cents) values($1,$2,'9999','Faixa invertida',30000,25000)",
        [ORG, tabelaId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await contarItens()).toBe(0);
  });

  it("confirmar grava 100% das linhas válidas, com partida e limite", async () => {
    const previa = await previaDaPlanilha(pool, ORG, tabelaId, leitura(), "chave-1");
    const r = await importarTabelaDeValores(
      pool,
      ORG,
      tabelaId,
      { chave_do_arquivo: "chave-1", nome_do_arquivo: "tabela.csv", previa, linhas_lidas: 3 },
      null,
    );

    expect(r.repetida).toBe(false);
    expect(r.inseridos).toBe(2);
    expect(r.ja_existe).toBe(0);
    expect(await contarItens()).toBe(2);
    expect(await contarImportacoes()).toBe(1);

    // A leitura por procedimento devolve AS DUAS pontas, em centavos.
    const clinica = await lerItemPorCodigo(pool, ORG, tabelaId, "1010");
    expect(clinica).toMatchObject({
      codigo: "1010",
      descricao: "Consulta clínica",
      valor_brl_partida_cents: 12_000,
      valor_brl_limite_cents: 18_000,
      valor_us_partida_cents: 3_000,
      valor_us_limite_cents: 3_600,
    });
    // Moeda não cotada volta nula, e não zero.
    const raio = await lerItemPorCodigo(pool, ORG, tabelaId, "2020");
    expect(raio?.valor_brl_partida_cents).toBe(4_550);
    expect(raio?.valor_us_partida_cents).toBeNull();
  });

  it("a mesma planilha duas vezes não duplica procedimento", async () => {
    const previa = await previaDaPlanilha(pool, ORG, tabelaId, leitura(), "chave-1");
    const r = await importarTabelaDeValores(
      pool,
      ORG,
      tabelaId,
      { chave_do_arquivo: "chave-1", nome_do_arquivo: "tabela.csv", previa, linhas_lidas: 3 },
      null,
    );

    expect(r.repetida).toBe(true);
    expect(r.inseridos).toBe(0);
    expect(await contarItens()).toBe(2);
    expect(await contarImportacoes()).toBe(1);
  });

  it("o mesmo código vindo de outro arquivo conta como ja_existe e não sobrescreve o preço", async () => {
    const outra: SheetMatrix = {
      headers: ["codigo", "descricao", "valor de partida", "valor limite"],
      rows: [["1010", "Consulta clínica (preço novo)", "90,00", "400,00"]],
      rowNumbers: [2],
    };
    const lida = lerPlanilhaDaTabelaDeValores(outra);
    if ("erro" in lida) throw new Error(lida.erro);
    const previa = await previaDaPlanilha(pool, ORG, tabelaId, lida, "chave-2");

    // A prévia já conta essa linha como recusada: ela não vai entrar.
    expect(previa.entram).toHaveLength(0);
    expect(previa.fora[0]!.codigo).toBe("ja_existe_na_tabela");

    // E o caminho de escrita, forçado, também não sobrescreve.
    const forcada = montarPrevia(lida, { chave_do_arquivo: "chave-2" });
    const r = await importarTabelaDeValores(
      pool,
      ORG,
      tabelaId,
      { chave_do_arquivo: "chave-2", nome_do_arquivo: "corrigida.csv", previa: forcada, linhas_lidas: 1 },
      null,
    );
    expect(r.inseridos).toBe(0);
    expect(r.ja_existe).toBe(1);
    expect(await contarItens()).toBe(2);

    const clinica = await lerItemPorCodigo(pool, ORG, tabelaId, "1010");
    expect(clinica?.valor_brl_partida_cents).toBe(12_000);
    expect(clinica?.descricao).toBe("Consulta clínica");
  });

  it("id que não é uuid é tabela inexistente (404 na rota), não erro de cast (500)", async () => {
    await expect(buscarTabelaDeValores(pool, ORG, "nao-e-uuid")).resolves.toBeNull();
  });

  it("a tabela de uma organização não é lida pela outra", async () => {
    expect(await lerItemPorCodigo(pool, OUTRA_ORG, tabelaId, "1010")).toBeNull();
  });

  it("a chave do arquivo é estável para os mesmos bytes e muda quando o arquivo muda", () => {
    const bytes = new TextEncoder().encode("codigo;descricao\n1010;Consulta\n");
    expect(chaveDoArquivo(bytes)).toBe(chaveDoArquivo(new TextEncoder().encode("codigo;descricao\n1010;Consulta\n")));
    expect(chaveDoArquivo(bytes)).toHaveLength(64);
    expect(chaveDoArquivo(bytes)).not.toBe(
      chaveDoArquivo(new TextEncoder().encode("codigo;descricao\n1010;Consulta clínica\n")),
    );
  });
});

/** stderr da recusa ao membro com JWT authenticated ('' se o comando passou). */
function recusaAoMembro(comando: string): string {
  try {
    countAs(GOV_AGENT_A, comando);
    return "";
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? String(err);
  }
}

describe("tabela de valores — a equipe lê, só o servidor grava (RLS por JWT)", () => {
  beforeAll(() => seedGov());

  it("o livro de importações é do servidor: RLS ligada, nenhuma policy, e o membro da PRÓPRIA organização é recusado", () => {
    expect(
      sql("select relrowsecurity from pg_class where oid = 'public.tabela_de_valores_importacoes'::regclass"),
    ).toBe("t");
    expect(
      sql(
        "select count(*) from pg_policies where schemaname = 'public' and tablename = 'tabela_de_valores_importacoes'",
      ),
    ).toBe("0");
    expect(
      recusaAoMembro(
        `select count(*) from public.tabela_de_valores_importacoes where organization_id = '${GOV_ORG}';`,
      ),
    ).toMatch(/permission denied/);
    // Controle: a MESMA sessão lê a tabela de valores. Sem isto, a recusa acima
    // poderia ser de sessão quebrada, e não da falta de privilégio.
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.tabelas_de_valores where organization_id = '${GOV_ORG}';`),
    ).toBeGreaterThanOrEqual(0);
  });

  it("preço não se grava pelo navegador: insert, update e delete de authenticated são recusados", () => {
    const comandos = [
      `insert into public.tabelas_de_valores (organization_id, nome) values ('${GOV_ORG}', 'pelo navegador');`,
      `update public.tabela_de_valores_itens set valor_brl_limite_cents = 1 where organization_id = '${GOV_ORG}';`,
      `delete from public.tabela_de_valores_itens where organization_id = '${GOV_ORG}';`,
      `delete from public.tabelas_de_valores where organization_id = '${GOV_ORG}';`,
      `insert into public.tabela_de_valores_importacoes (organization_id, tabela_id, chave_do_arquivo) values ('${GOV_ORG}', gen_random_uuid(), 'pelo navegador');`,
      `delete from public.tabela_de_valores_importacoes where organization_id = '${GOV_ORG}';`,
    ];
    for (const comando of comandos) expect(recusaAoMembro(comando), comando).toMatch(/permission denied/);
  });
});
