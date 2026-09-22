/**
 * A INTELIGÊNCIA COMERCIAL — agregação pura, testada, sem banco.
 *
 * Mesma separação de `lib/comercial/dashboard.ts`: a página busca as linhas,
 * estas funções agregam. Duas decisões que valem para tudo aqui:
 *
 * - VENDA = `contaComoVenda` (fora rascunho e cancelado). A regra canônica
 *   mora em `dashboard.ts`; este arquivo REUSA, não redefine.
 * - DIA = data no fuso da ORGANIZAÇÃO (`organizations.timezone`), não UTC.
 *   Pedido das 23:30 em SP cai no dia certo — `fatiaDia` UTC errava a
 *   fronteira e ninguém percebia porque o erro é de um dia, não de valor.
 */

import { contaComoVenda } from "./dashboard";
import { ORIGENS_DO_PEDIDO } from "@/lib/schemas/pedidos";

export interface PedidoIntel {
  id: string;
  total_cents: number;
  status: string;
  origem: string;
  vendedor_user_id: string | null;
  contact_id: string | null;
  created_at: string;
}

export const FUSO_PADRAO = "America/Sao_Paulo";

/** "2026-09-05" no fuso dado. Invalidez cai no padrão, nunca explode. */
export function diaNoFuso(iso: string, fuso: string): string {
  try {
    const partes = new Intl.DateTimeFormat("en-CA", {
      timeZone: fuso,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
    if (/^\d{4}-\d{2}-\d{2}$/.test(partes)) return partes;
  } catch {
    // fuso desconhecido — cai no padrão abaixo.
  }
  return iso.slice(0, 10);
}

export function diasNoMes(anoMes: string): number {
  const [ano = 0, mes = 1] = anoMes.split("-").map(Number);
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/** Minutos a somar ao UTC para chegar ao horário de parede no fuso. */
function offsetDoFusoMinutos(instanteMs: number, fuso: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const partes = Object.fromEntries(fmt.formatToParts(new Date(instanteMs)).map((p) => [p.type, p.value]));
  const comoUtc = Date.UTC(
    Number(partes["year"]),
    Number(partes["month"]) - 1,
    Number(partes["day"]),
    Number(partes["hour"]) % 24,
    Number(partes["minute"]),
    Number(partes["second"]),
  );
  return Math.round((comoUtc - instanteMs) / 60000);
}

/**
 * Limites UTC exatos de um dia no fuso ([inicio, fim)) — para drill-down sem
 * perder os pedidos da fronteira da meia-noite. O offset é medido ao meio-dia
 * do próprio dia: transição de horário de verão DENTRO do dia usa o mesmo
 * offset nos dois limites (documentado; SP não tem DST desde 2019).
 */
export function limitesUtcDoDia(dia: string, fuso: string): { inicio: string; fim: string } {
  const [ano = 0, mes = 1, diaNum = 1] = dia.split("-").map(Number);
  let off = -180;
  try {
    off = offsetDoFusoMinutos(Date.UTC(ano, mes - 1, diaNum, 12, 0, 0), fuso);
  } catch {
    // fuso desconhecido — cai no -03:00 de SP abaixo.
  }
  const inicioMs = Date.UTC(ano, mes - 1, diaNum, 0, 0, 0) - off * 60000;
  const fimMs = inicioMs + 86400000;
  return { inicio: new Date(inicioMs).toISOString(), fim: new Date(fimMs).toISOString() };
}

export function mesAnterior(anoMes: string): string {
  const [ano = 0, mes = 1] = anoMes.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 2, 1));
  return d.toISOString().slice(0, 7);
}

export interface PontoDiario {
  dia: string;
  rotulo: string;
  total_cents: number;
  qtd: number;
}

/**
 * Série diária do mês, com TODOS os dias (zero onde não vendeu). Dias futuros
 * entram zerados aqui — quem separa realizado de projeção é o `hojeYMD` de
 * quem chama, não esta função.
 */
export function serieDiariaDoMes(
  pedidos: PedidoIntel[],
  anoMes: string,
  fuso: string,
): PontoDiario[] {
  const total = diasNoMes(anoMes);
  const mapa = new Map<string, { total: number; qtd: number }>();
  for (const p of pedidos) {
    if (!contaComoVenda(p.status)) continue;
    const dia = diaNoFuso(p.created_at, fuso);
    if (!dia.startsWith(anoMes)) continue;
    const atual = mapa.get(dia) ?? { total: 0, qtd: 0 };
    atual.total += p.total_cents;
    atual.qtd += 1;
    mapa.set(dia, atual);
  }
  const [, mes = ""] = anoMes.split("-");
  const serie: PontoDiario[] = [];
  for (let d = 1; d <= total; d++) {
    const dia = `${anoMes}-${String(d).padStart(2, "0")}`;
    const v = mapa.get(dia) ?? { total: 0, qtd: 0 };
    serie.push({
      dia,
      rotulo: `${String(d).padStart(2, "0")}/${mes}`,
      total_cents: v.total,
      qtd: v.qtd,
    });
  }
  return serie;
}

/** Acumulado dia a dia (índice i = soma até o dia i). */
export function acumulado(serie: PontoDiario[]): number[] {
  const saida: number[] = [];
  let soma = 0;
  for (const p of serie) {
    soma += p.total_cents;
    saida.push(soma);
  }
  return saida;
}

/** Meta acumulada linear: dia i deveria ter i/diasNoMes da meta. */
export function metaAcumulada(metaCents: number, dias: number): number[] {
  const saida: number[] = [];
  for (let i = 1; i <= dias; i++) {
    saida.push(Math.round((metaCents * i) / dias));
  }
  return saida;
}

export interface FatiaCanal {
  canal: string;
  qtd: number;
  total_cents: number;
  ticket_medio_cents: number;
  clientes: number;
}

/** Vendas por canal no mês. Origem fora do vocabulário vira "outros". */
export function vendasPorCanal(
  pedidos: PedidoIntel[],
  anoMes: string,
  fuso: string,
): FatiaCanal[] {
  const mapa = new Map<string, { qtd: number; total: number; clientes: Set<string> }>();
  const conhecidos = new Set<string>(ORIGENS_DO_PEDIDO as readonly string[]);
  for (const p of pedidos) {
    if (!contaComoVenda(p.status)) continue;
    if (!diaNoFuso(p.created_at, fuso).startsWith(anoMes)) continue;
    const canal = conhecidos.has(p.origem) ? p.origem : "outros";
    const atual = mapa.get(canal) ?? { qtd: 0, total: 0, clientes: new Set<string>() };
    atual.qtd += 1;
    atual.total += p.total_cents;
    if (p.contact_id) atual.clientes.add(p.contact_id);
    mapa.set(canal, atual);
  }
  return [...mapa.entries()]
    .map(([canal, v]) => ({
      canal,
      qtd: v.qtd,
      total_cents: v.total,
      ticket_medio_cents: v.qtd === 0 ? 0 : Math.round(v.total / v.qtd),
      clientes: v.clientes.size,
    }))
    .sort((a, b) => b.total_cents - a.total_cents);
}

export interface SerieCanal {
  canal: string;
  porDia: number[];
  qtdDia: number[];
}

/** Série diária por canal, alinhada aos dias do mês (para o gráfico). */
export function serieDiariaPorCanal(
  pedidos: PedidoIntel[],
  anoMes: string,
  fuso: string,
): { rotulos: string[]; series: SerieCanal[] } {
  const dias = diasNoMes(anoMes);
  const [, mes = ""] = anoMes.split("-");
  const rotulos = Array.from(
    { length: dias },
    (_, i) => `${String(i + 1).padStart(2, "0")}/${mes}`,
  );
  const mapa = new Map<string, { total: number[]; qtd: number[] }>();
  const conhecidos = new Set<string>(ORIGENS_DO_PEDIDO as readonly string[]);
  for (const p of pedidos) {
    if (!contaComoVenda(p.status)) continue;
    const dia = diaNoFuso(p.created_at, fuso);
    if (!dia.startsWith(anoMes)) continue;
    const canal = conhecidos.has(p.origem) ? p.origem : "outros";
    const serie = mapa.get(canal) ?? { total: new Array(dias).fill(0), qtd: new Array(dias).fill(0) };
    const idx = Number(dia.slice(8, 10)) - 1;
    serie.total[idx]! += p.total_cents;
    serie.qtd[idx]! += 1;
    mapa.set(canal, serie);
  }
  return {
    rotulos,
    series: [...mapa.entries()]
      .map(([canal, s]) => ({ canal, porDia: s.total, qtdDia: s.qtd }))
      .sort((a, b) => b.porDia.reduce((s, v) => s + v, 0) - a.porDia.reduce((s, v) => s + v, 0)),
  };
}

export interface LinhaVendedor {
  vendedorId: string;
  total_cents: number;
  qtd: number;
  ticket_medio_cents: number;
  clientes: number;
  porDia: number[];
}

/** Por vendedor no mês, com série diária alinhada aos dias do mês. */
export function vendasPorVendedor(
  pedidos: PedidoIntel[],
  anoMes: string,
  fuso: string,
): LinhaVendedor[] {
  const dias = diasNoMes(anoMes);
  const mapa = new Map<string, { total: number; qtd: number; clientes: Set<string>; dias: number[] }>();
  for (const p of pedidos) {
    if (!contaComoVenda(p.status)) continue;
    const dia = diaNoFuso(p.created_at, fuso);
    if (!dia.startsWith(anoMes)) continue;
    const id = p.vendedor_user_id ?? "sem_vendedor";
    const atual = mapa.get(id) ?? { total: 0, qtd: 0, clientes: new Set<string>(), dias: new Array(dias).fill(0) };
    atual.total += p.total_cents;
    atual.qtd += 1;
    if (p.contact_id) atual.clientes.add(p.contact_id);
    atual.dias[Number(dia.slice(8, 10)) - 1]! += p.total_cents;
    mapa.set(id, atual);
  }
  return [...mapa.entries()]
    .map(([vendedorId, v]) => ({
      vendedorId,
      total_cents: v.total,
      qtd: v.qtd,
      ticket_medio_cents: v.qtd === 0 ? 0 : Math.round(v.total / v.qtd),
      clientes: v.clientes.size,
      porDia: v.dias,
    }))
    .sort((a, b) => b.total_cents - a.total_cents);
}

export interface TotaisMes {
  total_cents: number;
  qtd: number;
  ticket_medio_cents: number;
  clientes: number;
}

export function totaisDoMes(pedidos: PedidoIntel[], anoMes: string, fuso: string): TotaisMes {
  let total = 0;
  let qtd = 0;
  const clientes = new Set<string>();
  for (const p of pedidos) {
    if (!contaComoVenda(p.status)) continue;
    if (!diaNoFuso(p.created_at, fuso).startsWith(anoMes)) continue;
    total += p.total_cents;
    qtd += 1;
    if (p.contact_id) clientes.add(p.contact_id);
  }
  return { total_cents: total, qtd, ticket_medio_cents: qtd === 0 ? 0 : Math.round(total / qtd), clientes: clientes.size };
}

/**
 * Comparação honesta: mês atual (até o dia N) contra o anterior (até o dia N,
 * limitado aos dias que ele tem). Comparar dia 10 com mês fechado é a mentira
 * mais comum de dashboard.
 */
export function comparacaoMesAnterior(
  pedidos: PedidoIntel[],
  anoMes: string,
  hojeYMD: string,
  fuso: string,
): { atual_cents: number; anterior_cents: number; variacao_pct: number | null } {
  const diaN = Math.min(Number(hojeYMD.slice(8, 10)), diasNoMes(anoMes));
  const anterior = mesAnterior(anoMes);
  const diaNAnt = Math.min(diaN, diasNoMes(anterior));
  let atual = 0;
  let ant = 0;
  for (const p of pedidos) {
    if (!contaComoVenda(p.status)) continue;
    const dia = diaNoFuso(p.created_at, fuso);
    const diaNum = Number(dia.slice(8, 10));
    if (dia.startsWith(anoMes) && diaNum <= diaN) atual += p.total_cents;
    else if (dia.startsWith(anterior) && diaNum <= diaNAnt) ant += p.total_cents;
  }
  return {
    atual_cents: atual,
    anterior_cents: ant,
    variacao_pct: ant === 0 ? null : Math.round(((atual - ant) / ant) * 1000) / 10,
  };
}

/** Totais dos últimos N meses (chave YYYY-MM), para a comparação histórica. */
export function totaisMensais(
  pedidos: PedidoIntel[],
  meses: string[],
  fuso: string,
): { mes: string; total_cents: number; qtd: number }[] {
  const mapa = new Map<string, { total: number; qtd: number }>();
  for (const m of meses) mapa.set(m, { total: 0, qtd: 0 });
  for (const p of pedidos) {
    if (!contaComoVenda(p.status)) continue;
    const chave = diaNoFuso(p.created_at, fuso).slice(0, 7);
    const slot = mapa.get(chave);
    if (!slot) continue;
    slot.total += p.total_cents;
    slot.qtd += 1;
  }
  return meses.map((mes) => ({ mes, total_cents: mapa.get(mes)?.total ?? 0, qtd: mapa.get(mes)?.qtd ?? 0 }));
}

export interface AlertaComercial {
  tipo: "risco" | "atencao" | "ok";
  texto: string;
  destino: string;
}

/**
 * Alertas DERIVADOS dos números — nenhum texto fixo de enfeite. Cada um leva
 * a um destino com drill-down (pedidos filtrados).
 */
export function alertasComerciais(args: {
  metaCents: number | null;
  projetadoCents: number | null;
  ritmoDiario: number;
  ritmoNecessario: number | null;
  crescimentoCanais: { canal: string; variacao_pct: number | null }[];
  ritmoVendedores: { nome: string; abaixoDoRitmo: boolean }[];
  ultimosDias: number[];
}): AlertaComercial[] {
  const alertas: AlertaComercial[] = [];
  if (args.metaCents !== null && args.projetadoCents !== null) {
    if (args.projetadoCents < args.metaCents) {
      alertas.push({
        tipo: "risco",
        texto: "Projeção abaixo da meta",
        destino: "/app/pedidos",
      });
    } else {
      alertas.push({ tipo: "ok", texto: "Meta projetada para ser atingida", destino: "/app/pedidos" });
    }
  }
  if (args.ritmoNecessario !== null && args.ritmoDiario < args.ritmoNecessario) {
    alertas.push({ tipo: "atencao", texto: "Ritmo abaixo do necessário para a meta", destino: "/app/pedidos" });
  }
  for (const c of args.crescimentoCanais) {
    if (c.variacao_pct !== null && c.variacao_pct >= 20) {
      alertas.push({ tipo: "ok", texto: `${c.canal} cresceu ${c.variacao_pct}%`, destino: "/app/pedidos" });
    }
  }
  for (const v of args.ritmoVendedores) {
    if (v.abaixoDoRitmo) {
      alertas.push({ tipo: "atencao", texto: `${v.nome} abaixo do ritmo esperado`, destino: "/app/pedidos" });
    }
  }
  const d = args.ultimosDias;
  if (d.length >= 5 && d.slice(-5).every((v, i, arr) => i === 0 || v <= arr[i - 1]!)) {
    const zerados = d.slice(-5).filter((v) => v === 0).length;
    if (zerados >= 3) {
      alertas.push({ tipo: "atencao", texto: "Queda de vendas nos últimos dias", destino: "/app/pedidos" });
    }
  }
  return alertas;
}
