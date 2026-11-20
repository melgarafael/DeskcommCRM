import type pg from "pg";
import { z } from "zod";

import { montarPrevia } from "@/lib/tabela-de-valores/importacao";
import type {
  ItemDaTabela,
  LeituraDaTabelaDeValores,
  LinhaRecusada,
  MotivoDeRecusa,
  PreviaDaTabela,
} from "@/lib/tabela-de-valores/tipos";
import { resumoVazio } from "@/lib/tabela-de-valores/tipos";

/**
 * A ESCRITA DA TABELA DE VALORES — criar a tabela, importar com prévia e ler.
 *
 * ─── O que este arquivo NÃO faz ──────────────────────────────────────────
 *
 * Não decide o que entra: quem classifica é `planilha.ts` (leitura) e
 * `importacao.ts` (prévia), os dois puros. Aqui só se grava o que a prévia
 * aprovou — e é por isso que a rota pode mostrar a prévia e, no clique
 * seguinte, gravar exatamente aquilo.
 *
 * ─── As duas cercas de repetição ─────────────────────────────────────────
 *
 *   1. `unique (tabela_id, chave_do_arquivo)`: a mesma planilha (mesmos bytes)
 *      não entra duas vezes. A segunda chamada devolve `repetida: true` com as
 *      contagens da primeira, sem escrever nada.
 *   2. `unique (tabela_id, codigo)` no item: procedimento repetido não duplica,
 *      mesmo vindo de outro arquivo. A linha que já existia conta em
 *      `ja_existe` — nunca é sobrescrita em silêncio, porque trocar preço de
 *      procedimento por causa de um upload é decisão de gente.
 *
 * ─── Por que trava por (organização, tabela) ─────────────────────────────
 *
 * Duas abas confirmando a mesma importação ao mesmo tempo: sem trava, uma
 * esbarra no `unique` da outra e a segunda vira erro 500. A trava transacional
 * (`pg_advisory_xact_lock`) serializa as importações da mesma tabela, e a
 * segunda passa a ver o registro da primeira e responder "já entrou".
 */
export interface TabelaDeValores {
  id: string;
  organization_id: string;
  nome: string;
  descricao: string | null;
  ativa: boolean;
  created_at: string;
  updated_at: string;
}

export interface ResultadoDaImportacao {
  tabela_id: string;
  /** Linhas gravadas agora. */
  inseridos: number;
  /** Linhas que já estavam na tabela (código repetido entre arquivos). */
  ja_existe: number;
  /** `true` quando esta planilha já havia sido confirmada: nada foi gravado agora. */
  repetida: boolean;
  fora: LinhaRecusada[];
  resumo: Record<MotivoDeRecusa, number>;
  total_linhas: number;
}

interface LinhaDoItem {
  codigo: string;
  descricao: string;
  valor_us_partida_cents: string | number | null;
  valor_us_limite_cents: string | number | null;
  valor_brl_partida_cents: string | number | null;
  valor_brl_limite_cents: string | number | null;
  unidade: string | null;
  observacao: string | null;
}

/**
 * `bigint` chega do driver como STRING (é o contrato do node-postgres para não
 * perder precisão acima de 2^53). Converter com `Number` é seguro aqui porque
 * a constraint `nao_negativo` e o teto do leitor mantêm os valores muito abaixo
 * disso — mas converter é obrigatório, porque `"1234" + 1` seria `"12341"`.
 */
function cents(bruto: string | number | null): number | null {
  if (bruto === null || bruto === "") return null;
  return Number(bruto);
}

function itemDaLinha(linha: LinhaDoItem): ItemDaTabela {
  return {
    codigo: linha.codigo,
    descricao: linha.descricao,
    valor_us_partida_cents: cents(linha.valor_us_partida_cents),
    valor_us_limite_cents: cents(linha.valor_us_limite_cents),
    valor_brl_partida_cents: cents(linha.valor_brl_partida_cents),
    valor_brl_limite_cents: cents(linha.valor_brl_limite_cents),
    unidade: linha.unidade,
    observacao: linha.observacao,
  };
}

const COLUNAS_DO_ITEM =
  "codigo, descricao, valor_us_partida_cents, valor_us_limite_cents, " +
  "valor_brl_partida_cents, valor_brl_limite_cents, unidade, observacao";

export async function criarTabelaDeValores(
  pool: pg.Pool,
  org: string,
  campos: { nome: string; descricao?: string | null },
  actorUserId: string | null,
): Promise<TabelaDeValores> {
  const { rows } = await pool.query<TabelaDeValores>(
    "insert into tabelas_de_valores(organization_id,nome,descricao,created_by) values($1,$2,$3,$4) returning *",
    [org, campos.nome.trim(), campos.descricao?.trim() || null, actorUserId],
  );
  return rows[0]!;
}

export async function listarTabelasDeValores(
  pool: pg.Pool,
  org: string,
): Promise<TabelaDeValores[]> {
  const { rows } = await pool.query<TabelaDeValores>(
    "select * from tabelas_de_valores where organization_id=$1 order by ativa desc, updated_at desc",
    [org],
  );
  return rows;
}

/**
 * A tabela, DA ORGANIZAÇÃO QUE PEDIU. Devolver `null` para tabela de outra
 * organização é o que impede a rota de importar para dentro de um vizinho pelo
 * `id` do caminho — o `id` sozinho não prova dono.
 */
export async function buscarTabelaDeValores(
  pool: pg.Pool,
  org: string,
  tabelaId: string,
): Promise<TabelaDeValores | null> {
  // O id vem da URL. Um id que não é uuid não é tabela de ninguém: sem esta
  // linha o Postgres recusa o cast (22P02) e as rotas respondem 500, não 404.
  if (!z.string().uuid().safeParse(tabelaId).success) return null;
  const { rows } = await pool.query<TabelaDeValores>(
    "select * from tabelas_de_valores where organization_id=$1 and id=$2",
    [org, tabelaId],
  );
  return rows[0] ?? null;
}

/** Códigos já presentes na tabela — é o que a prévia usa para não prometer o que não entra. */
export async function codigosDaTabela(
  pool: pg.Pool,
  org: string,
  tabelaId: string,
): Promise<Set<string>> {
  const { rows } = await pool.query<{ codigo: string }>(
    "select codigo from tabela_de_valores_itens where organization_id=$1 and tabela_id=$2",
    [org, tabelaId],
  );
  return new Set(rows.map((r) => r.codigo));
}

/**
 * A prévia: lê o que a tabela já tem e classifica. NÃO grava — nem o registro
 * da importação, que só nasce no "confirmar".
 */
export async function previaDaPlanilha(
  pool: pg.Pool,
  org: string,
  tabelaId: string | null,
  leitura: LeituraDaTabelaDeValores,
  chaveDoArquivo: string,
): Promise<PreviaDaTabela> {
  const codigos = tabelaId ? await codigosDaTabela(pool, org, tabelaId) : new Set<string>();
  return montarPrevia(leitura, {
    chave_do_arquivo: chaveDoArquivo,
    codigos_na_tabela: codigos,
  });
}

/**
 * Grava o que a prévia aprovou, numa transação.
 *
 * Devolve `repetida: true` (sem escrever) quando a chave do arquivo já foi
 * confirmada para esta tabela, e `ja_existe` quando o código já estava lá por
 * outro caminho. Nunca sobrescreve preço: `do nothing` é deliberado.
 */
/**
 * A planilha (mesmos bytes) já entrou nesta tabela? A rota pergunta isto ANTES
 * de recusar "nenhuma linha pode entrar": depois de uma confirmação, a prévia
 * dos mesmos bytes nunca tem linha nova (todas viram `ja_existe_na_tabela`), e
 * sem esta pergunta o `repetida: true` de `importarTabelaDeValores` nunca era
 * alcançado pela tela, que mostrava um 422 em vez de "esta planilha já entrou".
 */
export async function arquivoJaImportado(
  pool: pg.Pool,
  org: string,
  tabelaId: string,
  chaveDoArquivo: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    "select 1 from tabela_de_valores_importacoes " +
      "where organization_id=$1 and tabela_id=$2 and chave_do_arquivo=$3 limit 1",
    [org, tabelaId, chaveDoArquivo],
  );
  return rows.length > 0;
}

export async function importarTabelaDeValores(
  pool: pg.Pool,
  org: string,
  tabelaId: string,
  dados: {
    chave_do_arquivo: string;
    nome_do_arquivo: string | null;
    previa: PreviaDaTabela;
    /** Toda linha lida (aceitas + recusadas), como a planilha tinha. */
    linhas_lidas: number;
  },
  actorUserId: string | null,
): Promise<ResultadoDaImportacao> {
  const { previa } = dados;
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `tabela-de-valores:${org}:${tabelaId}`,
    ]);

    const anterior = await db.query<{
      linhas_lidas: number;
      linhas_aceitas: number;
      linhas_recusadas: number;
    }>(
      "select linhas_lidas, linhas_aceitas, linhas_recusadas from tabela_de_valores_importacoes " +
        "where organization_id=$1 and tabela_id=$2 and chave_do_arquivo=$3",
      [org, tabelaId, dados.chave_do_arquivo],
    );
    if (anterior.rows[0]) {
      await db.query("commit");
      return {
        tabela_id: tabelaId,
        // A planilha já entrou: os números são os da primeira importação, e não
        // os desta tentativa — dizer "inseridos: 40" sem ter gravado seria mentira.
        inseridos: 0,
        ja_existe: anterior.rows[0].linhas_aceitas,
        repetida: true,
        fora: previa.fora,
        resumo: previa.resumo,
        total_linhas: previa.total_linhas,
      };
    }

    let inseridos = 0;
    for (const { item } of previa.entram) {
      const { rowCount } = await db.query(
        "insert into tabela_de_valores_itens(" +
          "organization_id,tabela_id,codigo,descricao,valor_us_partida_cents,valor_us_limite_cents," +
          "valor_brl_partida_cents,valor_brl_limite_cents,unidade,observacao) values(" +
          "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tabela_id, codigo) do nothing",
        [
          org,
          tabelaId,
          item.codigo,
          item.descricao,
          item.valor_us_partida_cents,
          item.valor_us_limite_cents,
          item.valor_brl_partida_cents,
          item.valor_brl_limite_cents,
          item.unidade,
          item.observacao,
        ],
      );
      inseridos += rowCount ?? 0;
    }

    await db.query(
      "insert into tabela_de_valores_importacoes(" +
        "organization_id,tabela_id,chave_do_arquivo,nome_do_arquivo,linhas_lidas," +
        "linhas_aceitas,linhas_recusadas,created_by) values($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        org,
        tabelaId,
        dados.chave_do_arquivo,
        dados.nome_do_arquivo,
        dados.linhas_lidas,
        previa.entram.length,
        previa.fora.length,
        actorUserId,
      ],
    );

    await db.query("commit");
    return {
      tabela_id: tabelaId,
      inseridos,
      ja_existe: previa.entram.length - inseridos,
      repetida: false,
      fora: previa.fora,
      resumo: previa.resumo,
      total_linhas: previa.total_linhas,
    };
  } catch (erro) {
    await db.query("rollback").catch(() => undefined);
    throw erro;
  } finally {
    db.release();
  }
}

/** A leitura por procedimento: o que o agente e a tela precisam saber de um código. */
export async function lerItemPorCodigo(
  pool: pg.Pool,
  org: string,
  tabelaId: string,
  codigo: string,
): Promise<ItemDaTabela | null> {
  const { rows } = await pool.query<LinhaDoItem>(
    `select ${COLUNAS_DO_ITEM} from tabela_de_valores_itens ` +
      "where organization_id=$1 and tabela_id=$2 and codigo=$3",
    [org, tabelaId, codigo.trim()],
  );
  return rows[0] ? itemDaLinha(rows[0]) : null;
}

export async function listarItensDaTabela(
  pool: pg.Pool,
  org: string,
  tabelaId: string,
  opcoes: { limite?: number; busca?: string | null } = {},
): Promise<ItemDaTabela[]> {
  const limite = Math.min(Math.max(opcoes.limite ?? 200, 1), 2_000);
  const busca = opcoes.busca?.trim() || null;
  // `ilike` com o escape do curinga: a busca é da pessoa, e `%` digitado não
  // pode virar "tudo".
  const padrao = busca ? `%${busca.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const { rows } = await pool.query<LinhaDoItem>(
    `select ${COLUNAS_DO_ITEM} from tabela_de_valores_itens ` +
      "where organization_id=$1 and tabela_id=$2 " +
      "and ($3::text is null or codigo ilike $3 or descricao ilike $3) " +
      "order by codigo limit $4",
    [org, tabelaId, padrao, limite],
  );
  return rows.map(itemDaLinha);
}

/** Reexportado para quem monta a resposta da rota com a prévia vazia. */
export { resumoVazio };
