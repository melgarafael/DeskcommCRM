import { contaComoVenda } from "./dashboard";

/**
 * RADAR DE RECOMPRA — comportamento de compra a partir dos PEDIDOS REAIS.
 *
 * Regra de ouro: nunca pergunta "há quanto tempo sem atividade no CRM",
 * responde "há quanto tempo sem COMPRA VÁLIDA vs o padrão histórico".
 *
 * Venda válida = contaComoVenda (fora rascunho e cancelado) + com cliente +
 * data até hoje (pedido futuro não é compra). Aberto = rascunho, em_analise,
 * aprovado ou expedido (intenção/compromisso em voo). Orçamento = rascunho.
 * Tudo em dias "YYYY-MM-DD" — fuso resolvido por quem chama.
 */

export interface PedidoParaRadar {
  id: string;
  contact_id: string | null;
  total_cents: number;
  status: string;
  origem: string;
  dia: string;
}

export type SituacaoRecompra =
  | "em_voo"
  | "recompra_atrasada"
  | "em_risco"
  | "oportunidade_aberta"
  | "cancelado_sem_nova"
  | "novo_sem_compras"
  | "primeira_compra"
  | "ok";

export const ROTULO_RECOMPRA: Record<SituacaoRecompra, string> = {
  em_voo: "Em voo",
  recompra_atrasada: "Recompra atrasada",
  em_risco: "Em alto risco",
  oportunidade_aberta: "Oportunidade em aberto",
  cancelado_sem_nova: "Cancelado sem nova compra",
  novo_sem_compras: "Novo / sem compras",
  primeira_compra: "Primeira compra",
  ok: "Em dia",
};

export interface HistoricoCompra {
  contact_id: string;
  vendas: { id: string; dia: string; total_cents: number; origem: string }[];
  primeira_compra: string;
  ultima_compra: string;
  qtd_pedidos: number;
  faturamento_cents: number;
  ticket_medio_cents: number;
  ticket_mediano_cents: number;
  intervalo_medio_dias: number | null;
  intervalo_mediano_dias: number | null;
  maior_intervalo_dias: number | null;
  menor_intervalo_dias: number | null;
  canal_predominante: string | null;
  dias_sem_compra: number;
  atraso_dias: number;
  situacao: SituacaoRecompra;
  pedido_aberto_id: string | null;
  pedido_aberto_total_cents: number | null;
  orcamento_total_cents: number | null;
  cancelado_total_cents: number | null;
  ultimos: { id: string; dia: string; total_cents: number }[];
}

function diasEntre(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86400000,
  );
}

function mediana(ns: number[]): number | null {
  if (ns.length === 0) return null;
  const ord = [...ns].sort((a, b) => a - b);
  const meio = Math.floor(ord.length / 2);
  // Exata (pode dar .5): o atraso arredonda no fim — "≈22 dias, +8 de atraso".
  return ord.length % 2 === 0 ? ((ord[meio - 1] as number) + (ord[meio] as number)) / 2 : (ord[meio] as number);
}

function media(ns: number[]): number | null {
  if (ns.length === 0) return null;
  return Math.round(ns.reduce((a, b) => a + b, 0) / ns.length);
}

/** Vendas válidas de UM cliente, ordenadas (deduplicadas por id). */
function vendasDe(pedidos: PedidoParaRadar[], contactId: string, hoje: string): HistoricoCompra["vendas"] {
  const vistos = new Set<string>();
  return pedidos
    .filter(
      (p) =>
        p.contact_id === contactId &&
        contaComoVenda(p.status) &&
        p.dia <= hoje &&
        !vistos.has(p.id) &&
        (vistos.add(p.id), true),
    )
    .sort((a, b) => (a.dia < b.dia ? -1 : 1))
    .map((p) => ({ id: p.id, dia: p.dia, total_cents: p.total_cents, origem: p.origem }));
}

const EM_ABERTO = ["rascunho", "em_analise", "aprovado", "expedido"];

/**
 * Histórico + classificação de UM cliente. `pedidos` pode conter todos os
 * status e clientes — a função filtra. `hoje` em "YYYY-MM-DD".
 */
export function historicoDeCompra(
  pedidos: PedidoParaRadar[],
  contactId: string,
  hoje: string,
): HistoricoCompra {
  const vendas = vendasDe(pedidos, contactId, hoje);
  const totais = vendas.map((v) => v.total_cents);
  const dias = vendas.map((v) => v.dia);
  // Ocasiões de compra = dias distintos. Pedidos do MESMO dia não fazem
  // ciclo: sem isso, 2 pedidos num dia só dariam "a cada ~0 dias" e atraso
  // de +670 — o ciclo mede volta, não volume do dia.
  const diasUnicos = [...new Set(dias)];
  const intervalos: number[] = [];
  for (let i = 1; i < diasUnicos.length; i++) {
    const d = diasEntre(diasUnicos[i - 1] as string, diasUnicos[i] as string);
    if (d > 0) intervalos.push(d);
  }

  const abertos = pedidos.filter(
    (p) => p.contact_id === contactId && EM_ABERTO.includes(p.status) && p.dia <= hoje,
  );
  const orcamentos = pedidos.filter((p) => p.contact_id === contactId && p.status === "rascunho" && p.dia <= hoje);
  const cancelados = pedidos.filter((p) => p.contact_id === contactId && p.status === "cancelado");

  const ultima = dias.length > 0 ? (dias[dias.length - 1] as string) : null;
  const diasSem = ultima ? diasEntre(ultima, hoje) : 0;
  const intervaloTipico = mediana(intervalos) ?? media(intervalos);
  const atraso = intervaloTipico != null && ultima ? Math.max(0, Math.round(diasSem - intervaloTipico)) : 0;

  const origens = new Map<string, number>();
  for (const v of vendas) origens.set(v.origem, (origens.get(v.origem) ?? 0) + 1);
  const canal = [...origens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const soma = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);
  const somaOrc = soma(orcamentos.map((p) => p.total_cents));
  const somaCanc = soma(cancelados.map((p) => p.total_cents));
  const aberto = abertos.sort((a, b) => (a.dia < b.dia ? 1 : -1))[0] ?? null;
  const temCanceladoAposUltima =
    cancelados.some((p) => ultima == null || p.dia >= ultima) && vendas.length > 0;

  let situacao: SituacaoRecompra = "ok";
  if (vendas.length === 0) situacao = "novo_sem_compras";
  else if (aberto && intervaloTipico != null && diasSem > intervaloTipico) situacao = "em_voo";
  else if (somaOrc > 0 && atraso === 0) situacao = "oportunidade_aberta";
  else if (temCanceladoAposUltima && atraso === 0) situacao = "cancelado_sem_nova";
  else if (intervaloTipico != null && atraso > intervaloTipico) situacao = "em_risco";
  else if (atraso > 0) situacao = "recompra_atrasada";
  // Uma única OCASIÃO de compra (1 venda, ou N pedidos no mesmo dia) não
  // tem ciclo: sem isso, 2 pedidos num dia só cairiam em "ok" com "há 670
  // dias sem comprar" e sem intervalo para explicar o atraso.
  else if (diasUnicos.length <= 1) situacao = "primeira_compra";

  return {
    contact_id: contactId,
    vendas,
    primeira_compra: dias[0] ?? "",
    ultima_compra: ultima ?? "",
    qtd_pedidos: vendas.length,
    faturamento_cents: soma(totais),
    ticket_medio_cents: media(totais) ?? 0,
    ticket_mediano_cents: mediana(totais) ?? 0,
    intervalo_medio_dias: media(intervalos),
    intervalo_mediano_dias: mediana(intervalos),
    maior_intervalo_dias: intervalos.length > 0 ? Math.max(...intervalos) : null,
    menor_intervalo_dias: intervalos.length > 0 ? Math.min(...intervalos) : null,
    canal_predominante: canal,
    dias_sem_compra: diasSem,
    atraso_dias: atraso,
    situacao,
    pedido_aberto_id: aberto?.id ?? null,
    pedido_aberto_total_cents: aberto?.total_cents ?? null,
    orcamento_total_cents: somaOrc > 0 ? somaOrc : null,
    cancelado_total_cents: somaCanc > 0 ? somaCanc : null,
    ultimos: vendas.slice(-4).reverse().map((v) => ({ id: v.id, dia: v.dia, total_cents: v.total_cents })),
  };
}
