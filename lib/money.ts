/**
 * Conversão de valor digitado (na moeda da ORGANIZAÇÃO) para centavos.
 *
 * A versão anterior vivia copiada em três formulários de lead e fazia
 * `reais.replace(/\./g, "").replace(",", ".")` — ou seja, tratava TODO ponto
 * como separador de milhar. Quem digitasse "249.90" (o jeito natural em
 * teclado numérico) tinha o valor gravado como R$ 24.990,00: cem vezes maior,
 * sem erro na tela, alimentando funil e relatórios com número errado.
 *
 * A regra aqui desambigua sem adivinhação, porque grupo de milhar tem SEMPRE
 * 3 dígitos — nas duas convenções:
 *
 *   "249,90"      → vírgula é decimal                       → 24990
 *   "249.90"      → ponto seguido de 2 dígitos é decimal    → 24990
 *   "1.234"       → ponto seguido de 3 dígitos é milhar     → 123400
 *   "1.234,56"    → tem vírgula: pontos são milhar          → 123456
 *   "1,234.56"    → formato en: o último separador é decimal→ 123456
 *   "1.234.567"   → todos os grupos com 3 dígitos           → 123456700
 *
 * ─── ⚠️ QUAL dos dois sinais é o decimal é fato da MOEDA (#3331) ──────────
 *
 * Medido numa instalação real, organização com `currency = USD`: quem digitava
 * `1,300` no campo de valor do funil gravava **1,30** — porque o parser não
 * sabia a moeda e tratava a vírgula como decimal, que é a regra do pt-BR. Em
 * en-US a vírgula é separador de MILHAR: eram mil e trezentos dólares, cem
 * vezes menos do que o negócio valia. O rótulo do campo já dizia `Valor ($)`:
 * a moeda chegava ao desenho e parava antes daqui.
 *
 * O segundo parâmetro é a fonte disso, e ele é OPCIONAL de propósito:
 *
 *   parseReaisToCents("1,300", "USD")  → 130000   (vírgula é milhar)
 *   parseReaisToCents("1.300", "USD")  → 130      (ponto é o decimal da moeda)
 *   parseReaisToCents("1.300", "BRL")  → 130000   (a leitura de sempre)
 *
 * Quem chama sem moeda — preço de catálogo, honorário, comanda, faturamento —
 * fica com a régua do padrão (`MOEDA_PADRAO`), que é exatamente a de antes
 * deste parâmetro existir: nenhum chamador atual muda de comportamento,
 * exceto num caso: sinal repetido (`1,234,567`) passa a ser lido como milhar
 * também na régua do real, onde antes virava 1.234,57.
 *
 * O papel de cada sinal sai do MESMO `Intl` que escreve o preço em
 * `formatCents` (ver `separadoresDaMoeda`), e não de uma tabela na mão: se o
 * formatador escreve `$1,300.00`, o parser lê `1,300` como mil e trezentos.
 * A régua dos 3 dígitos do grupo de milhar segue sendo o desempate do sinal
 * solitário — é ela que resolve `1,30` e `1.300` nas duas convenções.
 *
 * Devolve null quando não dá para ler um número — quem chama decide a mensagem.
 */
export function parseReaisToCents(input: string, moeda: string = MOEDA_PADRAO): number | null {
  const raw = input.trim();
  if (raw.length === 0) return null;
  if (!/^[\d.,\s]+$/.test(raw)) return null;

  const s = raw.replace(/\s/g, "");
  const { decimal: decimalDaMoeda, grupo: grupoDaMoeda } = separadoresDaMoeda(moeda);
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  /**
   * O papel de um sinal SOLITÁRIO vem da moeda:
   *
   *   "decimal"  — é o separador decimal dela: decimal, sempre.
   *   "grupo"    — é o milhar dela: milhar só quando o grupo final tem
   *                exatamente 3 dígitos (a régua de sempre). Com 2 dígitos
   *                depois não é grupo em convenção nenhuma — ver o caso
   *                ambíguo declarado em `lib/money.test.ts`.
   *   "semRegra" — sinal que a moeda nem usa («.» em EUR, cujo milhar é
   *                espaço): fica a leitura generosa de antes, para nenhum
   *                texto legível virar null.
   */
  const papelDoSinal = (sinal: "," | "."): "decimal" | "grupo" | "semRegra" =>
    sinal === decimalDaMoeda ? "decimal" : sinal === grupoDaMoeda ? "grupo" : "semRegra";

  let decimalSep = "";
  if (lastComma >= 0 && lastDot >= 0) {
    // Os dois presentes: o que vem por último é o decimal (pt-BR ou en).
    decimalSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sinal: "," | "." = lastComma >= 0 ? "," : ".";
    const pos = lastComma >= 0 ? lastComma : lastDot;
    const digitosDepois = s.length - pos - 1;
    // Sinal que aparece MAIS DE UMA VEZ nunca é o decimal (só há um decimal):
    // `1.234.567` em dólar é milhar, não 1.234,57.
    const papel = s.indexOf(sinal) !== pos ? "grupo" : papelDoSinal(sinal);
    if (papel === "grupo") {
      // O grupo de milhar tem sempre 3 dígitos; fora disso a leitura que
      // sobra é a decimal (o "1,30" em dólar, que não é grupo em lugar algum).
      decimalSep = digitosDepois === 3 ? "" : sinal;
    } else if (papel === "decimal") {
      decimalSep = sinal;
    } else {
      decimalSep = sinal === "," ? "," : digitosDepois === 3 ? "" : ".";
    }
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
 * Código desconhecido cai em `en-US`, que escreve o código ISO e não mente
 * sobre a unidade. Moeda SEM país é a exceção que a regra acima não alcança, e
 * tem locale declarado em `LOCALE_DA_MOEDA_SEM_PAIS`.
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
 * **As três do kanban já convergiram** — em `formatValorDoNegocio`, e não em
 * `formatCents`, porque o negócio guarda ×100 em qualquer moeda (ver a função);
 * o `maximumFractionDigits: 0` delas virou a opção `semCentavos`. Faltam o
 * inbox e o PDF de LGPD, frentes que a doutrina não deixa misturar com esta.
 * Enquanto não convergem, a duplicação fica DECLARADA aqui
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

/**
 * Moeda cujo código ISO não começa por um país. `EU` maximiza para `en-EU`, e
 * `en-EU` escreve `€249.90` — ponto decimal e símbolo na frente, a convenção da
 * Irlanda. Português, espanhol, francês, alemão e italiano escrevem `249,90 €`,
 * e é o que `pt-PT` devolve (medido no ICU do Node 22, junto com `de-DE`,
 * `fr-FR`, `es-ES` e `it-IT`).
 *
 * ponytail: um formato só para a zona euro. Holanda (`€ 249,90`) e Irlanda
 * (`€249.90`) leem a convenção vizinha; quando `organizations.country` puder
 * escolher o locale, é ele que decide, e esta tabela some.
 */
const LOCALE_DA_MOEDA_SEM_PAIS: Readonly<Record<string, string>> = {
  EUR: "pt-PT",
  // PYG tem país, mas a maximização responde o idioma ERRADO para dinheiro:
  // `und-PY` vira `gn-Latn-PY` (guarani), que o ICU não tem, e o formatador
  // caía em `en-US` — `PYG 125,000`, com vírgula de milhar. `es-PY` escreve
  // `Gs. 125.000`, como se lê no Paraguai. Medido no ICU do Node 22.
  PYG: "es-PY",
};

function localeDaMoeda(moeda: string): string {
  let locale = LOCALE_DA_MOEDA_SEM_PAIS[moeda] ?? "en-US";
  if (!LOCALE_DA_MOEDA_SEM_PAIS[moeda]) {
    try {
      const provavel = new Intl.Locale(`und-${moeda.slice(0, 2)}`).maximize();
      const tag = `${provavel.language}-${provavel.region}`;
      if (Intl.NumberFormat.supportedLocalesOf(tag).length > 0) locale = tag;
    } catch {
      // Região que o ICU não conhece: fica o padrão.
    }
  }
  return locale;
}

function formatadorDa(moeda: string): Intl.NumberFormat {
  const cacheado = formatadores.get(moeda);
  if (cacheado) return cacheado;

  const novo = new Intl.NumberFormat(localeDaMoeda(moeda), { style: "currency", currency: moeda });
  formatadores.set(moeda, novo);
  return novo;
}

const formatadoresSemCentavos = new Map<string, Intl.NumberFormat>();

function formatadorSemCentavosDa(moeda: string): Intl.NumberFormat {
  const cacheado = formatadoresSemCentavos.get(moeda);
  if (cacheado) return cacheado;
  const novo = new Intl.NumberFormat(localeDaMoeda(moeda), {
    style: "currency",
    currency: moeda,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  formatadoresSemCentavos.set(moeda, novo);
  return novo;
}

/**
 * Quantas casas decimais a moeda tem — a régua de `_cents` de `formatCents`
 * (unidades menores). Sai do MESMO formatador de `formatCents`, para as duas
 * pontas nunca divergirem: BRL 2, PYG e JPY 0, KWD 3. Moeda que o `Intl`
 * recusa fica em 2.
 */
function casasDaMoeda(moeda: string): number {
  try {
    return formatadorDa(moeda).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Os dois sinais que a MOEDA usa — o decimal e o de milhar —, tirados do MESMO
 * formatador que escreve o preço (`formatadorDa`), para ler e escrever nunca
 * discordarem.
 *
 * É o que permite `parseReaisToCents` saber que em dólar o decimal é «.» e o
 * milhar é «,» (o inverso do pt-BR) sem tabela na mão e sem lista para
 * envelhecer: a moeda que o `Intl` conhece já chega com os sinais dela.
 *
 * Medido no ICU do Node 22: USD e MXN `decimal="." grupo=","`; BRL
 * `decimal="," grupo="."`; EUR (pt-PT) e AOA (pt-AO) `decimal="," grupo=" "` —
 * o milhar é ESPAÇO, que o parser descarta antes de olhar, e por isso o sinal
 * que sobra fica sem papel declarado (`semRegra`).
 *
 * Moeda sem subunidade (JPY, PYG) não emite parte decimal em `formatToParts`;
 * aí o complemento do milhar é a resposta certa — é o ponto decimal daquela
 * região. Moeda que o `Intl` recusa cai na régua do PADRÃO, que é a mesma rede
 * de `formatCents`.
 */
const separadoresPorMoeda = new Map<string, { decimal: string; grupo: string }>();

function separadoresDaMoeda(moeda: string): { decimal: string; grupo: string } {
  const cacheado = separadoresPorMoeda.get(moeda);
  if (cacheado) return cacheado;

  let par: { decimal: string; grupo: string };
  try {
    const partes = formatadorDa(moeda).formatToParts(12345.6);
    const grupo = partes.find((p) => p.type === "group")?.value ?? ",";
    par = {
      grupo,
      decimal: partes.find((p) => p.type === "decimal")?.value ?? (grupo === "," ? "." : ","),
    };
  } catch {
    // Código malformado (o `Intl` lança): quem decide é o padrão. O `if` corta
    // a recursão infinita se o próprio padrão for um código que o ICU recusa.
    par = moeda === MOEDA_PADRAO ? { decimal: ",", grupo: "." } : separadoresDaMoeda(MOEDA_PADRAO);
  }
  separadoresPorMoeda.set(moeda, par);
  return par;
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
 * O VALOR DE UM NEGÓCIO (`crm_leads.value_cents`), escrito na moeda dele.
 *
 * ⚠️ DUAS RÉGUAS DE `_cents` CONVIVEM, e esta função é a ponte entre elas.
 * `formatCents` lê UNIDADES MENORES da moeda — as casas vêm do `Intl`, e em
 * moeda sem subunidade (guarani, iene, peso chileno) o número já é a moeda
 * inteira. O negócio guarda o valor × 100 em QUALQUER moeda: o formulário
 * (`parseReaisToCents`) multiplica por 100 sem olhar a moeda, e o card e o
 * dossiê do funil sempre dividiram por 100 fixo.
 *
 * O total da coluna do funil passava o valor do negócio direto a `formatCents`:
 * dois pedidos de ₲125.000 (`value_cents` 12.500.000 cada) apareciam como
 * `Gs. 25.000.000` — cem vezes mais —, enquanto o card, com o `/100` fixo, dizia
 * o certo. Medido numa instalação real em 25/09/2026. Em BRL, USD e MXN (duas
 * casas) as duas réguas coincidem, e por isso o defeito só aparece em moeda sem
 * centavos.
 *
 * `semCentavos` é o formato do card e do dossiê do funil, que nunca mostraram
 * centavos; o total da coluna mostra.
 */
export function formatValorDoNegocio(
  valueCents: number,
  moeda: string,
  opcoes: { semCentavos?: boolean } = {},
): string {
  const valor = (valueCents ?? 0) / 100;
  try {
    if (opcoes.semCentavos) return formatadorSemCentavosDa(moeda).format(valor);
    // Da régua do negócio (×100) para a de `formatCents` (unidades menores).
    return formatCents(Math.round((valueCents ?? 0) / 10 ** (2 - casasDaMoeda(moeda))), moeda);
  } catch {
    return `${moeda || "?"} ${valor.toFixed(opcoes.semCentavos ? 0 : 2)}`;
  }
}

/**
 * SOMA POR MOEDA — cada moeda no seu balde, nunca uma soma entre elas (#1531).
 *
 * R$ 5.000 mais 5.000 € não são 10.000 de nada: somar `_cents` de moedas
 * diferentes produz um número que não existe em moeda nenhuma, e escrevê-lo no
 * símbolo de uma delas o faz parecer verdade. O total da coluna do funil fazia
 * isso — somava tudo e escrevia na moeda do primeiro negócio. A regra já valia
 * em dois lugares (`lib/leads/previsao.ts` e `lib/metrics/perdas.ts`, cada um
 * com o seu balde interno); esta é a versão exportada, para o próximo total não
 * reinventar a terceira.
 *
 * Item com `cents` `null`/`undefined` não entra e NÃO cria a moeda — "sem valor"
 * não é "zero". Zero entra e cria: é valor declarado, e é o que mantém o
 * ponderado de uma etapa de perda (chance 0) com as mesmas moedas do total.
 * Nada é convertido.
 */
export function somaPorMoeda<T>(
  itens: readonly T[],
  cents: (item: T) => number | null | undefined,
  moeda: (item: T) => string,
): Map<string, number> {
  const soma = new Map<string, number>();
  for (const item of itens) {
    const valor = cents(item);
    if (valor == null) continue;
    const m = moeda(item);
    soma.set(m, (soma.get(m) ?? 0) + valor);
  }
  return soma;
}

/**
 * Escreve uma soma por moeda como texto: `"R$ 5.000,00 + 5000,00 €"`.
 *
 * ⚠️ O FORMATADOR É OBRIGATÓRIO, e não um padrão escondido, por causa das duas
 * réguas de `_cents` (ver `formatValorDoNegocio`): valor de negócio é ×100 em
 * qualquer moeda, preço e lançamento financeiro são unidades menores. Um padrão
 * serviria a uma e mostraria a outra cem vezes maior em guarani — o defeito que
 * o total da coluna já pagou uma vez.
 *
 * - Com UMA moeda, o texto é exatamente `formatar(cents, moeda)`: quem somava
 *   uma moeda só não vê diferença nenhuma.
 * - Ordem: `primeira` (quando está na soma), depois as demais em ordem
 *   alfabética do código ISO — determinística, para o texto não mudar de lugar
 *   a cada render.
 * - Peso mexicano e dólar escrevem os dois `$` (e também CLP, COP e ARS), e
 *   `"$1,500.00 + $100.00"` não diz qual é qual. Só quando o símbolo se repete
 *   DENTRO da soma, cada parcela afetada leva o código: `"$1,500.00 MXN +
 *   $100.00 USD"`. Símbolo único fica limpo — `"5000,00 € EUR"` seria ruído.
 * - Soma vazia devolve `""`.
 */
export function formatSomaPorMoeda(
  soma: ReadonlyMap<string, number>,
  formatar: (cents: number, moeda: string) => string,
  opcoes: { primeira?: string } = {},
): string {
  const moedas = [...soma.keys()].sort((a, b) =>
    a === opcoes.primeira ? -1 : b === opcoes.primeira ? 1 : a.localeCompare(b),
  );
  // `simboloDaMoeda` lança para código malformado; aí o próprio código é o
  // símbolo — é o que `formatCents` escreve nesse caso.
  const simbolo = (moeda: string) => {
    try {
      return simboloDaMoeda(moeda);
    } catch {
      return moeda;
    }
  };
  const simbolos = moedas.map(simbolo);
  return moedas
    .map((moeda) => {
      const texto = formatar(soma.get(moeda) ?? 0, moeda);
      const s = simbolo(moeda);
      const repetido = simbolos.filter((outro) => outro === s).length > 1;
      return repetido ? `${texto} ${moeda}` : texto;
    })
    .join(" + ");
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
 * As cinco têm subunidade de 2 casas, então nenhuma esbarra na ressalva de
 * unidades menores de `formatCents`. Acrescentar JPY ou CLP funciona — o
 * formatador já os cobre —, mas exige olhar `precoParaCentavos`, que ainda
 * multiplica por 100 na leitura do que a pessoa digita.
 *
 * `AOA` (kwanza, Angola) entrou por pedido de quem instala lá. Medido antes de
 * entrar, porque servir é o conjunto das três coisas acima: `formatCents(24990,
 * "AOA")` → `"249,90 Kz"` (o `formatadorDa` maximiza `und-AO` para `pt-AO`) e
 * `maximumFractionDigits` responde 2, então a régua de centavos vale. Entrar na
 * lista NÃO muda o padrão de ninguém — `MOEDA_PADRAO` continua `BRL`, e é isso
 * que o `default` da coluna grava em quem não escolheu.
 *
 * `EUR` entrou pelo mesmo motivo, para quem opera em Portugal e no resto da
 * zona euro. É o caso que a maximização não resolve (ver
 * `LOCALE_DA_MOEDA_SEM_PAIS`): sem a exceção, `formatCents(24990, "EUR")`
 * sairia `€249.90`, e a varredura de degradação deixaria passar.
 */
export const MOEDAS_SERVIDAS = ["AOA", "BRL", "EUR", "MXN", "USD"] as const;
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
