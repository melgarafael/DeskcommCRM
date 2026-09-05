/**
 * Conversão de valor digitado (reais) para centavos.
 *
 * A versão anterior vivia copiada em três formulários de lead e fazia
 * `reais.replace(/\./g, "").replace(",", ".")` — ou seja, tratava TODO ponto
 * como separador de milhar. Quem digitasse "249.90" (o jeito natural em
 * teclado numérico) tinha o valor gravado como R$ 24.990,00: cem vezes maior,
 * sem erro na tela, alimentando funil e relatórios com número errado.
 *
 * A regra aqui desambigua sem adivinhação, porque em pt-BR grupo de milhar tem
 * SEMPRE 3 dígitos:
 *
 *   "249,90"      → vírgula é decimal                       → 24990
 *   "249.90"      → ponto seguido de 2 dígitos é decimal    → 24990
 *   "1.234"       → ponto seguido de 3 dígitos é milhar     → 123400
 *   "1.234,56"    → tem vírgula: pontos são milhar          → 123456
 *   "1,234.56"    → formato en: o último separador é decimal→ 123456
 *   "1.234.567"   → todos os grupos com 3 dígitos           → 123456700
 *
 * Devolve null quando não dá para ler um número — quem chama decide a mensagem.
 */
export function parseReaisToCents(input: string): number | null {
  const raw = input.trim();
  if (raw.length === 0) return null;
  if (!/^[\d.,\s]+$/.test(raw)) return null;

  const s = raw.replace(/\s/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  let decimalSep = "";
  if (lastComma >= 0 && lastDot >= 0) {
    // Os dois presentes: o que vem por último é o decimal (pt-BR ou en).
    decimalSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma >= 0) {
    decimalSep = ",";
  } else if (lastDot >= 0) {
    // Só ponto: é milhar apenas se o grupo final tiver exatamente 3 dígitos.
    decimalSep = s.length - lastDot - 1 === 3 ? "" : ".";
  }

  let normalized: string;
  if (decimalSep === "") {
    normalized = s.replace(/[.,]/g, "");
  } else {
    const cut = decimalSep === "," ? lastComma : lastDot;
    const inteiro = s.slice(0, cut).replace(/[.,]/g, "");
    const frac = s.slice(cut + 1);
    if (!/^\d*$/.test(frac)) return null;
    normalized = `${inteiro || "0"}.${frac}`;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Centavos → "R$ 249,90". Para eco na tela do que foi entendido. */
export function formatCentsBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Centavos de DÓLAR → "US$ 249,90". Para todo número que sai de
 * `llm_calls.cost_cents` / `ai_invocations.cost_cents`.
 *
 * ⚠️ EXISTE PORQUE O NÚMERO É DÓLAR E SETE TELAS O ESCREVIAM EM REAL.
 * `lib/agent-engine/edge/llm/pricing.ts` cota o provedor em USD e grava centavo
 * de USD; formatar em BRL fazia o dono do negócio ler um valor ~5x menor do que
 * o que estava sendo cobrado dele — e, depois que o teto passou a vincular,
 * armar um limite ~5x maior do que pensava. A conversão de moeda NÃO é feita
 * (exigiria fonte de câmbio, dependência externa nova num produto self-host):
 * o que muda é o rótulo dizer a unidade real.
 *
 * Vírgula decimal porque a frase é pt-BR; "US$" porque a moeda é dólar. É a
 * mesma escolha de `emDolares` em `lib/agent-engine/edge/llm/orcamento.ts` —
 * mas ali ela não pode importar daqui (o módulo é do engine e roda no worker).
 */
export function formatCentsUSD(cents: number): string {
  return ((cents ?? 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "USD" });
}

/**
 * Centavos → o preço escrito na convenção da MOEDA. `formatCents(24990, "MXN")`
 * devolve `$249.90`.
 *
 * ─── Por que a moeda escolhe o formato, e não o idioma da interface ────────
 *
 * O reflexo era reusar `tagDeIdioma()` — o produto já resolve `pt-BR`/`es` para
 * quem está lendo, e passar isso ao `Intl` parecia de graça. Medido antes de
 * escrever, e é o contrário:
 *
 *     Intl.NumberFormat("es",    {currency:"MXN"}) -> "249,90 MXN"
 *     Intl.NumberFormat("es-MX", {currency:"MXN"}) -> "$249.90"
 *
 * `es` puro resolve para a ESPANHA: vírgula decimal e o código ISO depois do
 * número. Quem vende no México lê `$249.90`. São duas perguntas diferentes com
 * a mesma cara: o idioma da tela é preferência de quem LÊ e muda de pessoa para
 * pessoa; a moeda é fato do NEGÓCIO e é a mesma para todo mundo que abre aquele
 * catálogo. Quem manda no separador decimal é a segunda.
 *
 * ─── Por que não há tabela de moeda → locale ───────────────────────────────
 *
 * Toda tabela escrita à mão nasce incompleta, e a coluna aceita qualquer
 * `^[A-Z]{3}$`. O código ISO-4217 já carrega a região nas duas primeiras letras
 * (BRL→BR, MXN→MX, JPY→JP), e `Intl.Locale#maximize()` diz o idioma provável
 * dessa região. **O subtag de script sai de propósito**: `maximize()` devolve
 * `es-Latn-MX`, e o CLDR indexa o símbolo de moeda por `es-MX` — com o script
 * no meio, o MXN volta a sair como `"249,90 MXN"`. Medido nos dois sentidos.
 *
 * Moeda sem país (EUR→`en-EU`, XOF→`en-XO`) e código desconhecido caem em
 * `en-US`, que escreve o código ISO e não mente sobre a unidade.
 *
 * ─── `_cents` nem sempre é centésimo ───────────────────────────────────────
 *
 * ⚠️ JPY e CLP não têm subunidade; KWD tem três casas. Dividir por 100 em duro
 * mostraria `￥250` onde são `￥25.000` — cem vezes menos, no número que o agente
 * cota ao cliente. As unidades menores saem do próprio `Intl`, não de uma lista.
 *
 * ─── ⚠️ ESTA É A FONTE. As cópias que existem hoje têm os dois defeitos ─────
 *
 * Não é função nova por falta de uma: o repo já tinha CINCO formatadores locais
 * de dinheiro, copiados entre si, e todos carregam exatamente os dois defeitos
 * acima — `Intl.NumberFormat("pt-BR", …)` em duro **recebendo `currency` por
 * parâmetro**, mais o `/100` fixo:
 *
 *   components/kanban/KanbanCard.tsx:34      formatBRL(cents, currency)
 *   components/kanban/LeadDossier.tsx:28     formatBRL(cents, currency)
 *   components/kanban/StageColumn.tsx:31     formatBRL(cents)          (só BRL)
 *   components/inbox/CRMSidePanel.tsx:193    formatMoney(cents, currency)
 *   lib/lgpd/pdf-renderer.tsx:107            fmtMoney(cents, currency) (pior:
 *                                            `${currency} ${v.toFixed(2)}`, sem
 *                                            locale e sempre 2 casas)
 *
 * Aceitar `currency` e fixar `pt-BR` é o defeito medido: o lead em MXN sai
 * `MX$ 249,90`, com vírgula decimal brasileira, para quem opera no México.
 *
 * **Elas convergem aqui, mas não neste PR** — são kanban, inbox e o PDF de
 * LGPD, três frentes que a doutrina não deixa misturar com o catálogo. A
 * conversão não é mecânica: as três do kanban usam `maximumFractionDigits: 0`
 * de propósito (o card não mostra centavos), e isso precisa virar parâmetro
 * antes de trocá-las. Enquanto não convergem, a duplicação fica DECLARADA aqui
 * — que é o que separa o anti-pattern 2 ("duplicação sem source of truth
 * declarado") de uma dívida com dono e endereço.
 *
 * `formatCentsBRL` e `formatCentsUSD` ficam pelo mesmo motivo: atendem o valor
 * do negócio no kanban e o gasto de IA, que são essas outras frentes.
 *
 * ⚠️ Havia uma SEXTA, não listada aqui na primeira versão deste comentário:
 * `lib/mcp/tools/comercio.ts` tinha `precoLegivel()`, o mesmo defeito — e era a
 * mais grave das seis, porque é o preço que o AGENTE DE IA cota ao cliente por
 * WhatsApp. Uma revisão pegou a omissão antes do merge; já converge aqui.
 */
const formatadores = new Map<string, Intl.NumberFormat>();

function formatadorDa(moeda: string): Intl.NumberFormat {
  const cacheado = formatadores.get(moeda);
  if (cacheado) return cacheado;

  let locale = "en-US";
  try {
    const provavel = new Intl.Locale(`und-${moeda.slice(0, 2)}`).maximize();
    const tag = `${provavel.language}-${provavel.region}`;
    if (Intl.NumberFormat.supportedLocalesOf(tag).length > 0) locale = tag;
  } catch {
    // Região que o ICU não conhece: fica o padrão.
  }

  const novo = new Intl.NumberFormat(locale, { style: "currency", currency: moeda });
  formatadores.set(moeda, novo);
  return novo;
}

/**
 * ⚠️ `formatCents` é EXPORTADA e roda em client component (a lista de
 * produtos). `new Intl.NumberFormat(locale, {style:"currency", currency})`
 * LANÇA para moeda malformada — medido: `""`, `"BR"` (2 letras), `undefined`,
 * `null` — mesmo com o CHECK do banco (`^[A-Z]{3}$`) garantindo o formato em
 * toda linha que passa por ele. A função não pode presumir que todo chamador
 * futuro respeita essa garantia: um valor ruim não pode derrubar a lista
 * inteira. As cinco cópias que esta função substitui tinham `try/catch`
 * (ex.: `CRMSidePanel.tsx:201`); esta usa a mesma rede.
 */
export function formatCents(cents: number, moeda: string): string {
  const valor = (cents ?? 0) / 100;
  try {
    const nf = formatadorDa(moeda);
    // O tipo do `Intl` deixa o campo opcional; 2 é o que a esmagadora maioria
    // das moedas usa e é o que o código fazia em duro antes desta função existir.
    const casas = nf.resolvedOptions().maximumFractionDigits ?? 2;
    return nf.format((cents ?? 0) / 10 ** casas);
  } catch {
    // Moeda que o `Intl` recusa: mostra o número certo em vez de travar a
    // tela. Sem `style: "currency"` porque é justamente o `currency` inválido
    // que lançou — um código de moeda cru é mais honesto que esconder o erro.
    return `${moeda || "?"} ${valor.toFixed(2)}`;
  }
}

/**
 * As moedas que o produto SERVE — e servir quer dizer três coisas juntas: o
 * seletor da organização a oferece, o schema a aceita, e `formatCents` sabe
 * escrevê-la na convenção de quem a usa.
 *
 * É a mesma disciplina de `LOCALES = IDIOMAS` em `lib/schemas/settings.ts`, e
 * pelo mesmo motivo: com duas listas, uma moeda aceita na validação e ausente
 * no seletor vira um valor que ninguém consegue mais escolher de volta, e uma
 * oferecida na tela e recusada no schema faz a tela salvar e o servidor
 * devolver `validation_failed` sem explicar.
 *
 * ⚠️ Esta lista NÃO é o CHECK do banco, e a diferença é deliberada.
 * `organizations_currency_iso` valida a FORMA (`^[A-Z]{3}$`), não o conjunto:
 * um clone pode ter linha com moeda que este produto ainda não serve, e um
 * CHECK fechado quebraria o `update.sh` dele — é a mesma exceção de vocabulário
 * ABERTO que a doutrina de modelagem descreve. O conjunto vive só aqui, no
 * TypeScript.
 *
 * As três têm subunidade de 2 casas, então nenhuma esbarra na ressalva de
 * unidades menores de `formatCents`. Acrescentar JPY ou CLP funciona — o
 * formatador já os cobre —, mas exige olhar `precoParaCentavos`, que ainda
 * multiplica por 100 na leitura do que a pessoa digita.
 */
export const MOEDAS_SERVIDAS = ["BRL", "MXN", "USD"] as const;
export type MoedaServida = (typeof MOEDAS_SERVIDAS)[number];

/** O que o `default` da coluna grava quando ninguém escolheu. */
export const MOEDA_PADRAO: MoedaServida = "BRL";

/**
 * A moeda guardada, se o produto souber servi-la — senão, o padrão.
 *
 * Existe pela mesma razão que `normalizarIdioma`: o CHECK do banco valida a
 * FORMA e não o conjunto, então a linha pode trazer uma moeda que este produto
 * ainda não oferece (clone antigo, instalação que a gravou por outro caminho).
 * Devolver isso cru ao seletor daria um `<Select>` com valor que não está entre
 * as opções — o campo aparece vazio e, ao salvar, leva junto a moeda errada.
 */
export function moedaServidaOu(bruta: string | null | undefined): MoedaServida {
  return (MOEDAS_SERVIDAS as readonly string[]).includes(bruta ?? "")
    ? (bruta as MoedaServida)
    : MOEDA_PADRAO;
}

/**
 * O símbolo da moeda — "R$", "$" —, tirado do mesmo formatador que escreve o
 * preço, para o rótulo do seletor não precisar de tradução.
 *
 * ⚠️ Existe para fechar um buraco de i18n que a primeira versão do seletor
 * abriu: os nomes ("Real brasileiro", "Peso mexicano") saíam por
 * `t(NOME_DA_MOEDA[moeda])`, e chave DINÂMICA o guarda
 * `i18n-espanhol-cobre-a-tela` não enxerga — ele varre o AST atrás de literais.
 * Passariam pelo CI e cairiam no português na tela em espanhol, calado, que é
 * exatamente o modo de falha que aquele teste existe para impedir.
 *
 * Código ISO + símbolo não se traduz e não envelhece: é o que o comerciante
 * reconhece, e sai da mesma fonte que formata o preço.
 */
export function simboloDaMoeda(moeda: string): string {
  const partes = formatadorDa(moeda).formatToParts(0);
  return partes.find((p) => p.type === "currency")?.value ?? moeda;
}
