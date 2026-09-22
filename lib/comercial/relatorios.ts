/**
 * A MATEMÁTICA DOS RELATÓRIOS — funções puras, testadas, sem banco.
 *
 * O que DÁ para calcular com o dado que existe (pedidos + itens):
 * vendas por vendedor/cliente/produto e Curva ABC. O que NÃO dá — e por quê:
 * - margem de contribuição: o item guarda preço de VENDA, não custo histórico;
 *   o `custo_cents` atual do catálogo não é o da época da venda;
 * - prazo médio de recebimento: não há data de pagamento em lugar nenhum;
 * - giro de estoque: não há histórico de movimentação, só saldo atual.
 * Pro prometer esses três, o schema precisa crescer primeiro (fase futura).
 */

export interface VendaAgregavel {
  total_cents: number;
  status: string;
  created_at: string;
  vendedor_user_id: string | null;
  contact_id: string | null;
  cliente_nome: string;
}

export interface ItemAgregavel {
  produto_nome: string;
  quantidade: number;
  subtotal_cents: number;
}

/** Venda conta no relatório (rascunho e cancelado, não). */
export function contaNoRelatorio(status: string): boolean {
  return status !== "rascunho" && status !== "cancelado";
}

export function noPeriodo(createdAt: string, inicioIso: string, fimIso: string): boolean {
  return createdAt >= inicioIso && createdAt < fimIso;
}

export interface LinhaAgregada {
  chave: string;
  rotulo: string;
  qtd: number;
  total_cents: number;
  ticket_medio_cents: number;
}

function agregar(
  vendas: VendaAgregavel[],
  inicioIso: string,
  fimIso: string,
  chaveDe: (v: VendaAgregavel) => string | null,
  rotuloDe: (v: VendaAgregavel) => string,
): LinhaAgregada[] {
  const mapa = new Map<string, { rotulo: string; qtd: number; total: number }>();
  for (const v of vendas) {
    if (!contaNoRelatorio(v.status) || !noPeriodo(v.created_at, inicioIso, fimIso)) continue;
    const chave = chaveDe(v);
    if (!chave) continue;
    const atual = mapa.get(chave) ?? { rotulo: rotuloDe(v), qtd: 0, total: 0 };
    atual.qtd += 1;
    atual.total += v.total_cents;
    mapa.set(chave, atual);
  }
  return [...mapa.entries()]
    .map(([chave, a]) => ({
      chave,
      rotulo: a.rotulo,
      qtd: a.qtd,
      total_cents: a.total,
      ticket_medio_cents: Math.round(a.total / a.qtd),
    }))
    .sort((a, b) => b.total_cents - a.total_cents);
}

export function vendasPorVendedor(
  vendas: VendaAgregavel[],
  inicioIso: string,
  fimIso: string,
  nomes: Record<string, string>,
): LinhaAgregada[] {
  return agregar(
    vendas,
    inicioIso,
    fimIso,
    (v) => v.vendedor_user_id ?? "sem-vendedor",
    (v) => (v.vendedor_user_id ? (nomes[v.vendedor_user_id] ?? "Equipe") : "Sem vendedor"),
  );
}

export function vendasPorCliente(
  vendas: VendaAgregavel[],
  inicioIso: string,
  fimIso: string,
): LinhaAgregada[] {
  return agregar(
    vendas,
    inicioIso,
    fimIso,
    (v) => v.contact_id ?? `nome:${v.cliente_nome}`,
    (v) => v.cliente_nome,
  );
}

export function vendasPorProduto(itens: ItemAgregavel[]): LinhaAgregada[] {
  const mapa = new Map<string, { qtd: number; total: number }>();
  for (const i of itens) {
    const atual = mapa.get(i.produto_nome) ?? { qtd: 0, total: 0 };
    atual.qtd += i.quantidade;
    atual.total += i.subtotal_cents;
    mapa.set(i.produto_nome, atual);
  }
  return [...mapa.entries()]
    .map(([rotulo, a]) => ({
      chave: rotulo,
      rotulo,
      qtd: a.qtd,
      total_cents: a.total,
      ticket_medio_cents: a.qtd === 0 ? 0 : Math.round(a.total / a.qtd),
    }))
    .sort((a, b) => b.total_cents - a.total_cents);
}

export interface LinhaABC extends LinhaAgregada {
  pct_acumulado: number;
  classe: "A" | "B" | "C";
}

/**
 * Curva ABC: ordena por valor desc, acumula %; A até 80%, B até 95%, C o
 * resto. A regra dos cortes mora aqui, não espalhada — se a loja quiser
 * 70/90, muda um lugar só.
 */
export function curvaABC(linhas: LinhaAgregada[]): LinhaABC[] {
  const total = linhas.reduce((s, l) => s + l.total_cents, 0);
  if (total === 0) return linhas.map((l) => ({ ...l, pct_acumulado: 0, classe: "C" as const }));
  let acumulado = 0;
  return linhas.map((l) => {
    acumulado += l.total_cents;
    const pct = (acumulado / total) * 100;
    return {
      ...l,
      pct_acumulado: Math.round(pct * 10) / 10,
      classe: (pct <= 80 ? "A" : pct <= 95 ? "B" : "C") as "A" | "B" | "C",
    };
  });
}

/**
 * CSV que o Excel abre (separador `;`, decimal com vírgula — o padrão BR).
 * Exportação sem dependência nova: `xlsx` é fase futura, e CSV entrega o
 * valor hoje (abre, filtra, tabela dinâmica).
 */
export function paraCSV(cabecalho: string[], linhas: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cabecalho, ...linhas].map((l) => l.map(esc).join(";")).join("\r\n");
}

export function reais(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
}
