/**
 * A MATEMÁTICA DO DASHBOARD — funções puras, testadas, sem banco.
 *
 * A página busca as linhas e estas funções agregam. Separar as duas coisas é
 * o que permite testar número sem subir Postgres: cada caso fixa uma conta.
 *
 * Dinheiro some em centavos inteiros; médias arredondam (Math.round), nunca
 * truncam. Dia = data UTC do `created_at` — decisão documentada: a VPS roda em
 * UTC e a loja opera num fuso só; refinar para America/Sao_Paulo é trocar
 * `fatiaDia` por Intl com timeZone, sem mudar mais nada.
 */

export interface LinhaDePedido {
  total_cents: number;
  status: string;
  origem: string;
  created_at: string;
  contact_id: string | null;
}

export interface ItemDeVenda {
  produto_nome: string;
  quantidade: number;
  subtotal_cents: number;
}

/** Pedido que ainda movimenta a operação (não encerrado, não morto). */
export function emAberto(status: string): boolean {
  return status !== "entregue" && status !== "cancelado";
}

/** Pedido que conta como venda (rascunho não é venda). */
export function contaComoVenda(status: string): boolean {
  return status !== "rascunho" && status !== "cancelado";
}

function fatiaDia(iso: string): string {
  return iso.slice(0, 10);
}

export interface ResumoDoPeriodo {
  faturamento_cents: number;
  qtd_pedidos: number;
  ticket_medio_cents: number;
}

export function resumoDoPeriodo(pedidos: LinhaDePedido[], inicioIso: string, fimIso: string): ResumoDoPeriodo {
  const noPeriodo = pedidos.filter(
    (p) => contaComoVenda(p.status) && p.created_at >= inicioIso && p.created_at < fimIso,
  );
  const faturamento = noPeriodo.reduce((s, p) => s + p.total_cents, 0);
  return {
    faturamento_cents: faturamento,
    qtd_pedidos: noPeriodo.length,
    ticket_medio_cents: noPeriodo.length === 0 ? 0 : Math.round(faturamento / noPeriodo.length),
  };
}

export interface PontoDaSerie {
  dia: string;
  total_cents: number;
  qtd: number;
}

/** Série diária dos últimos N dias (terminando em `hojeIso`), com zeros nos dias vazios. */
export function serieDiaria(pedidos: LinhaDePedido[], hojeIso: string, dias: number): PontoDaSerie[] {
  const hoje = fatiaDia(hojeIso);
  const mapa = new Map<string, { total: number; qtd: number }>();
  for (const p of pedidos) {
    if (!contaComoVenda(p.status)) continue;
    const dia = fatiaDia(p.created_at);
    const atual = mapa.get(dia) ?? { total: 0, qtd: 0 };
    atual.total += p.total_cents;
    atual.qtd += 1;
    mapa.set(dia, atual);
  }
  const serie: PontoDaSerie[] = [];
  const base = new Date(`${hoje}T00:00:00Z`).getTime();
  for (let i = dias - 1; i >= 0; i--) {
    const dia = new Date(base - i * 86400000).toISOString().slice(0, 10);
    const v = mapa.get(dia) ?? { total: 0, qtd: 0 };
    serie.push({ dia, total_cents: v.total, qtd: v.qtd });
  }
  return serie;
}

export interface FatiaPorOrigem {
  origem: string;
  qtd: number;
  total_cents: number;
}

export function vendasPorOrigem(pedidos: LinhaDePedido[], inicioIso: string): FatiaPorOrigem[] {
  const mapa = new Map<string, { qtd: number; total: number }>();
  for (const p of pedidos) {
    if (!contaComoVenda(p.status) || p.created_at < inicioIso) continue;
    const atual = mapa.get(p.origem) ?? { qtd: 0, total: 0 };
    atual.qtd += 1;
    atual.total += p.total_cents;
    mapa.set(p.origem, atual);
  }
  return [...mapa.entries()]
    .map(([origem, v]) => ({ origem, qtd: v.qtd, total_cents: v.total }))
    .sort((a, b) => b.total_cents - a.total_cents);
}

export interface ProdutoNoRanking {
  produto_nome: string;
  quantidade: number;
  total_cents: number;
}

export interface ItemComCategoria {
  produto_nome: string;
  quantidade: number;
  subtotal_cents: number;
  /** Nome da categoria resolvido (ou "Sem categoria"). */
  categoria: string;
}

export interface MesPorCategoria {
  /** "2026-09" — ordenável e legível sem locale. */
  mes: string;
  /** Rótulo curto pt-BR ("set/26"). */
  rotulo: string;
  total_cents: number;
  qtd: number;
  /** Uma chave por categoria presente no mês. */
  por_categoria: Record<string, number>;
}

const MESES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function chaveDoMes(iso: string): string {
  return iso.slice(0, 7);
}

function rotuloDoMes(chave: string): string {
  const [ano = "", mes = ""] = chave.split("-");
  return `${MESES_PT[Number(mes) - 1] ?? mes}/${ano.slice(2)}`;
}

function chavesDosMeses(hojeIso: string, meses: number): string[] {
  const [ano = 0, mes = 1] = chaveDoMes(hojeIso).split("-").map(Number);
  const chaves: string[] = [];
  for (let i = meses - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(ano, mes - 1 - i, 1));
    chaves.push(d.toISOString().slice(0, 7));
  }
  return chaves;
}

/**
 * Vendas mensais empilháveis por categoria — o gráfico herói do dashboard.
 *
 * Cada item carrega sua categoria (resolvida na página via produto); item sem
 * categoria cai em "Sem categoria" em vez de sumir — sumir seria o gráfico
 * mentindo sobre o total. Meses sem venda entram zerados para a série não
 * quebrar no meio.
 */
/** O mínimo que o gráfico precisa de cada pedido. */
export interface PedidoParaGrafico {
  id: string;
  total_cents: number;
  status: string;
  created_at: string;
}

export function vendasMensaisPorCategoria(
  pedidos: PedidoParaGrafico[],
  itensPorPedido: Record<string, ItemComCategoria[]>,
  hojeIso: string,
  meses: number,
): { serie: MesPorCategoria[]; categorias: string[] } {
  const chaves = chavesDosMeses(hojeIso, meses);
  const porMes = new Map<string, { total: number; qtd: number; cats: Map<string, number> }>();
  for (const chave of chaves) {
    porMes.set(chave, { total: 0, qtd: 0, cats: new Map() });
  }
  const catsVistas = new Set<string>();
  for (const p of pedidos) {
    if (!contaComoVenda(p.status)) continue;
    const chave = chaveDoMes(p.created_at);
    const mes = porMes.get(chave);
    if (!mes) continue;
    mes.total += p.total_cents;
    mes.qtd += 1;
    for (const item of itensPorPedido[p.id] ?? []) {
      const atual = mes.cats.get(item.categoria) ?? 0;
      mes.cats.set(item.categoria, atual + item.subtotal_cents);
      catsVistas.add(item.categoria);
    }
  }
  const categorias = [...catsVistas].sort();
  return {
    categorias,
    serie: chaves.map((chave) => {
      const m = porMes.get(chave);
      const por_categoria: Record<string, number> = {};
      for (const c of categorias) por_categoria[c] = m?.cats.get(c) ?? 0;
      return {
        mes: chave,
        rotulo: rotuloDoMes(chave),
        total_cents: m?.total ?? 0,
        qtd: m?.qtd ?? 0,
        por_categoria,
      };
    }),
  };
}

export interface MetricaMensal {
  mesAtual_cents: number;
  mesAnterior_cents: number;
  /** Percentual (pode ser negativo). NULL quando não há base de comparação. */
  variacao_pct: number | null;
}

export interface DiaPorCategoria {
  /** "2026-09-05" */
  dia: string;
  /** "05/09" */
  rotulo: string;
  total_cents: number;
  qtd: number;
  por_categoria: Record<string, number>;
}

function diasNoMes(chaveMes: string): number {
  const [ano = 0, mes = 1] = chaveMes.split("-").map(Number);
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

function rotuloDoDia(chaveMes: string, dia: number): string {
  const [, mes = ""] = chaveMes.split("-");
  return `${String(dia).padStart(2, "0")}/${mes}`;
}

/**
 * Faturamento DIA A DIA de um mês, empilhável por categoria — o drill-down do
 * herói mensal. Todo dia do mês entra (zerado quando vazio): barra ausente
 * significa "não vendeu", nunca "dado faltando".
 */
export function vendasDiariasPorCategoria(
  pedidos: PedidoParaGrafico[],
  itensPorPedido: Record<string, ItemComCategoria[]>,
  chaveMes: string,
): { dias: DiaPorCategoria[]; categorias: string[] } {
  const total = diasNoMes(chaveMes);
  const porDia = new Map<string, { total: number; qtd: number; cats: Map<string, number> }>();
  for (let d = 1; d <= total; d++) {
    porDia.set(`${chaveMes}-${String(d).padStart(2, "0")}`, { total: 0, qtd: 0, cats: new Map() });
  }
  const catsVistas = new Set<string>();
  for (const p of pedidos) {
    if (!contaComoVenda(p.status)) continue;
    const dia = p.created_at.slice(0, 10);
    const slot = porDia.get(dia);
    if (!slot) continue;
    slot.total += p.total_cents;
    slot.qtd += 1;
    for (const item of itensPorPedido[p.id] ?? []) {
      slot.cats.set(item.categoria, (slot.cats.get(item.categoria) ?? 0) + item.subtotal_cents);
      catsVistas.add(item.categoria);
    }
  }
  const categorias = [...catsVistas].sort();
  return {
    categorias,
    dias: [...porDia.entries()].map(([dia, v]) => {
      const por_categoria: Record<string, number> = {};
      for (const c of categorias) por_categoria[c] = v.cats.get(c) ?? 0;
      return {
        dia,
        rotulo: rotuloDoDia(chaveMes, Number(dia.slice(8, 10))),
        total_cents: v.total,
        qtd: v.qtd,
        por_categoria,
      };
    }),
  };
}

/** Meses para o seletor (os N mais recentes, do mais antigo ao atual). */
export function chavesParaSeletor(hojeIso: string, meses: number): { chave: string; rotulo: string }[] {
  return chavesDosMeses(hojeIso, meses).map((chave) => ({ chave, rotulo: rotuloDoMes(chave) }));
}

/** O mês corrente contra o anterior, da mesma série. */
export function metricaMensal(serie: MesPorCategoria[]): MetricaMensal {
  const n = serie.length;
  const atual = serie[n - 1]?.total_cents ?? 0;
  const anterior = serie[n - 2]?.total_cents ?? 0;
  return {
    mesAtual_cents: atual,
    mesAnterior_cents: anterior,
    variacao_pct: anterior === 0 ? null : Math.round(((atual - anterior) / anterior) * 1000) / 10,
  };
}

export function topProdutos(itens: ItemDeVenda[], limite: number): ProdutoNoRanking[] {
  const mapa = new Map<string, { qtd: number; total: number }>();
  for (const i of itens) {
    const atual = mapa.get(i.produto_nome) ?? { qtd: 0, total: 0 };
    atual.qtd += i.quantidade;
    atual.total += i.subtotal_cents;
    mapa.set(i.produto_nome, atual);
  }
  return [...mapa.entries()]
    .map(([produto_nome, v]) => ({ produto_nome, quantidade: v.qtd, total_cents: v.total }))
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, limite);
}
