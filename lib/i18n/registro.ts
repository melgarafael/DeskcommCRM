/**
 * O REGISTRO DE IDIOMAS — o único lugar onde um idioma existe.
 *
 * ─── O problema que ele resolve ────────────────────────────────────────────
 *
 * Antes deste arquivo, "o produto fala espanhol" estava escrito à mão em seis
 * lugares: a lista `IDIOMAS`, os nomes do seletor do topo, as opções do perfil,
 * as da organização, a tag BCP-47 e o casamento do `Accept-Language`. Um idioma
 * novo exigia lembrar de todos, e o PR #773 (chinês) mostrou o custo do outro
 * lado: acrescentar o código numa lista o fazia APARECER em todas elas no mesmo
 * commit em que entrava o primeiro caractere traduzido.
 *
 * ─── O nível é a promessa, e ele decide o que aparece ──────────────────────
 *
 * - `em_construcao`: está sendo traduzido. Não aparece em tela nenhuma, não é
 *   servido a ninguém e não reprova ninguém — quem acrescenta uma frase em
 *   português não precisa escrever a versão deste idioma.
 * - `telas_principais`: aparece. A régua de "telas principais" é medida, e ela
 *   ainda não existe (fatia 5 do PROG-022) — por isso nenhum idioma pode
 *   declarar este nível hoje, e um teste reprova quem declarar.
 * - `completo`: aparece, e toda frase de tela precisa dele. É o nível do
 *   espanhol, e nada nele afrouxa.
 *
 * Quem decide o que é visível é o TIPO, não uma lista paralela: `Idioma` só
 * inclui códigos cujo nível aparece. Promover um idioma é mudar uma linha
 * aqui, e o compilador aponta cada lugar que passa a precisar dele (o `Locale`
 * de data em `datas.ts`, por exemplo).
 *
 * ─── Por que o `Locale` de data NÃO mora aqui ──────────────────────────────
 *
 * Este arquivo é importado por componente cliente e não pode arrastar os
 * objetos do `date-fns`; e `tests/unit/i18n-a-data-segue-o-idioma` só permite
 * importar `date-fns/locale` na camada de data. O mapa `Record<Idioma, Locale>`
 * de `datas.ts` segue exaustivo, e é ele que o compilador cobra na promoção.
 */

export type NivelDeIdioma = "em_construcao" | "telas_principais" | "completo";

export interface IdiomaRegistrado {
  /** O que se grava em `user_metadata.locale` e `organizations.locale`. */
  readonly codigo: string;
  /** Cada língua no nome dela própria: é assim que se reconhece a sua numa lista que você não sabe ler. */
  readonly nomeNativo: string;
  /** O que cabe no botão do topo, no espaço de um ícone. */
  readonly rotuloCurto: string;
  /** Para `Intl` e `toLocale*String`. */
  readonly tagBcp47: string;
  /** As subtags primárias do `Accept-Language` que levam a este idioma (`pt-PT` → `pt` → `pt-BR`). */
  readonly subtagsDoNavegador: readonly string[];
  readonly nivel: NivelDeIdioma;
  /** Quem responde pela tradução. `null` enquanto ninguém assumiu. */
  readonly mantenedor: string | null;
}

export const REGISTRO_DE_IDIOMAS = [
  {
    codigo: "pt-BR",
    nomeNativo: "Português (BR)",
    rotuloCurto: "PT",
    tagBcp47: "pt-BR",
    subtagsDoNavegador: ["pt"],
    nivel: "completo",
    mantenedor: "mantenedores do projeto",
  },
  {
    codigo: "es",
    nomeNativo: "Español",
    rotuloCurto: "ES",
    // `es` e não `es-ES`: o público é a América Latina, e com `es` puro o
    // navegador resolve pela região de quem lê.
    tagBcp47: "es",
    subtagsDoNavegador: ["es"],
    nivel: "completo",
    mantenedor: "mantenedores do projeto",
  },
  {
    codigo: "zh-CN",
    nomeNativo: "简体中文",
    rotuloCurto: "中",
    tagBcp47: "zh-CN",
    subtagsDoNavegador: ["zh"],
    // A tradução chega pelo PR #773, de @xxjjjj. Registrar o idioma antes do
    // catálogo é o que deixa o catálogo entrar sem aparecer para ninguém.
    nivel: "em_construcao",
    mantenedor: null,
  },
] as const satisfies readonly IdiomaRegistrado[];

export type IdiomaDoRegistro = (typeof REGISTRO_DE_IDIOMAS)[number];

/** Um idioma cujo nível permite aparecer para quem usa. */
export type IdiomaVisivel = Extract<IdiomaDoRegistro, { nivel: "telas_principais" | "completo" }>;

/** O nível deste idioma deixa ele aparecer para quem usa? */
export function nivelApareceParaQuemUsa(nivel: NivelDeIdioma): boolean {
  return nivel !== "em_construcao";
}

function ehVisivel(idioma: IdiomaDoRegistro): idioma is IdiomaVisivel {
  return nivelApareceParaQuemUsa(idioma.nivel);
}

/** Os idiomas que aparecem, na ordem do registro — o padrão do produto primeiro. */
export const IDIOMAS_VISIVEIS: readonly IdiomaVisivel[] = REGISTRO_DE_IDIOMAS.filter(ehVisivel);

/** Os que ainda não aparecem: citados na mensagem dos gates, para quem contribui saber que não precisa deles. */
export const IDIOMAS_EM_CONSTRUCAO: readonly IdiomaDoRegistro[] = REGISTRO_DE_IDIOMAS.filter(
  (idioma) => !nivelApareceParaQuemUsa(idioma.nivel),
);

/**
 * Os dados de um idioma visível. O tipo garante que o código é visível; o
 * padrão do produto (a primeira linha do registro) é só a rede para um valor
 * que tenha escapado do tipo em tempo de execução — nunca uma tela quebrada.
 */
export function idiomaVisivelPorCodigo(codigo: IdiomaVisivel["codigo"]): IdiomaVisivel {
  return IDIOMAS_VISIVEIS.find((idioma) => idioma.codigo === codigo) ?? REGISTRO_DE_IDIOMAS[0];
}
