/**
 * O PADRÃO DE BUSCA QUE CASA ACENTO DOS DOIS LADOS — sem `unaccent` no banco (#1835, F2).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 * A listagem de contatos manda o termo para quatro colunas com `.ilike`, e
 * `ILIKE` dobra a CAIXA, não o ACENTO: `lower("Á") = "á"`, que não é `"a"`.
 * Medido na issue #1835:
 *
 *     digitado   coluna no banco   resultado
 *     "Joao"     "João"            ZERO  — a pessoa jura que o cadastro sumiu
 *     "João"     "Joao"            ZERO
 *     "MARCIA"   "Márcia"          ZERO
 *
 * E no banco a extensão nem está: `git grep unaccent origin/main -- supabase/`
 * = 0 ocorrências (o `baseline.sql` cria só `pgcrypto`), então não há `unaccent`
 * a chamar do lado de lá — e chamá-lo exigiria coluna materializada + migração.
 *
 * ─── A régua ────────────────────────────────────────────────────────────────
 * O `ILIKE` compara contra o valor CRU do banco, então a comparação tem de ser
 * nossa dos dois lados. Este módulo faz o lado do TERMO; o lado da COLUNA vira
 * classe de caracteres no padrão — `jo[aáàâãä]o` casa `joao`, `João`, `JOÃO` e
 * `JOAO` num risco só, e o operador `imatch` do PostgREST (`~*`) resolve a
 * caixa:
 *
 *     name.imatch..*jo[aáàâãä]o.*     →  "João Silva" E "Joao Souza"
 *
 * É a MESMA decisão de `lib/catalogo/busca.ts` ("Sem `unaccent` no banco: a
 * normalização de acento é nossa"), levada para a porta do PostgREST em vez de
 * para uma comparação em memória — a busca de contatos precisa de cursor, de
 * ordenação e de recorte por organização no banco, e filtrar depois da página
 * entregaria página errada.
 *
 * ─── Medido contra o PostgREST de verdade (docker postgrest/postgrest:latest
 * sobre postgres:17, 05/10/2026) ────────────────────────────────────────────
 *
 *     or=(name.imatch..*jo[aáàâãä]o.*)           → João Silva, Joao Souza   ✓
 *     or=(name.imatch..*st\..*paul.*)            → St. Paul Ltd             ✓
 *     or=(name.imatch..*👍.*)                    → Maria 👍 Santos           ✓
 *     or=(4 colunas imatch + phone_number.ilike) → 6 linhas, um só or=      ✓
 *     or=(name.imatch..*(abc).*)                 → 2201B parêntese          ✗ (por isso
 *                                                    os parênteses saem ANTES, no handler)
 *     or=(name.imatch.*a,b.*)                    → PGRST100 split na vírgula ✗ (a vírgula
 *                                                    vira separador em `normalizarTermoDeBusca`)
 *
 * O que este módulo NÃO faz: nada de banco. Nenhuma migração, nenhum índice,
 * nenhuma coluna — só o padrão que sai do handler.
 */
import { normalizarTermoDeBusca } from "@/lib/inbox/termo-de-busca";

/**
 * Letra base → as grafias acentuadas que ela admite em português.
 *
 * É uma TABELA e não um laço por code point de propósito: a classe tem de ser
 * curta e legível no log do `.or()`, e o que interessa é o que se digita num
 * nome de cliente. Letra acentuada FORA da tabela (`ñ`, `ë`, `å`, `ò`) não vira
 * classe nem perde o acento: sai literal, e o `~*` resolve a caixa — então
 * "Peña" continua achando "Peña", como o `ilike` achava.
 */
const GRAFIAS: Record<string, string> = {
  a: "áàâãä",
  e: "éêè",
  i: "íîï",
  o: "óôõö",
  u: "úü",
  c: "ç",
};

/**
 * Tira o acento das LETRAS e só das letras.
 *
 * ⚠️ O `\p{M}` só é removido quando vem DEPOIS de uma letra (`\p{L}\p{M}+`).
 * Um `replace(/\p{M}/gu, "")` às cegas comeria o `U+FE0F` (variation selector)
 * que fecha emoji como ❤️, e a busca por emoji deixaria de achar o cadastro que
 * tem emoji — é o "sem quebrar a busca por emoji" da issue, medido no próprio
 * padrão.
 */
function semAcento(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/(\p{L})\p{M}+/gu, "$1")
    .normalize("NFC");
}

/** Caractere literal dentro de um padrão POSIX: os metacaracteres viram barra + letra. */
function escapar(caractere: string): string {
  return caractere.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * O padrão `imatch` (regex `~*`) para o termo QUE A PESSOA DIGITOU.
 *
 * Composição, nesta ordem — cada passo conserta um defeito medido:
 *
 * 1. `normalizarTermoDeBusca` — espaço duplo, vírgula e ponto e vírgula viram
 *    UM curinga; é a régua única da #1892 (`lib/inbox/termo-de-busca.ts`).
 * 2. laço por caractere (em NFC) — `*` vira `.*`, e `*` seguidos viram UM
 *    `.*` só (`a***b` → `a.*b`: sem o colapso, 400 asteriscos viravam
 *    `.*.*.*…`, 28 s por coluna, e com 3000 o Postgres recusava com
 *    `regular expression is too complex` — o `ilike` também colapsava os `%`).
 *    Letra cuja base está na tabela E cuja grafia a tabela admite vira classe
 *    (`a`/`á`/`Ã` → `[aáàâãäAÁÀÂÃÄ]`): é ela que faz "João" e "Joao" casarem a
 *    grafia QUE ESTÁ NO BANCO nos dois sentidos. O resto é literal escapado —
 *    `100%` e `a_b`, como no `ilike`, e a letra acentuada fora da tabela, que
 *    perder o acento faria deixar de achar a própria grafia ("Peña").
 * 3. `.*` nas pontas — "contém", a mesma semântica do `%…%` do `ilike`.
 *
 * ⛔ O termo tem de chegar com os PARÊNTESES removidos (`termoDeTexto`, no
 * handler): `(` e `)` são o agrupamento do DSL do `.or()` do PostgREST, e um
 * valor com parêntese derruba o filtro inteiro com HTTP 400 (medido: `2201B
 * parentheses () not balanced`). A vírgula nem chega: `normalizarTermoDeBusca`
 * a usa como separador, e é ela que splitaria as condições do `.or()`.
 *
 * Termo normalizado VAZIO não deve chegar aqui — é o piso (`buscaValeConsulta`)
 * que recusa antes; um padrão vazio vira `.*.*`, que casa tudo.
 */
export function padraoRegexDeBusca(bruto: string): string {
  const termo = normalizarTermoDeBusca(bruto).normalize("NFC");

  let corpo = "";
  for (const caractere of termo) {
    if (caractere === "*") {
      if (!corpo.endsWith(".*")) corpo += ".*";
      continue;
    }
    const base = semAcento(caractere).toLowerCase();
    const grafias = GRAFIAS[base];
    const baixo = caractere.toLowerCase();
    if (grafias !== undefined && (baixo === base || grafias.includes(baixo))) {
      // As duas caixas entram na classe: `imatch` já dobra a caixa do texto
      // solto, mas a classe é montada aqui e não depende de dobramento nenhum
      // para casar — a prova está no teste, não nesta frase.
      corpo += `[${base}${grafias}${base.toUpperCase()}${grafias.toUpperCase()}]`;
      continue;
    }
    corpo += escapar(caractere);
  }

  return `.*${corpo}.*`;
}
