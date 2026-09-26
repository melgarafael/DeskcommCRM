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
  | 'versao'
  | 'ano'
  | 'cor'
  | 'km'
  | 'preco'
  | 'imagem'
  | 'estoque'
  | 'cilindrada'
  | 'tipo';

/**
 * A ORDEM do array importa: é a ordem canônica usada (a) para compor o nome da
 * moto a partir das colunas de prioridade 1 e (b) para desempatar quando duas
 * colunas têm a MESMA prioridade. `nome` vem primeiro de propósito — o nome da
 * coluna obrigatória é a base do nome exibido.
 */
export const PAPEIS_COLUNA: readonly PapelColuna[] = [
  'nome',
  'versao',
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
  versao: 'Versão',
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
  // `versao` tem que vir ANTES de `nome`: senão o "contém" de `nome` (não há
  // alias, mas o piso abaixo evita) e o de outros papéis capturariam a coluna.
  // Padrões comuns em schemas de veículo: `versao`, `versão`, `submodelo`.
  ['versao', ['versao', 'versão', 'versao_nome', 'versao_do_modelo', 'submodelo']],
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

/**
 * Distribui os papéis pelas colunas SEM REPETIR nenhum — um papel pertence a
 * UMA coluna (a tela e o banco impõem isso). Resolve o defeito medido na tela:
 * `categoria` e `tipo_combustivel` caíam as duas em `tipo`, e `preco` e
 * `preco_de_tabela_fipe` as duas em `preco`; a auto-detecção criava duas linhas
 * com o mesmo papel e o "Salvar" recusava com "Cada papel só pode ser usado em
 * uma coluna" — sem o dono ter tocado em nada.
 *
 * Regra de desempate, nesta ordem:
 *   1. Papel JÁ CONFIGURADO no mapeamento vence (é decisão do dono, não palpite).
 *   2. Na sequência das colunas, quem chega primeiro fica com o papel detectado;
 *      quem chega depois e cairia no mesmo papel fica SEM papel (`null` =
 *      "Ignorar"), e o dono escolhe na tela se quiser.
 *
 * A ordem de `colunas` é a ordem física da tabela, que costuma pôr a coluna
 * "de verdade" (`categoria`, `preco`) antes da variante (`tipo_combustivel`,
 * `preco_de_tabela_fipe`).
 */
export function atribuirPapeisUnicos(
  colunas: readonly string[],
  papelParaColuna: Partial<Record<PapelColuna, string>> = {},
): Record<string, PapelColuna | null> {
  const usados = new Set<PapelColuna>();
  const porColuna: Record<string, PapelColuna | null> = {};
  const reservados = new Map<string, PapelColuna>();

  // 1) Os papéis configurados vencem — e o primeiro (na ordem canônica) fica.
  for (const papel of PAPEIS_COLUNA) {
    const coluna = papelParaColuna[papel];
    if (!coluna || !colunas.includes(coluna) || usados.has(papel)) continue;
    usados.add(papel);
    reservados.set(coluna, papel);
  }

  // 2) As demais colunas ganham o palpite só se o papel ainda estiver livre.
  for (const coluna of colunas) {
    const reservado = reservados.get(coluna);
    if (reservado) {
      porColuna[coluna] = reservado;
      continue;
    }
    const palpite = detectarPapelColuna(coluna);
    if (palpite && !usados.has(palpite)) {
      usados.add(palpite);
      porColuna[coluna] = palpite;
    } else {
      porColuna[coluna] = null;
    }
  }

  return porColuna;
}

export interface CatalogoMapeamento {
  connectionId: string;
  schemaName: string;
  tableName: string;
  colNome: string;
  colVersao: string | null;
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
  /**
   * Colunas cujo valor aparece na LEGENDA enviada junto com a foto (migration
   * 0250/0251), por NOME DE COLUNA. Independente do papel: uma coluna sem papel
   * pode ser exibida (sai como "NomeDaColuna: valor"); com papel, usa o rótulo
   * bonito ("Preço: …"). Vazio = comportamento antigo (ano, cor, km, preço).
   */
  legenda?: string[];
  /**
   * Configuração POR COLUNA (migration 0251). Vazio ⇒ derivar da configuração
   * antiga (papéis + legenda + ordem), via `configEfetiva`.
   */
  colunas?: ColunaConfig[];
  /**
   * Coluna de REFERÊNCIA de motos similares (ex.: `moto_similar`). Usada SÓ no
   * motor: acha a moto real que cita o pedido. Nunca vai para a IA nem ao cliente.
   */
  colSimilares?: string | null;
}

/** Nenhuma coluna de legenda por padrão (o motor usa o comportamento antigo). */
export const COLUNAS_LEGENDA_PADRAO: readonly string[] = [];

/** Normaliza o `legenda` vindo do banco (jsonb) para uma lista de nomes de coluna. */
export function colunasDaLegenda(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [...COLUNAS_LEGENDA_PADRAO];
  return bruto
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim());
}

/**
 * Configuração POR COLUNA (migration 0251). Substitui o antigo "Papel": o dono
 * marca, coluna a coluna, o que o agente faz com ela. Os quatro controles são
 * INDEPENDENTES e 100% configuráveis (sem lista fixa de exclusão).
 */
export interface ColunaConfig {
  coluna: string;
  /** Valor enviado à IA como contexto. */
  ia?: boolean;
  /** A IA pode usar como filtro na consulta ampla. */
  criterio?: boolean;
  /** Aparece na legenda que vai com a foto. */
  mostrar?: boolean;
  /** O motor usa para ORDENAR as semelhantes. */
  comparar?: boolean;
  /**
   * C-090: coluna de CASAMENTO do modo "Enviar todas que casam" (toggle do
   * agente). Define o que conta como "moto que casa o pedido" quando o
   * interruptor está ligado. Independente de `comparar`/`criterio`.
   */
  envio?: boolean;
  /** Prioridade (1 = mais importante). */
  ordem?: number;
  /** Entra no nome exibido/casável (ex.: `nome` + `versao`). */
  compoeNome?: boolean;
  /** PREFIXO do nome, em maiúsculas (ex.: `marca` → "YAMAHA FZ 15 ..."). */
  prefixoNome?: boolean;
}

/** Normaliza o `colunas` (jsonb) vindo do banco para a lista tipada. */
export function colunasConfiguradas(bruto: unknown): ColunaConfig[] {
  if (!Array.isArray(bruto)) return [];
  const saida: ColunaConfig[] = [];
  for (const item of bruto) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const coluna = typeof o.coluna === 'string' ? o.coluna.trim() : '';
    if (coluna === '') continue;
    saida.push({
      coluna,
      ia: o.ia === true,
      criterio: o.criterio === true,
      mostrar: o.mostrar === true,
      comparar: o.comparar === true,
      envio: o.envio === true,
      ordem:
        typeof o.ordem === 'number' && Number.isFinite(o.ordem) ? o.ordem : undefined,
      compoeNome: o.compoe_nome === true,
      prefixoNome: o.prefixo_nome === true,
    });
  }
  return saida;
}

/** Serializa a lista tipada para o formato do banco (snake_case). */
export function serializarColunasConfig(config: readonly ColunaConfig[]): unknown[] {
  return config.map((c) => ({
    coluna: c.coluna,
    ia: c.ia === true,
    criterio: c.criterio === true,
    mostrar: c.mostrar === true,
    comparar: c.comparar === true,
    ...(c.envio !== undefined ? { envio: c.envio === true } : {}),
    ...(c.ordem !== undefined ? { ordem: c.ordem } : {}),
    compoe_nome: c.compoeNome === true,
    prefixo_nome: c.prefixoNome === true,
  }));
}

/**
 * A configuração efetiva: a nova (`colunas`) quando existe; senão, DERIVADA da
 * antiga (papéis `col_*` + `legenda` + `ordem`). É o que garante que um
 * mapeamento feito antes da 0251 continue funcionando sem reconfigurar.
 */
export function configEfetiva(m: CatalogoMapeamento): ColunaConfig[] {
  if (m.colunas !== undefined && m.colunas.length > 0) return m.colunas;
  const legenda = m.legenda ?? [];
  const ordem = m.ordem ?? {};
  const dePapel: Array<{ papel: PapelColuna; comparar: boolean }> = [
    { papel: 'nome', comparar: true },
    { papel: 'versao', comparar: false },
    { papel: 'ano', comparar: false },
    { papel: 'cor', comparar: false },
    { papel: 'km', comparar: false },
    { papel: 'preco', comparar: true },
    { papel: 'imagem', comparar: false },
    { papel: 'estoque', comparar: false },
    { papel: 'cilindrada', comparar: true },
    { papel: 'tipo', comparar: true },
  ];
  const saida: ColunaConfig[] = [];
  const vistas = new Set<string>();
  for (const { papel, comparar } of dePapel) {
    const coluna = colunaDoPapel(m, papel);
    if (coluna === null) continue;
    vistas.add(coluna);
    saida.push({
      coluna,
      ia: true,
      criterio: true,
      mostrar: legenda.includes(coluna),
      comparar,
      ordem: typeof ordem[papel] === 'number' ? ordem[papel] : undefined,
      compoeNome: ordem[papel] === 1,
    });
  }
  // Colunas da legenda SEM papel (ex.: `marca`, `potencia`): entram só para exibir.
  for (const coluna of legenda) {
    if (vistas.has(coluna)) continue;
    vistas.add(coluna);
    saida.push({ coluna, ia: true, criterio: true, mostrar: true, comparar: false });
  }
  return saida;
}

/** Remove a coluna de REFERÊNCIA: ela é SÓ do motor (nunca vai para a IA). */
function semReferencia(colunas: readonly string[], m: CatalogoMapeamento): string[] {
  const ref = m.colSimilares ?? null;
  return ref === null ? [...colunas] : colunas.filter((c) => c !== ref);
}

/** Colunas cujo valor vai para a IA (contexto). Vazio ⇒ todas as configuradas. */
export function colunasDaIA(m: CatalogoMapeamento): string[] {
  const config = configEfetiva(m);
  const marcadas = config.filter((c) => c.ia === true).map((c) => c.coluna);
  const base = marcadas.length > 0 ? marcadas : config.map((c) => c.coluna);
  return semReferencia(base, m);
}

/** Colunas que a IA pode usar como filtro na consulta ampla. */
export function criteriosDaIA(m: CatalogoMapeamento): string[] {
  const config = configEfetiva(m);
  const marcadas = config.filter((c) => c.criterio === true).map((c) => c.coluna);
  const base = marcadas.length > 0 ? marcadas : config.map((c) => c.coluna);
  return semReferencia(base, m);
}

/** Colunas marcadas para COMPARAR, na ordem de prioridade (menor `ordem` 1º). */
export function colunasDeComparacao(m: CatalogoMapeamento): string[] {  return configEfetiva(m)
    .filter((c) => c.comparar === true)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.ordem ?? 99) - (b.c.ordem ?? 99) || a.i - b.i)
    .map((x) => x.c.coluna);
}

/**
 * C-090: colunas marcadas como "Critério de envio" (casamento do modo "enviar
 * todas que casam"). Sem nenhuma marcada, cai nas colunas de "Critério da IA"
 * (retrocompatível). Remove a coluna de referência (só o motor usa).
 */
export function colunasDeEnvio(m: CatalogoMapeamento): string[] {
  const config = configEfetiva(m);
  const marcadas = config.filter((c) => c.envio === true).map((c) => c.coluna);
  const base = marcadas.length > 0 ? marcadas : criteriosDaIA(m);
  return semReferencia(base, m);
}

/** A coluna de REFERÊNCIA de similares (ex.: `moto_similar`), ou null. */
export function colunaDeSimilares(m: CatalogoMapeamento): string | null {
  return m.colSimilares ?? null;
}

/** Um campo exibido na legenda: a coluna real e o papel (rótulo), se houver. */
export interface CampoDaMoto {
  coluna: string;
  papel: PapelColuna | null;
}

/**
 * Converte o `legenda` (nomes de coluna) em campos de exibição, descobrindo o
 * PAPEL de cada coluna para o rótulo/formatação. Coluna sem papel sai como
 * `null` (o motor usa o próprio nome da coluna).
 */
export function legendaParaExibicao(m: CatalogoMapeamento): CampoDaMoto[] {
  // Fonte: a config nova (`mostrar` por coluna); sem ela, a `legenda` antiga.
  // O PREFIXO do nome (ex.: `marca`) NÃO vira linha: ele já vai na 1ª linha.
  const config = configEfetiva(m);
  const colunas = config
    .filter((c) => c.mostrar === true && c.prefixoNome !== true)
    .map((c) => c.coluna);
  const efetivas = colunas.length > 0 ? colunas : (m.legenda ?? []);
  return efetivas.map((coluna) => {
    const papel = PAPEIS_COLUNA.find((p) => colunaDoPapel(m, p) === coluna) ?? null;
    return { coluna, papel };
  });
}

/** As colunas que o extrator do motor conhece (todas opcionais menos o nome). */
export interface ColunasDoCatalogo {
  nome: string;
  /**
   * Colunas que COMPÕEM o nome exibido/casável, na ordem canônica: sempre o
   * `nome`, mais todas as marcadas como prioridade 1 (ex.: `nome` + `versao` =
   * "Biz 125 Flex"). Vazio/ausente ⇒ só o `nome`.
   */
  nomeComposto?: string[];
  versao?: string;
  ano?: string;
  cor?: string;
  km?: string;
  preco?: string;
  imagem?: string;
  estoque?: string;
  cilindrada?: string;
  tipo?: string;
}

/** O valor de cada papel no mapeamento (ou null quando o papel não foi marcado). */
export function colunaDoPapel(m: CatalogoMapeamento, papel: PapelColuna): string | null {
  switch (papel) {
    case 'nome':
      return m.colNome;
    case 'versao':
      return m.colVersao;
    case 'ano':
      return m.colAno;
    case 'cor':
      return m.colCor;
    case 'km':
      return m.colKm;
    case 'preco':
      return m.colPreco;
    case 'imagem':
      return m.colImagem;
    case 'estoque':
      return m.colEstoque;
    case 'cilindrada':
      return m.colCilindrada;
    case 'tipo':
      return m.colTipo;
  }
}

/**
 * As colunas que formam o "nome correto da moto": o `nome` (sempre) mais todas
 * as marcadas como **prioridade 1**, na ordem canônica de `PAPEIS_COLUNA`. Ex.:
 * `nome` e `versao` ambos prioridade 1 → `["nome", "versao"]` → "Biz 125 Flex".
 *
 * Sem prioridade 1 configurada, devolve só o `nome` (comportamento antigo).
 */
export function colunasDoNome(m: CatalogoMapeamento): string[] {
  // Config nova: as colunas marcadas `compoe_nome` (ordem = ordem de prioridade).
  if (m.colunas !== undefined && m.colunas.length > 0) {
    const config = configEfetiva(m);
    const porOrdem = (
      filtro: (c: ColunaConfig) => boolean,
    ): string[] =>
      config
        .filter(filtro)
        .map((c, i) => ({ c, i }))
        .sort((a, b) => (a.c.ordem ?? 99) - (b.c.ordem ?? 99) || a.i - b.i)
        .map((x) => x.c.coluna);
    const prefixos = porOrdem((c) => c.prefixoNome === true);
    const doNome = porOrdem((c) => c.compoeNome === true && c.prefixoNome !== true);
    return [...new Set([...prefixos, m.colNome, ...doNome])];
  }
  // Config antiga: papéis de prioridade 1.
  const prioridade = m.ordem ?? {};
  const prioridade1 = PAPEIS_COLUNA.filter(
    (papel) => (prioridade[papel] ?? 0) === 1 && colunaDoPapel(m, papel) !== null,
  ).map((papel) => colunaDoPapel(m, papel)!);
  return [...new Set([m.colNome, ...prioridade1])];
}

/** Converte o mapeamento no formato que `fotos-do-catalogo.ts` entende. */
export function colunasDoCatalogo(m: CatalogoMapeamento): ColunasDoCatalogo {
  return {
    nome: m.colNome,
    nomeComposto: colunasDoNome(m),
    ...(m.colVersao !== null ? { versao: m.colVersao } : {}),
    ...(m.colAno !== null ? { ano: m.colAno } : {}),
    ...(m.colCor !== null ? { cor: m.colCor } : {}),
    ...(m.colKm !== null ? { km: m.colKm } : {}),
    ...(m.colPreco !== null ? { preco: m.colPreco } : {}),
    ...(m.colImagem !== null ? { imagem: m.colImagem } : {}),
    ...(m.colEstoque !== null ? { estoque: m.colEstoque } : {}),
    ...(m.colCilindrada !== null ? { cilindrada: m.colCilindrada } : {}),
    ...(m.colTipo !== null ? { tipo: m.colTipo } : {}),
    // Legenda efetiva (config nova OU antiga) — é o que decide o que aparece.
    ...(() => {
      const legenda = legendaParaExibicao(m).map((c) => c.coluna);
      return legenda.length > 0 ? { legendaColunas: legenda } : {};
    })(),
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
    col_versao: string | null;
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
    legenda: unknown;
    colunas: unknown;
    col_similares: string | null;
  }>(
    `select connection_id, schema_name, table_name, col_nome, col_versao, col_ano, col_cor,
            col_km, col_preco, col_imagem, col_estoque, col_cilindrada, col_tipo,
            busca_operador, similaridade_deterministica, similares_qtd, ordem, legenda,
            colunas, col_similares
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
    colVersao: r.col_versao,
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
    legenda: colunasDaLegenda(r.legenda),
    colunas: colunasConfiguradas(r.colunas),
    colSimilares: r.col_similares,
  };
}

/**
 * Critérios de semelhança na ORDEM configurada (1 = mais importante).
 *
 * `nome` entra na lista: é o critério textual do "nome correto" (que pode ser
 * `nome` + `versao` compostos). Os demais continuam sendo DISTÂNCIA: cilindrada
 * e preço; `tipo` é neutro. Sem ordem configurada, cai no default
 * `cilindrada → preco` (comportamento antigo).
 */
export function criteriosDeSimilaridade(
  m: CatalogoMapeamento,
): Array<'nome' | 'cilindrada' | 'preco' | 'tipo'> {
  const ordem = m.ordem ?? {};
  const possiveis: Array<'nome' | 'cilindrada' | 'preco' | 'tipo'> = [
    'nome',
    'cilindrada',
    'preco',
    'tipo',
  ];
  const comOrdem = possiveis
    .filter((p) => typeof ordem[p] === 'number')
    .sort((a, b) => (ordem[a] ?? 99) - (ordem[b] ?? 99));
  return comOrdem.length > 0 ? comOrdem : ['cilindrada', 'preco'];
}

/** As colunas que o modelo deve pedir ao consultar o catálogo (nome + as demais). */
export function colunasParaConsulta(m: CatalogoMapeamento): string[] {
  return [
    m.colNome,
    m.colVersao,
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
    ['versão', m.colVersao],
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
  const nomeComposto = colunasDoNome(m);
  const dicaNome =
    nomeComposto.length > 1
      ? `O nome completo da moto é a junção de ${nomeComposto.map((c) => `"${c}"`).join(' + ')}.`
      : '';
  const dicaLegenda =
    m.legenda !== undefined && m.legenda.length > 0
      ? `A legenda enviada com a foto mostra: ${m.legenda.join(', ')} (não omita estas colunas na consulta).`
      : '';
  // Definições curtas dos conceitos usuais de catálogo de moto — ajudam o modelo
  // a interpretar colunas como `versao`, `cilindrada`, `categoria` mesmo sem papel.
  const DEFINICOES: ReadonlyArray<[RegExp, string]> = [
    [/vers(ao|ão|ion)/i, 'versão: variação de um mesmo modelo, diferenciada por acabamento, equipamentos, motorização ou configuração (ex.: "FLEX", "ABS", "ED").'],
    [/cilindr|\bcc\b/i, 'cilindrada: volume total do motor em cm³ (ex.: 300).'],
    [/categoria|tipo|segmento/i, 'tipo/categoria: segmento de uso da moto (ex.: Naked, Street, Esportiva, Trail/Adventure, Scooter).'],
    [/preco|preço|valor/i, 'preço: valor de venda da moto.'],
    [/quilometragem|\bkm\b|odometro/i, 'quilometragem: distância já rodada, em km (moto usada/seminova).'],
    [/estoque|quantidade|\bqtd\b/i, 'estoque: quantidade disponível para venda.'],
    [/\bano\b|ano_modelo|ano_fabricacao/i, 'ano: ano do modelo/fabricação.'],
    [/\bcor\b/i, 'cor: cor da moto.'],
    [/imagem|foto|url/i, 'foto: URL da imagem da moto.'],
    [/^(nome|modelo|titulo)$/i, 'nome/modelo: o nome comercial da moto.'],
  ];
  const nomesConfigurados = configEfetiva(m).map((c) => c.coluna);
  const definicoes = [
    ...new Set(
      nomesConfigurados
        .map((nome) => DEFINICOES.find(([re]) => re.test(nome))?.[1])
        .filter((d): d is string => d !== undefined),
    ),
  ];
  const dicaGlossario =
    definicoes.length > 0
      ? `O que significa cada coluna:\n${definicoes.map((d) => `- ${d}`).join('\n')}`
      : '';
  const criterios = criteriosDaIA(m);
  const dicaCriterios =
    criterios.length > 0
      ? `Colunas de CRITÉRIO para a busca ampla (use quando não achar o pedido): ${criterios.join(', ')}.`
      : '';
  const instrucaoAmpliar = criterios.length > 0
    ? `Ao consultar o catálogo, informe SEMPRE o parâmetro \`criterios\` com o que você deduziu do pedido, por coluna (ex.: {"marca":"Yamaha","categoria":"Naked","cilindrada":689}). Se o modelo pedido NÃO existir, o sistema usa esses critérios para ordenar as motos parecidas e oferecer as melhores — não pare em "não temos". Se a ferramenta devolver \`valores_dos_criterios\`, escolha o valor que MAIS se parece com o que o cliente quer (ex.: naked → "Naked"; trail → "Adventure / Trilha") e REFAÇA a consulta com \`criterios\` preenchido. O SISTEMA já prioriza automaticamente as motos equivalentes cadastradas na loja — não invente modelos nem ofereça motos que não vieram do banco.`
    : '';
  return [
    '## Catálogo da loja (configurado nesta conta)',
    `Tabela: ${m.tableName} (agrupamento ${m.schemaName}).`,
    `Coluna de busca (nome): ${m.colNome}, operador "${m.buscaOperador}".`,
    'Colunas disponíveis:',
    mapa,
    ...(dicaNome !== '' ? [dicaNome] : []),
    ...(dicaLegenda !== '' ? [dicaLegenda] : []),
    ...(dicaCriterios !== '' ? [dicaCriterios] : []),
    ...(dicaGlossario !== '' ? [dicaGlossario] : []),
    ...(instrucaoAmpliar !== '' ? [instrucaoAmpliar] : []),
    // O sistema JÁ usa as colunas configuradas quando `colunas` é omitido (evita
    // `select *` e a resposta estourar o teto de bytes e vir truncada). Pedir
    // colunas explícitas fica permitido, mas omitir é o caminho seguro.
    'Para apresentar o catálogo, consulte a tabela acima SEM informar `colunas` (o sistema já usa as colunas configuradas) e filtre pela coluna de nome com o operador indicado. NUNCA invente nome de tabela ou coluna; use exatamente estes.',
    // Erro de filtro incompleto NÃO é indisponibilidade — o modelo (lite) já
    // respondeu "instabilidade técnica" ao cliente por causa disto (medido).
    'Se a ferramenta responder `filtro_sem_valor`, refaça a consulta na hora incluindo `valor` no filtro; NUNCA diga ao cliente que o sistema está instável ou fora do ar.',
    // O motor envia as fotos sozinho (uma por moto escolhida). O modelo não sabe
    // quantas serão — então a abertura NÃO deve cravar um número, senão o texto
    // ("separei a CB 300") não bate com as fotos enviadas (medido ao vivo).
    `Ao oferecer motos semelhantes sem mandar foto, o SISTEMA envia uma foto por moto escolhida (hoje até ${m.similaresQtd ?? 3}). Na sua abertura, NÃO diga o número exato nem cite só uma — diga "algumas opções" — para o texto bater com as fotos que forem enviadas.`,
  ].join('\n');
}
