import { contaComoVenda } from "./dashboard";

/**
 * A CARTEIRA DE CLIENTES — matemática pura do painel estilo Indicadores.
 *
 * Vocabulário herdado do Mercos (medido na tela de clientes, 2026-09-06):
 * - ATIVO: comprou dentro de um ciclo médio de pedidos;
 * - INATIVO RECENTE: passou de um ciclo, mas não de dois;
 * - INATIVO ANTIGO: dois ciclos ou mais sem comprar;
 * - PROSPECT: contato sem nenhuma venda.
 *
 * Tudo em dias UTC ("YYYY-MM-DD") — o fuso já foi resolvido por quem chama
 * (`diaNoFuso`), como no resto de `lib/comercial`.
 */

export interface VendaParaCarteira {
  contact_id: string | null;
  total_cents: number;
  status: string;
  dia: string;
}

function soVendas(pedidos: VendaParaCarteira[]): VendaParaCarteira[] {
  return pedidos.filter((p) => p.contact_id && contaComoVenda(p.status));
}

/**
 * Ciclo médio em dias: média dos intervalos entre compras consecutivas de
 * cada cliente, agregada pela mediana (um atacadista não pode puxar a régua
 * da loja inteira). Sem histórico suficiente, 90 dias.
 */
export function cicloMedioDias(pedidos: VendaParaCarteira[]): number {
  const porContato = new Map<string, string[]>();
  for (const p of soVendas(pedidos)) {
    const lista = porContato.get(p.contact_id as string) ?? [];
    lista.push(p.dia);
    porContato.set(p.contact_id as string, lista);
  }
  const medias: number[] = [];
  for (const dias of porContato.values()) {
    const ord = [...new Set(dias)].sort();
    if (ord.length < 2) continue;
    let soma = 0;
    for (let i = 1; i < ord.length; i++) {
      const atual = ord[i] as string;
      const anterior = ord[i - 1] as string;
      soma +=
        (new Date(`${atual}T12:00:00Z`).getTime() - new Date(`${anterior}T12:00:00Z`).getTime()) / 86400000;
    }
    medias.push(soma / (ord.length - 1));
  }
  if (medias.length === 0) return 90;
  medias.sort((a, b) => a - b);
  const meio = Math.floor(medias.length / 2);
  const mediana = medias.length % 2 === 0 ? ((medias[meio - 1] as number) + (medias[meio] as number)) / 2 : (medias[meio] as number);
  return Math.min(365, Math.max(7, Math.round(mediana)));
}

export interface SituacaoDaCarteira {
  ativos: number;
  inativosRecentes: number;
  inativosAntigos: number;
  prospects: number;
  cicloDias: number;
}

function diasEntre(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86400000,
  );
}

export function situacaoDaCarteira(args: {
  pedidos: VendaParaCarteira[];
  totalContatos: number;
  hoje: string;
  cicloDias?: number;
}): SituacaoDaCarteira {
  const ciclo = args.cicloDias ?? cicloMedioDias(args.pedidos);
  const ultima = new Map<string, string>();
  for (const p of soVendas(args.pedidos)) {
    const id = p.contact_id as string;
    if (!ultima.has(id) || (ultima.get(id) as string) < p.dia) ultima.set(id, p.dia);
  }
  let ativos = 0;
  let recentes = 0;
  let antigos = 0;
  for (const dia of ultima.values()) {
    const ha = diasEntre(dia, args.hoje);
    if (ha <= ciclo) ativos++;
    else if (ha <= ciclo * 2) recentes++;
    else antigos++;
  }
  return {
    ativos,
    inativosRecentes: recentes,
    inativosAntigos: antigos,
    prospects: Math.max(0, args.totalContatos - ultima.size),
    cicloDias: ciclo,
  };
}

/** Quantos clientes distintos compraram no mês (base da positivação). */
export function clientesNoMes(pedidos: VendaParaCarteira[], anoMes: string): number {
  const ids = new Set<string>();
  for (const p of soVendas(pedidos)) {
    if (p.dia.startsWith(anoMes)) ids.add(p.contact_id as string);
  }
  return ids.size;
}

export interface FaixaABC {
  faixa: "A" | "B" | "C";
  clientes: number;
  cents: number;
  pct: number;
}

/**
 * Curva ABC por faturamento acumulado: A até 80%, B até 95%, C o resto —
 * o corte do relatório do Mercos. Entrada já somada por cliente, em cents.
 */
export function curvaABC(valores: { chave: string; cents: number }[]): { faixas: FaixaABC[]; total: number } {
  const total = valores.reduce((a, v) => a + v.cents, 0);
  const faixas: FaixaABC[] = [
    { faixa: "A", clientes: 0, cents: 0, pct: 0 },
    { faixa: "B", clientes: 0, cents: 0, pct: 0 },
    { faixa: "C", clientes: 0, cents: 0, pct: 0 },
  ];
  if (total <= 0) return { faixas, total };
  let acumulado = 0;
  for (const v of [...valores].sort((a, b) => b.cents - a.cents)) {
    acumulado += v.cents;
    const f = faixas[acumulado / total <= 0.8 ? 0 : acumulado / total <= 0.95 ? 1 : 2] as FaixaABC;
    f.clientes++;
    f.cents += v.cents;
  }
  for (const f of faixas) f.pct = (f.cents / total) * 100;
  return { faixas, total };
}
