/**
 * Quais TIPOS de link do contato esta organização mostra (#5128).
 *
 * ── Por que a escolha mora em `organizations.settings` ───────────────────────
 *
 * É jsonb que já existe. Uma coluna nova exigiria migration + apêndice no
 * baseline, que é o arquivo que mais muda a cada atualização do produto — e o
 * dado aqui é preferência de apresentação, não relação. Mesmo caminho de
 * `settings.routing`, `settings.prospeccao` e `settings.crm`.
 *
 * ── O formato ───────────────────────────────────────────────────────────────
 *
 *     { "links_de_contato": { "tipos": ["instagram", "linkedin"] } }
 *
 * A lista é gravada na ORDEM DO CATÁLOGO (não na ordem em que chegou), então a
 * tela nunca depende do que o PATCH mandou.
 *
 * ── A garantia dura: lixo não muda nada ─────────────────────────────────────
 *
 * Ausente, tipo errado, lista vazia ou id fora do catálogo devolvem o catálogo
 * INTEIRO — exatamente o comportamento de antes da #5128. Quem já instalou não
 * vê diferença nenhuma até alguém abrir a tela e salvar. E nunca lança: um jsonb
 * corrompido derrubaria a ficha do contato e o funil junto.
 */
import { TIPOS_DE_LINK, type TipoDeLink } from "./links-de-contato";

/** Chave em `organizations.settings` — irmã de `routing`, `prospeccao` e `crm`. */
export const CHAVE_DOS_TIPOS_DE_LINK = "links_de_contato";

/** O catálogo inteiro, na ordem dele. A escolha padrão de quem nunca ajustou. */
export const TODOS_OS_TIPOS_DE_LINK: readonly TipoDeLink[] = TIPOS_DE_LINK.map(({ id }) => id);

const IDS_DO_CATALOGO = new Set<string>(TODOS_OS_TIPOS_DE_LINK);

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/**
 * A lista CRUA (o `tipos` de `settings.links_de_contato`) → ids válidos em ordem
 * de catálogo, ou `null` quando não há escolha legível.
 *
 * `null` é o sinal de "vale o catálogo inteiro" — quem chama decide se prefere o
 * default; a função nunca devolve `[]` para lixo, para a tela não sumir por
 * causa de um jsonb estranho.
 */
export function normalizarTiposDeLink(bruto: unknown): TipoDeLink[] | null {
  // Aceita a lista crua e o envelope `{ tipos: [...] }`: a segunda forma é a que
  // fica gravada, e a primeira evita quebrar se algum dia alguém gravar só ela.
  const lista = Array.isArray(bruto) ? bruto : objeto(bruto)?.tipos;
  if (!Array.isArray(lista) || lista.length === 0) return null;

  const marcados = new Set<string>();
  for (const id of lista) {
    // Um id desconhecido NÃO é descartado em silêncio: a lista inteira cai para o
    // catálogo cheio, porque "achei um id estranho" não é base para esconder
    // campo de ninguém. É a mesma régua do teste da #5128.
    if (typeof id !== "string" || !IDS_DO_CATALOGO.has(id)) return null;
    marcados.add(id);
  }
  return TODOS_OS_TIPOS_DE_LINK.filter((id) => marcados.has(id));
}

/**
 * A escolha da organização — a função que as telas usam.
 *
 * Recebe o `settings` CRU (qualquer coisa) e devolve sempre uma lista não vazia,
 * em ordem de catálogo. Sem o ajuste, é o catálogo inteiro.
 */
export function tiposDeLinkHabilitados(settings: unknown): TipoDeLink[] {
  const bruto = objeto(settings)?.[CHAVE_DOS_TIPOS_DE_LINK];
  return normalizarTiposDeLink(bruto) ?? [...TODOS_OS_TIPOS_DE_LINK];
}

/**
 * O `settings` NOVO: preserva todas as outras chaves (inclusive as irmãs dentro
 * de `links_de_contato`, se um dia existirem) e grava só `tipos`.
 *
 * Vazio vira catálogo inteiro: "nenhum tipo marcado" não é um estado que a tela
 * ofereça (o PATCH recusa menos de um), e o jsonb escrito à mão com `[]` cai no
 * mesmo default da leitura — nunca numa ficha sem link nenhum.
 */
export function settingsComTiposDeLink(
  settings: unknown,
  tipos: readonly TipoDeLink[],
): Record<string, unknown> {
  const base = objeto(settings) ?? {};
  const atual = objeto(base[CHAVE_DOS_TIPOS_DE_LINK]) ?? {};
  const marcados = new Set<string>(tipos);
  const escolhidos = TODOS_OS_TIPOS_DE_LINK.filter((id) => marcados.has(id));
  return {
    ...base,
    [CHAVE_DOS_TIPOS_DE_LINK]: {
      ...atual,
      tipos: escolhidos.length > 0 ? escolhidos : [...TODOS_OS_TIPOS_DE_LINK],
    },
  };
}
