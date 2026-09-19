/**
 * Mapeamento do catálogo do agente (migration 0244).
 *
 * ─── O que é ────────────────────────────────────────────────────────────────
 * Diz QUAL tabela do banco externo é o catálogo e QUAIS colunas são nome/ano/
 * cor/km/preço/imagem/estoque/cilindrada/tipo. Antes isso vivia cravado no
 * código (`motos`, `imagem_url`); agora é uma linha por organização, configurada
 * pela tela de Integração de dados.
 *
 * ─── Quem consome ───────────────────────────────────────────────────────────
 *   - o runtime do turno (`inbound-turn.ts`), para EXTRAIR nome/fotos/legenda do
 *     resultado de `crm_query_external_data`;
 *   - o bloco de catálogo injetado no sufixo do prompt, para o modelo saber a
 *     tabela e as colunas REAIS (nunca no prompt fixo da persona).
 *
 * ─── Retrocompatibilidade ───────────────────────────────────────────────────
 * Sem mapeamento configurado, `carregarCatalogoMapeamento` devolve `null` e o
 * motor cai no comportamento anterior (colunas descobertas por heurística em
 * `fotos-do-catalogo.ts`). Ninguém quebra por não ter configurado.
 */
import type pg from 'pg';

export type OperadorDeBusca = 'contem' | 'eq' | 'comeca_com';

export interface CatalogoMapeamento {
  connectionId: string;
  schemaName: string;
  tableName: string;
  colNome: string;
  colAno: string | null;
  colCor: string | null;
  colKm: string | null;
  colPreco: string | null;
  colImagem: string | null;
  colEstoque: string | null;
  colCilindrada: string | null;
  colTipo: string | null;
  buscaOperador: OperadorDeBusca;
}

/** As colunas que o extrator do motor conhece (todas opcionais menos o nome). */
export interface ColunasDoCatalogo {
  nome: string;
  ano?: string;
  cor?: string;
  km?: string;
  preco?: string;
  imagem?: string;
  estoque?: string;
  cilindrada?: string;
  tipo?: string;
}

/** Converte o mapeamento no formato que `fotos-do-catalogo.ts` entende. */
export function colunasDoCatalogo(m: CatalogoMapeamento): ColunasDoCatalogo {
  return {
    nome: m.colNome,
    ...(m.colAno !== null ? { ano: m.colAno } : {}),
    ...(m.colCor !== null ? { cor: m.colCor } : {}),
    ...(m.colKm !== null ? { km: m.colKm } : {}),
    ...(m.colPreco !== null ? { preco: m.colPreco } : {}),
    ...(m.colImagem !== null ? { imagem: m.colImagem } : {}),
    ...(m.colEstoque !== null ? { estoque: m.colEstoque } : {}),
    ...(m.colCilindrada !== null ? { cilindrada: m.colCilindrada } : {}),
    ...(m.colTipo !== null ? { tipo: m.colTipo } : {}),
  };
}

/**
 * Lê o mapeamento ativo da organização. `null` quando não há (o motor cai no
 * comportamento por heurística). Nunca lança por ausência de linha.
 */
export async function carregarCatalogoMapeamento(
  db: pg.Pool,
  organizationId: string,
): Promise<CatalogoMapeamento | null> {
  const { rows } = await db.query<{
    connection_id: string;
    schema_name: string;
    table_name: string;
    col_nome: string;
    col_ano: string | null;
    col_cor: string | null;
    col_km: string | null;
    col_preco: string | null;
    col_imagem: string | null;
    col_estoque: string | null;
    col_cilindrada: string | null;
    col_tipo: string | null;
    busca_operador: OperadorDeBusca;
  }>(
    `select connection_id, schema_name, table_name, col_nome, col_ano, col_cor,
            col_km, col_preco, col_imagem, col_estoque, col_cilindrada, col_tipo,
            busca_operador
       from public.catalog_mappings
      where organization_id = $1 and enabled`,
    [organizationId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    connectionId: r.connection_id,
    schemaName: r.schema_name,
    tableName: r.table_name,
    colNome: r.col_nome,
    colAno: r.col_ano,
    colCor: r.col_cor,
    colKm: r.col_km,
    colPreco: r.col_preco,
    colImagem: r.col_imagem,
    colEstoque: r.col_estoque,
    colCilindrada: r.col_cilindrada,
    colTipo: r.col_tipo,
    buscaOperador: r.busca_operador,
  };
}

/** As colunas que o modelo deve pedir ao consultar o catálogo (nome + as demais). */
export function colunasParaConsulta(m: CatalogoMapeamento): string[] {
  return [
    m.colNome,
    m.colAno,
    m.colCor,
    m.colKm,
    m.colPreco,
    m.colImagem,
    m.colEstoque,
    m.colCilindrada,
    m.colTipo,
  ].filter((c): c is string => c !== null);
}

/**
 * Bloco de catálogo injetado no SUFIXO do prompt (situacional, por-lead) — nunca
 * no prompt fixo da persona. Diz a tabela, as colunas reais e o operador de
 * busca. Vazio quando não há mapeamento (nada é injetado).
 */
export function renderBlocoCatalogo(m: CatalogoMapeamento | null): string {
  if (m === null) return '';
  const rotulos: Array<[string, string | null]> = [
    ['nome/modelo', m.colNome],
    ['ano', m.colAno],
    ['cor', m.colCor],
    ['quilometragem', m.colKm],
    ['preço', m.colPreco],
    ['foto (imagem)', m.colImagem],
    ['estoque', m.colEstoque],
    ['cilindrada', m.colCilindrada],
    ['tipo', m.colTipo],
  ];
  const mapa = rotulos
    .filter(([, col]) => col !== null)
    .map(([rotulo, col]) => `- ${rotulo}: ${col}`)
    .join('\n');
  return [
    '## Catálogo da loja (configurado nesta conta)',
    `Tabela: ${m.tableName} (agrupamento ${m.schemaName}).`,
    `Coluna de busca (nome): ${m.colNome}, operador "${m.buscaOperador}".`,
    'Colunas disponíveis:',
    mapa,
    'Para apresentar o catálogo, consulte a tabela acima pedindo TODAS as colunas listadas (inclusive a de foto) e filtre pela coluna de nome com o operador indicado. NUNCA invente nome de tabela ou coluna; use exatamente estes.',
  ].join('\n');
}
