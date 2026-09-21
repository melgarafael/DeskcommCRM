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

/** Papéis que uma coluna do catálogo pode exercer. */
export type PapelColuna =
  | 'nome'
  | 'ano'
  | 'cor'
  | 'km'
  | 'preco'
  | 'imagem'
  | 'estoque'
  | 'cilindrada'
  | 'tipo';

export const PAPEIS_COLUNA: readonly PapelColuna[] = [
  'nome',
  'ano',
  'cor',
  'km',
  'preco',
  'imagem',
  'estoque',
  'cilindrada',
  'tipo',
];

/** Rótulos legíveis de cada papel (UI e legenda). */
export const ROTULO_DO_PAPEL: Record<PapelColuna, string> = {
  nome: 'Nome / modelo',
  ano: 'Ano',
  cor: 'Cor',
  km: 'Quilometragem',
  preco: 'Preço',
  imagem: 'Foto (URL da imagem)',
  estoque: 'Estoque',
  cilindrada: 'Cilindrada',
  tipo: 'Tipo',
};

const ALIASES_DE_PAPEL: ReadonlyArray<[PapelColuna, readonly string[]]> = [
  ['imagem', ['imagem_url', 'imagem_principal', 'url_imagem', 'foto_url', 'imagem', 'foto', 'fotos']],
  ['cilindrada', ['cilindrada', 'cilindradas', 'cc', 'motor']],
  ['km', ['quilometragem', 'quilometros', 'km', 'odometro', 'rodagem']],
  ['preco', ['preco', 'preço', 'valor', 'preco_promocional', 'valor_promocional']],
  ['estoque', ['estoque', 'quantidade', 'qtd']],
  ['tipo', ['tipo', 'categoria', 'segmento']],
  ['cor', ['cor', 'coloracao']],
  ['ano', ['ano', 'ano_modelo', 'ano_fabricacao']],
  ['nome', ['nome', 'titulo', 'title', 'descricao_curta']],
];

function normalizarColuna(nome: string): string {
  return nome
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Chuta o PAPEL de uma coluna pelo nome (o dono ajusta na tela se errar).
 * Igualdade exata primeiro; depois "contém" — assim `preco` ganha de
 * `preco_promocional` quando a coluna é literalmente `preco`.
 */
export function detectarPapelColuna(nome: string): PapelColuna | null {
  const n = normalizarColuna(nome);
  if (n === '') return null;
  for (const [papel, aliases] of ALIASES_DE_PAPEL) {
    if (aliases.some((a) => normalizarColuna(a) === n)) return papel;
  }
  for (const [papel, aliases] of ALIASES_DE_PAPEL) {
    if (aliases.some((a) => a !== '' && n.includes(normalizarColuna(a)))) return papel;
  }
  return null;
}

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
  /** Regras do catálogo (migration 0245). Opcionais na leitura por robustez. */
  similaridadeDeterministica?: boolean;
  similaresQtd?: number;
  /** Prioridade por papel (1 = mais importante). */
  ordem?: Partial<Record<PapelColuna, number>>;
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
    similaridade_deterministica: boolean;
    similares_qtd: number;
    ordem: Partial<Record<PapelColuna, number>> | null;
  }>(
    `select connection_id, schema_name, table_name, col_nome, col_ano, col_cor,
            col_km, col_preco, col_imagem, col_estoque, col_cilindrada, col_tipo,
            busca_operador, similaridade_deterministica, similares_qtd, ordem
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
    similaridadeDeterministica: r.similaridade_deterministica ?? false,
    similaresQtd: r.similares_qtd ?? 3,
    ordem: r.ordem ?? {},
  };
}

/**
 * Critérios de semelhança na ORDEM configurada (1 = mais importante), restritos
 * aos que participam da escolha. Sem ordem configurada, cai no default
 * `cilindrada → preco`.
 */
export function criteriosDeSimilaridade(m: CatalogoMapeamento): Array<'cilindrada' | 'preco' | 'tipo'> {
  const ordem = m.ordem ?? {};
  const possiveis: Array<'cilindrada' | 'preco' | 'tipo'> = ['cilindrada', 'preco', 'tipo'];
  const comOrdem = possiveis
    .filter((p) => typeof ordem[p] === 'number')
    .sort((a, b) => (ordem[a] ?? 99) - (ordem[b] ?? 99));
  return comOrdem.length > 0 ? comOrdem : ['cilindrada', 'preco'];
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
    // O motor envia as fotos sozinho (uma por moto escolhida). O modelo não sabe
    // quantas serão — então a abertura NÃO deve cravar um número, senão o texto
    // ("separei a CB 300") não bate com as fotos enviadas (medido ao vivo).
    `Ao oferecer motos semelhantes sem mandar foto, o SISTEMA envia uma foto por moto escolhida (hoje até ${m.similaresQtd ?? 3}). Na sua abertura, NÃO diga o número exato nem cite só uma — diga "algumas opções" — para o texto bater com as fotos que forem enviadas.`,
  ].join('\n');
}
