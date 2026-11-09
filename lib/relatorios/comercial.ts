/**
 * O RELATÓRIO COMERCIAL — os TRÊS números da #4280, e só eles.
 *
 * ─── A pergunta, escrita uma vez ────────────────────────────────────────────
 *
 * O corpo da issue pede um painel que responda, no período:
 *
 *   1. **quanto vendemos** (`faturamento_centavos`);
 *   2. **quais tags representam mais vendas** (`tags`);
 *   3. **quais clientes estão comprando** (`clientes`).
 *
 * Nada além disso mora aqui: não há funil, taxa de conversão, meta, ticket
 * médio nem previsão. Número que não muda uma decisão é ruído — e a pressão para
 * "só acrescentar um gráfico" é o que transforma relatório em painel de vaidade.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DEFINIÇÃO DE CADA NÚMERO (é contrato, não comentário)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * UNIVERSO (igual para os três números)
 *   `crm_leads` com `organization_id` da sessão, `status = 'won'` e `closed_at`
 *   dentro da janela `[from, to)`. `closed_at` é a DATA DA VENDA — é o carimbo
 *   que o trigger escreve junto com o `status` (`lib/conversoes/envio.handler.ts`
 *   registra o par). `created_at` NÃO é a data da venda: um negócio aberto em
 *   maio e ganho em setembro é venda de setembro.
 *
 *   FICA DE FORA, e é dito:
 *   - negócio ABERTO ou PERDIDO (`status <> 'won'`) — previsão é outra fatia;
 *   - negócio ganho FORA da janela — nem no numerador, nem no denominador;
 *   - negócio ganho SEM `closed_at` — não há data para recortar; a rota CONTA
 *     quantos são e devolve em `excluidos.sem_data_de_ganho` (nunca zero mudo);
 *   - negócio em OUTRA MOEDA que não a da organização — somar dólar com real
 *     produz um número que não existe em moeda nenhuma; a rota conta quantos
 *     ficaram fora (`excluidos.outra_moeda`) e a tela declara o corte.
 *
 * (a) FATURAMENTO DO PERÍODO — `faturamento_centavos`
 *     Soma de `crm_leads.value_cents` do universo acima, na moeda da
 *     organização. `value_cents` NULO soma 0 e o negócio continua contado em
 *     `negocios_ganhos`; quantos vieram sem valor sai em `negocios_sem_valor`,
 *     porque "R$ 0,00" e "não preenchido" são fatos diferentes. Valor negativo
 *     ou não-finito entra como 0 em vez de DIMINUIR a venda (a mesma régua de
 *     `lib/metrics/valores-do-periodo.ts`).
 *
 *     NÃO soma `recurring_value_cents`: a recorrência mensal é a segunda parcela
 *     do negócio (fatia 1 da #3602) e tem painel próprio; somá-la aqui inflaria
 *     o faturamento com meses que ainda não aconteceram.
 *
 * (b) TAG QUE MAIS VENDE — `tags`
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
 *     LIMITE: 10 linhas na resposta — corte de LEITURA da lista, nunca do total
 *     (o faturamento continua somando tudo).
 *
 * (c) CLIENTE QUE MAIS COMPRA — `clientes`
 *     Agrupa por `crm_leads.contact_id`. Negócio ganho SEM contato não é
 *     cliente: fica fora da lista e é contado em `negocios_sem_contato`.
 *     DESEMPATE: `centavos` desc → `negocios` desc → `contact_id` crescente
 *     (o id é estável; ordenar por nome faria a ordem mudar quando alguém
 *     renomeia um contato). LIMITE: 10 linhas.
 *
 * PERÍODO VAZIO
 *   Zero EXPLÍCITO: `faturamento_centavos: 0`, `tags: []`, `clientes: []` e
 *   `sem_dados: true` com `motivo`. Não é erro (o período sem venda é um fato
 *   legítimo) e não é uma lista de zeros fingindo ser relatório — a tela diz
 *   "não houve negócio ganho no período" em vez de desenhar barras vazias.
 *
 * TRUNCADO
 *   `truncado: true` significa que a leitura parou no teto de páginas: os
 *   números são PISO. A tela é obrigada a dizer isso; nunca apresentamos piso
 *   como total (é a mesma doutrina de `/reports/tags` e `/reports/financeiro`).
 *
 * Módulo PURO: recebe linhas já lidas, devolve números. Quem lê o banco é a
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
}

/** Quantas linhas cada ranking devolve. Corte de LISTA, não de total. */
export const LIMITE_DE_LINHAS = 10;

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
  /** Moeda da organização — a unidade dos três números. */
  moeda: string;
  /** (a) Soma de `value_cents` dos ganhos no período. Zero explícito. */
  faturamento_centavos: number;
  /** Quantos negócios entraram na soma (inclui os sem valor). */
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

/** Tags normalizadas e sem repetição DENTRO do mesmo negócio. */
function tagsDoNegocio(tags: string[] | null): string[] {
  const vistas = new Set<string>();
  for (const bruta of tags ?? []) {
    if (typeof bruta !== "string") continue;
    const tag = bruta.trim().toLowerCase();
    if (tag !== "") vistas.add(tag);
  }
  return [...vistas];
}

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
}): RelatorioComercial {
  const moeda = entrada.moedaDaOrganizacao;
  const porTag = new Map<string, Acumulado>();
  const porCliente = new Map<string, Acumulado>();

  let faturamento = 0;
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

    if (moedaDoNegocio(negocio, moeda) !== moeda) {
      // Moeda diferente: fora dos TRÊS números, e contada para ser declarada.
      outraMoeda += 1;
      continue;
    }

    negociosGanhos += 1;
    const valor = centavos(negocio.value_cents);
    faturamento += valor;
    if (negocio.value_cents === null || negocio.value_cents === undefined) {
      negociosSemValor += 1;
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

  const truncado = entrada.truncado === true;
  const semDados = negociosGanhos === 0 && outraMoeda === 0;

  return {
    janela: entrada.janela,
    padrao: entrada.padrao === true,
    moeda,
    faturamento_centavos: faturamento,
    negocios_ganhos: negociosGanhos,
    negocios_sem_valor: negociosSemValor,
    tags,
    total_etiquetagens: totalEtiquetagens,
    clientes,
    negocios_sem_contato: negociosSemContato,
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
      `${entrada.outraMoeda} negócio(s) ganho(s) em outra moeda ficaram fora: este painel soma na moeda da empresa e não converte.`,
    );
  }
  return partes.length === 0 ? null : partes.join(" ");
}
