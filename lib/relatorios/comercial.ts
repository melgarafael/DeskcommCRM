/**
 * OS DOIS RANKINGS DE NEGÓCIOS GANHOS — etiquetas que mais vendem e clientes que
 * mais compram, mostrados dentro da tela de Faturamento (#4280; leitura do PR
 * #4295 de @webtecnica).
 *
 * ─── O que este módulo responde, e o que ele NÃO responde ───────────────────
 *
 *   1. **quais tags representam mais vendas** (`tags`);
 *   2. **quais clientes estão comprando** (`clientes`).
 *
 * NÃO devolve um total de "quanto vendemos". O número de faturamento da tela é o
 * de `fn_relatorio_financeiro` (comandas e lançamentos); um total somado aqui,
 * de outra fonte, seria um número parecido que não bate com aquele — e o dia em
 * que discordassem ninguém saberia qual está certo. Também não há funil, taxa de
 * conversão, meta, ticket médio nem previsão.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DEFINIÇÃO DE CADA RANKING (é contrato, não comentário)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * UNIVERSO (igual para os dois rankings)
 *   `crm_leads` com `organization_id` da sessão, `status = 'won'` e `closed_at`
 *   dentro da janela `[from, to)`. `closed_at` é a DATA DA VENDA — é o carimbo
 *   que o trigger escreve junto com o `status` (`lib/conversoes/envio.handler.ts`
 *   registra o par). `created_at` NÃO é a data da venda: um negócio aberto em
 *   maio e ganho em setembro é venda de setembro.
 *
 *   FICA DE FORA, e é dito:
 *   - negócio ABERTO ou PERDIDO (`status <> 'won'`) — previsão é outra pergunta;
 *   - negócio ganho FORA da janela;
 *   - negócio ganho SEM `closed_at` — não há data para recortar; a rota CONTA
 *     quantos são e devolve em `excluidos.sem_data_de_ganho` (nunca zero mudo);
 *   - negócio em OUTRA MOEDA que não a da organização — somar dólar com real
 *     produz um número que não existe em moeda nenhuma; a rota conta quantos
 *     ficaram fora (`excluidos.outra_moeda`) e a tela declara o corte.
 *
 * O VALOR DE CADA NEGÓCIO (o que as linhas somam em `centavos`)
 *   `crm_leads.value_cents`, na moeda da organização. `value_cents` NULO soma 0
 *   e o negócio continua contado em `negocios_ganhos` e nas linhas em que
 *   aparece; quantos vieram sem valor sai em `negocios_sem_valor`, porque
 *   "R$ 0,00" e "não preenchido" são fatos diferentes. Valor negativo ou
 *   não-finito entra como 0 em vez de DIMINUIR a venda (a mesma régua de
 *   `lib/metrics/valores-do-periodo.ts`).
 *
 *   NÃO soma `recurring_value_cents`: a recorrência mensal é a segunda parcela
 *   do negócio (fatia 1 da #3602); somá-la aqui inflaria as linhas com meses que
 *   ainda não aconteceram.
 *
 * (a) TAG QUE MAIS VENDE — `tags`
 *     Agrupa por `crm_leads.tags` (as etiquetas DO NEGÓCIO — é a dimensão que a
 *     issue nomeia), normalizadas com `lower(btrim(...))`: "Cliente " e
 *     "cliente" são a mesma tag para quem digita. Cada linha traz
 *     `centavos` (soma de `value_cents`) e `negocios` (quantos negócios ganhos
 *     carregam a tag). Um negócio com duas tags conta nas DUAS linhas — por
 *     isso `total_etiquetagens` é o denominador honesto da fatia, e não o
 *     número de negócios.
 *     DESEMPATE, nesta ordem: `centavos` desc → `negocios` desc → tag em ordem
 *     alfabética crescente (comparação de código, não de locale: o resultado não
 *     pode mudar com o idioma do servidor).
 *     LIMITE: 10 linhas na resposta — corte de LEITURA da lista
 *     (`negocios_ganhos` continua contando todos).
 *
 * (b) CLIENTE QUE MAIS COMPRA — `clientes`
 *     Agrupa por `crm_leads.contact_id`. Negócio ganho SEM contato não é
 *     cliente: fica fora da lista e é contado em `negocios_sem_contato`.
 *     DESEMPATE: `centavos` desc → `negocios` desc → `contact_id` crescente
 *     (o id é estável; ordenar por nome faria a ordem mudar quando alguém
 *     renomeia um contato). LIMITE: 10 linhas.
 *
 * (c) FUNIL QUE MAIS VENDE — `funis` (#4802, item 4)
 *     Agrupa por `crm_leads.pipeline_id`, com a mesma conta e o mesmo desempate
 *     dos outros dois (chave: `pipeline_id`). Não há ranking por ETAPA: negócio
 *     ganho mora na etapa de ganho, então "por etapa" seria uma linha só.
 *
 * O RECORTE DA TELA — `filtro`
 *   Funil (`pipeline_id`) e tag (normalizada com `normalizarTagDoRelatorio`).
 *   Vale para os TRÊS rankings e para a lista. As `opcoes` dos seletores saem
 *   ANTES do recorte (os funis e tags presentes no período), e `sem_dados`
 *   também: um filtro que não acha nada não é "período sem venda".
 *
 * A LISTA DE VENDAS — `vendas`
 *   Cada negócio ganho do recorte: título, contato, funil, `closed_at` e valor
 *   (`null` quando não preenchido). Da mais recente para a mais antiga, até
 *   `LIMITE_DA_LISTA_DE_VENDAS`; `vendas_no_filtro` diz quantas existem.
 *   Continua SEM total somado (ver acima): a soma de "quanto vendemos" é a da
 *   tela de Faturamento.
 *
 * PERÍODO VAZIO
 *   `tags: []`, `clientes: []`, `negocios_ganhos: 0` e `sem_dados: true` com
 *   `motivo`. Não é erro (o período sem venda é um fato legítimo) e não é uma
 *   lista de zeros fingindo ser relatório — a tela diz "nenhum negócio ganho no
 *   período" em vez de desenhar tabelas vazias.
 *
 * TRUNCADO
 *   `truncado: true` significa que a leitura parou no teto de páginas: os
 *   valores das linhas são PISO. A tela é obrigada a dizer isso; nunca
 *   apresentamos piso como total (é a mesma doutrina de `/reports/tags` e
 *   `/reports/financeiro`).
 *
 * Módulo PURO: recebe linhas já lidas, devolve os rankings. Quem lê o banco é a
 * rota (`app/api/v1/reports/comercial/route.ts`) — e é lá que mora a contagem
 * de consultas, declarada no cabeçalho dela.
 */

/** A linha do negócio como a rota a lê — nada além do que a conta precisa. */
export interface NegocioBruto {
  id: string;
  /** `won`, `lost` ou `open` — a conta rejeita tudo que não é `won`. */
  status: string | null;
  value_cents: number | null;
  currency: string | null;
  contact_id: string | null;
  tags: string[] | null;
  /** A data da venda. Nulo = não há como recortar; fica fora (e é contado). */
  closed_at: string | null;
  /** O funil do negócio — o recorte e o ranking por funil (#4802, item 4). */
  pipeline_id?: string | null;
  /** O título do card, só para a lista de vendas escrever o que foi vendido. */
  title?: string | null;
}

/** Quantas linhas cada ranking devolve. Corte de LISTA, não de total. */
export const LIMITE_DE_LINHAS = 10;

/**
 * Quantas vendas a LISTA devolve. Corte de leitura da tela, não de conta: os
 * rankings continuam somando todas, e `vendas_no_filtro` diz quantas existem.
 */
export const LIMITE_DA_LISTA_DE_VENDAS = 100;

/**
 * O recorte que a pessoa escolheu na tela, já validado pela rota. `null` em
 * cada campo = sem aquele recorte. A tag chega NORMALIZADA (a mesma régua de
 * `tagsDoNegocio`), senão "Cliente" no filtro não acharia "cliente " no card.
 */
export interface FiltroDoRelatorio {
  pipeline_id: string | null;
  tag: string | null;
}

/** Uma linha do ranking de funis — o nome é resolvido pela tela. */
export interface LinhaDeFunil {
  pipeline_id: string;
  centavos: number;
  negocios: number;
}

/** Uma venda da lista: um negócio ganho dentro do recorte. */
export interface LinhaDeVenda {
  id: string;
  titulo: string | null;
  contact_id: string | null;
  pipeline_id: string | null;
  /** A data da venda (`closed_at`), nunca a de criação do card. */
  ganho_em: string;
  /** `null` = valor não preenchido — não é venda de zero. */
  centavos: number | null;
  tags: string[];
}

/**
 * O que os seletores da tela oferecem: os funis e as tags que APARECEM nos
 * negócios ganhos do período, ANTES do recorte. Sai da mesma leitura (nenhuma
 * consulta a mais) e respeita a RLS de quem pede — a lista de funis da
 * organização (`GET /api/v1/pipelines`) exige `manager`, e este relatório é
 * aberto a `viewer`.
 */
export interface OpcoesDoFiltro {
  pipeline_ids: string[];
  tags: string[];
}

/** O contato como a tela precisa dele para escrever o nome (do recurso embutido). */
export interface ContatoDoRelatorio {
  id: string;
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
}

/** Uma linha do ranking de tags. */
export interface LinhaDeTag {
  tag: string;
  centavos: number;
  negocios: number;
}

/** Uma linha do ranking de clientes — o nome é resolvido pela tela. */
export interface LinhaDeCliente {
  contact_id: string;
  centavos: number;
  negocios: number;
}

/** O que ficou fora da conta, com nome e quantidade. */
export interface ExcluidosDoRelatorio {
  /** Ganhos da janela cuja moeda não é a da organização. */
  outra_moeda: number;
  /** Ganhos (`status = 'won'`) sem `closed_at` — medido pela rota. */
  sem_data_de_ganho: number;
}

/** A resposta inteira de `GET /api/v1/reports/comercial`. */
export interface RelatorioComercial {
  janela: {
    /** Primeiro dia civil, inclusivo. */
    de: string;
    /** Último dia civil, INCLUSIVO. */
    ate: string;
    /** Fuso da ORGANIZAÇÃO usado no recorte. */
    tz: string;
    /** O recorte efetivo no banco: `[from, to)`. */
    from: string;
    to: string;
  };
  /** `true` quando `de`/`ate` não vieram na query e o mês corrente foi usado. */
  padrao: boolean;
  /** Moeda da organização — a unidade dos valores dos rankings. */
  moeda: string;
  /** Quantos negócios ganhos entraram nos rankings (inclui os sem valor). */
  negocios_ganhos: number;
  /** Quantos desses vieram com `value_cents` nulo — não é zero, é ausência. */
  negocios_sem_valor: number;
  /** (b) Ranking por tag do negócio. */
  tags: LinhaDeTag[];
  /** (b) Soma das etiquetagens: um negócio de duas tags conta em duas linhas. */
  total_etiquetagens: number;
  /** (c) Ranking por contato. */
  clientes: LinhaDeCliente[];
  /** Ganhos da janela sem contato — fora da lista de clientes por definição. */
  negocios_sem_contato: number;
  /** Ranking por funil (#4802, item 4), dentro do recorte. */
  funis: LinhaDeFunil[];
  /** O recorte aplicado, como a rota o entendeu. */
  filtro: FiltroDoRelatorio;
  /** O que os seletores oferecem — funis e tags presentes no período. */
  opcoes: OpcoesDoFiltro;
  /** As vendas do recorte, da mais recente para a mais antiga (até o limite). */
  vendas: LinhaDeVenda[];
  /** Quantas vendas o recorte tem — a lista pode mostrar menos (`LIMITE_DA_LISTA_DE_VENDAS`). */
  vendas_no_filtro: number;
  excluidos: ExcluidosDoRelatorio;
  /** `true` quando o período não tem NENHUM negócio ganho. */
  sem_dados: boolean;
  /** `nenhum_negocio_ganho_no_periodo` — a razão, para a tela não inventar uma. */
  motivo: string | null;
  /** A leitura parou no teto de páginas: os números são piso. */
  truncado: boolean;
  /** Só quando há o que declarar (piso, ganho sem valor); senão `null`. */
  nota: string | null;
}

/**
 * O corpo de `GET /api/v1/reports/comercial`: o relatório + os nomes dos
 * contatos que aparecem no ranking. O nome viaja SEPARADO do número porque a
 * conta não depende dele: renomear um contato não muda quem mais comprou.
 */
export interface RespostaDoRelatorioComercial extends RelatorioComercial {
  /** `contact_id` → o que a tela precisa para escrever o nome (ou null). */
  contatos: Record<string, ContatoDoRelatorio | null>;
  /** `pipeline_id` → nome do funil (ou null), do recurso embutido no mesmo pedido. */
  nomes_dos_funis: Record<string, string | null>;
}

/**
 * Centavos que uma coluna pode somar.
 *
 * `null` soma zero (negócio sem valor é estado legítimo, contado à parte),
 * negativo ou não-finito entra como zero: venda negativa não existe, e um
 * `-500` numa coluna estragada não pode fazer o mês aparecer menor do que as
 * vendas que existiram.
 */
function centavos(valor: number | null | undefined): number {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return 0;
  return Math.max(0, Math.round(valor));
}

/** A moeda do negócio; sem moeda própria, a da organização (a régua da fatia 1). */
function moedaDoNegocio(negocio: NegocioBruto, moedaDaOrganizacao: string): string {
  return negocio.currency?.trim() || moedaDaOrganizacao;
}

/**
 * A régua de uma tag: `lower(btrim(...))`. Exportada porque a rota normaliza o
 * filtro com ELA — duas réguas seriam um filtro que não acha a própria tag.
 */
export function normalizarTagDoRelatorio(bruta: string): string {
  return bruta.trim().toLowerCase();
}

/** Tags normalizadas e sem repetição DENTRO do mesmo negócio. */
function tagsDoNegocio(tags: string[] | null): string[] {
  const vistas = new Set<string>();
  for (const bruta of tags ?? []) {
    if (typeof bruta !== "string") continue;
    const tag = normalizarTagDoRelatorio(bruta);
    if (tag !== "") vistas.add(tag);
  }
  return [...vistas];
}

/** O negócio passa no recorte da tela? Sem recorte, todos passam. */
function passaNoFiltro(negocio: NegocioBruto, filtro: FiltroDoRelatorio): boolean {
  if (filtro.pipeline_id !== null && negocio.pipeline_id !== filtro.pipeline_id) return false;
  if (filtro.tag !== null && !tagsDoNegocio(negocio.tags).includes(filtro.tag)) return false;
  return true;
}

const SEM_FILTRO: FiltroDoRelatorio = { pipeline_id: null, tag: null };

/**
 * O negócio foi GANHO dentro da janela? `closed_at` é a data da venda, e a
 * comparação é de INSTANTE contra o intervalo semiaberto `[from, to)` — o
 * recorte de fuso já foi feito por quem montou a janela.
 */
function dentroDaJanela(closedAt: string | null, janela: RelatorioComercial["janela"]): boolean {
  if (typeof closedAt !== "string" || closedAt === "") return false;
  const quando = Date.parse(closedAt);
  const de = Date.parse(janela.from);
  const ate = Date.parse(janela.to);
  if (!Number.isFinite(quando) || !Number.isFinite(de) || !Number.isFinite(ate)) return false;
  return quando >= de && quando < ate;
}

/** Comparação estável, independente de locale (o servidor não ordena por idioma). */
function compararTexto(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

interface Acumulado {
  centavos: number;
  negocios: number;
}

/**
 * A conta inteira. Pura e determinística: mesma entrada, mesma saída — inclusive
 * a ordem, que é o que o desempate por chave garante.
 */
export function montarRelatorioComercial(entrada: {
  negocios: readonly NegocioBruto[];
  moedaDaOrganizacao: string;
  janela: RelatorioComercial["janela"];
  padrao?: boolean;
  /** Ganhos (`won`) sem `closed_at`, contados pela rota numa consulta própria. */
  semDataDeGanho?: number;
  truncado?: boolean;
  /** O recorte da tela. Ausente = sem recorte (o comportamento anterior). */
  filtro?: FiltroDoRelatorio;
}): RelatorioComercial {
  const moeda = entrada.moedaDaOrganizacao;
  const filtro = entrada.filtro ?? SEM_FILTRO;
  const porTag = new Map<string, Acumulado>();
  const porCliente = new Map<string, Acumulado>();
  const porFunil = new Map<string, Acumulado>();
  const funisDoPeriodo = new Set<string>();
  const tagsDoPeriodo = new Set<string>();
  const vendas: LinhaDeVenda[] = [];

  /** Ganhos da janela ANTES do recorte — é o que decide "período sem venda". */
  let ganhosNoPeriodo = 0;
  let negociosGanhos = 0;
  let negociosSemValor = 0;
  let negociosSemContato = 0;
  let totalEtiquetagens = 0;
  let outraMoeda = 0;

  for (const negocio of entrada.negocios) {
    // Duas guardas, e as duas de propósito: a rota já filtra `status = 'won'` e
    // a janela no SQL, mas a conta NÃO confia no filtro de quem chamou — um
    // negócio perdido contado como venda é o erro mais caro deste relatório.
    if (negocio.status !== "won") continue;
    if (!dentroDaJanela(negocio.closed_at, entrada.janela)) continue;
    ganhosNoPeriodo += 1;

    // As opções dos seletores saem ANTES do recorte: escolher um funil não pode
    // sumir com os outros do menu, senão não haveria como trocar de funil.
    if (negocio.pipeline_id) funisDoPeriodo.add(negocio.pipeline_id);
    for (const tag of tagsDoNegocio(negocio.tags)) tagsDoPeriodo.add(tag);

    if (!passaNoFiltro(negocio, filtro)) continue;

    if (moedaDoNegocio(negocio, moeda) !== moeda) {
      // Moeda diferente: fora dos rankings, e contada para ser declarada.
      outraMoeda += 1;
      continue;
    }

    negociosGanhos += 1;
    const valor = centavos(negocio.value_cents);
    const semValor = negocio.value_cents === null || negocio.value_cents === undefined;
    if (semValor) negociosSemValor += 1;

    vendas.push({
      id: negocio.id,
      titulo: negocio.title?.trim() || null,
      contact_id: negocio.contact_id,
      pipeline_id: negocio.pipeline_id ?? null,
      ganho_em: negocio.closed_at as string,
      centavos: semValor ? null : valor,
      tags: tagsDoNegocio(negocio.tags),
    });

    if (negocio.pipeline_id) {
      const funil = porFunil.get(negocio.pipeline_id) ?? { centavos: 0, negocios: 0 };
      funil.centavos += valor;
      funil.negocios += 1;
      porFunil.set(negocio.pipeline_id, funil);
    }

    for (const tag of tagsDoNegocio(negocio.tags)) {
      const atual = porTag.get(tag) ?? { centavos: 0, negocios: 0 };
      atual.centavos += valor;
      atual.negocios += 1;
      porTag.set(tag, atual);
      totalEtiquetagens += 1;
    }

    if (!negocio.contact_id) {
      negociosSemContato += 1;
      continue;
    }
    const cliente = porCliente.get(negocio.contact_id) ?? { centavos: 0, negocios: 0 };
    cliente.centavos += valor;
    cliente.negocios += 1;
    porCliente.set(negocio.contact_id, cliente);
  }

  const tags: LinhaDeTag[] = [...porTag.entries()]
    .map(([tag, conta]) => ({ tag, centavos: conta.centavos, negocios: conta.negocios }))
    .sort(
      (a, b) =>
        b.centavos - a.centavos || b.negocios - a.negocios || compararTexto(a.tag, b.tag),
    )
    .slice(0, LIMITE_DE_LINHAS);

  const clientes: LinhaDeCliente[] = [...porCliente.entries()]
    .map(([contact_id, conta]) => ({
      contact_id,
      centavos: conta.centavos,
      negocios: conta.negocios,
    }))
    .sort(
      (a, b) =>
        b.centavos - a.centavos ||
        b.negocios - a.negocios ||
        compararTexto(a.contact_id, b.contact_id),
    )
    .slice(0, LIMITE_DE_LINHAS);

  const funis: LinhaDeFunil[] = [...porFunil.entries()]
    .map(([pipeline_id, conta]) => ({
      pipeline_id,
      centavos: conta.centavos,
      negocios: conta.negocios,
    }))
    .sort(
      (a, b) =>
        b.centavos - a.centavos ||
        b.negocios - a.negocios ||
        compararTexto(a.pipeline_id, b.pipeline_id),
    )
    .slice(0, LIMITE_DE_LINHAS);

  // A lista vai da venda mais recente para a mais antiga; o id desempata para a
  // ordem não depender da ordem em que o banco devolveu as linhas.
  const vendasOrdenadas = vendas
    .sort(
      (a, b) =>
        Date.parse(b.ganho_em) - Date.parse(a.ganho_em) || compararTexto(a.id, b.id),
    )
    .slice(0, LIMITE_DA_LISTA_DE_VENDAS);

  const truncado = entrada.truncado === true;
  // "Período sem venda" é ANTES do recorte: com um filtro que não acha nada, o
  // período TEM venda — e a tela precisa continuar mostrando os seletores para a
  // pessoa trocar de recorte, em vez de um "nenhum negócio ganho" sem saída.
  const semDados = ganhosNoPeriodo === 0;

  return {
    janela: entrada.janela,
    padrao: entrada.padrao === true,
    moeda,
    negocios_ganhos: negociosGanhos,
    negocios_sem_valor: negociosSemValor,
    tags,
    total_etiquetagens: totalEtiquetagens,
    clientes,
    negocios_sem_contato: negociosSemContato,
    funis,
    filtro,
    opcoes: {
      pipeline_ids: [...funisDoPeriodo].sort(compararTexto),
      tags: [...tagsDoPeriodo].sort(compararTexto),
    },
    vendas: vendasOrdenadas,
    vendas_no_filtro: negociosGanhos,
    excluidos: {
      outra_moeda: outraMoeda,
      sem_data_de_ganho: Math.max(0, Math.round(entrada.semDataDeGanho ?? 0)),
    },
    sem_dados: semDados,
    motivo: semDados ? "nenhum_negocio_ganho_no_periodo" : null,
    truncado,
    nota: notaDoRelatorio({
      truncado,
      negociosGanhos,
      negociosSemValor,
      outraMoeda,
    }),
  };
}

/**
 * A frase que impede o número de mentir por omissão. `null` quando não há nada
 * a declarar — nota que aparece sempre deixa de ser lida.
 */
function notaDoRelatorio(entrada: {
  truncado: boolean;
  negociosGanhos: number;
  negociosSemValor: number;
  outraMoeda: number;
}): string | null {
  const partes: string[] = [];
  if (entrada.truncado) {
    partes.push(
      "Leitura interrompida no teto de páginas: os números são um piso, não o total do período.",
    );
  }
  if (entrada.negociosSemValor > 0) {
    partes.push(
      `${entrada.negociosSemValor} negócio(s) ganho(s) no período sem valor preenchido somam 0,00 — não é venda de zero, é valor ausente.`,
    );
  }
  if (entrada.outraMoeda > 0) {
    partes.push(
      `${entrada.outraMoeda} negócio(s) ganho(s) em outra moeda ficaram fora: os rankings somam na moeda da empresa e não convertem.`,
    );
  }
  return partes.length === 0 ? null : partes.join(" ");
}
