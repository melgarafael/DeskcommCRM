import type { SupabaseClient } from "@supabase/supabase-js";

import { cicloMedioDias, clientesNoMes, curvaABC, situacaoDaCarteira } from "./carteira";
import { contaComoVenda } from "./dashboard";
import {
  diaNoFuso,
  serieDiariaDoMes,
  totaisDoMes,
  vendasPorVendedor,
} from "./inteligencia";
import { carregarJanelaDeVendas } from "./janela";

/**
 * AGREGADOS DO MÊS — fonte única do painel Indicadores e do Indicador IA.
 *
 * A página (`app/app/indicadores/page.tsx`) e o endpoint de perguntas
 * (`POST /api/v1/indicadores/perguntar`) lêem daqui: dois leitores, um
 * cálculo — divergir os dois seria o painel dizer um número e a IA outro.
 */
export interface AgregadosIndicadores {
  mes: string;
  vendidoMes: number;
  qtdMes: number;
  serieDiaria: { dia: string; cents: number }[];
  metaLoja: number | null;
  metasVendedores: Record<string, number>;
  ranking: { vendedorId: string; total: number; qtd: number; ticket: number; clientes: number }[];
  carteira: { ativos: number; inativosRecentes: number; inativosAntigos: number; prospects: number; cicloDias: number };
  positivacao: { compraram: number; base: number };
  abc: { faixa: string; clientes: number; cents: number }[];
  faturado: number;
  naoFaturado: number;
  /** Séries diárias de meses de comparação (mesmo filtro de vendedor). */
  seriesExtras: Record<string, { dia: string; cents: number }[]>;
}

const LIMITE = 25000;

export async function agregadosDoMes(args: {
  supabase: SupabaseClient;
  orgId: string;
  mes: string;
  fuso: string;
  hoje: string;
  filtroVendedor?: string;
  inicioJanela: string;
  /** Meses extras (AAAA-MM) para comparação — mesma janela, sem query nova. */
  mesesExtras?: string[];
}): Promise<{ agregados: AgregadosIndicadores; totalContatos: number; cortado: boolean }> {
  const { supabase, orgId, mes, fuso, hoje, inicioJanela } = args;
  const filtroVendedor = args.filtroVendedor ?? "";

  type Linha = {
    id: string; total_cents: number; status: string; origem: string;
    vendedor_user_id: string | null; contact_id: string | null; created_at: string;
  };
  const { linhas: linhasCruas, cortado } = await carregarJanelaDeVendas(supabase, orgId, inicioJanela, LIMITE);
  const linhas = linhasCruas as unknown as Linha[];

  const [{ data: metas }, { count: totalContatos }] = await Promise.all([
    supabase
      .from("commercial_goals")
      .select("vendedor_user_id, valor_cents, ano_mes")
      .eq("organization_id", orgId)
      .eq("ano_mes", mes),
    supabase.from("contacts").select("id", { count: "exact", head: true }).eq("organization_id", orgId),
  ]);
  const listaMetas = (metas ?? []) as { vendedor_user_id: string | null; valor_cents: number }[];
  const metasVendedores: Record<string, number> = {};
  for (const m of listaMetas) {
    if (m.vendedor_user_id) metasVendedores[m.vendedor_user_id] = m.valor_cents;
  }
  const metaLoja =
    listaMetas.find((m) => m.vendedor_user_id === (filtroVendedor || null))?.valor_cents ??
    listaMetas.find((m) => m.vendedor_user_id === null)?.valor_cents ??
    null;

  const doVendedor = filtroVendedor
    ? linhas.filter((p) => (p.vendedor_user_id ?? "sem_vendedor") === filtroVendedor)
    : linhas;
  const serie = serieDiariaDoMes(doVendedor, mes, fuso);
  const totais = totaisDoMes(doVendedor, mes, fuso);
  const seriesExtras: Record<string, { dia: string; cents: number }[]> = {};
  for (const extra of args.mesesExtras ?? []) {
    seriesExtras[extra] = serieDiariaDoMes(doVendedor, extra, fuso).map((s) => ({ dia: s.dia, cents: s.total_cents }));
  }
  const ranking = vendasPorVendedor(doVendedor, mes, fuso).map((l) => ({
    vendedorId: l.vendedorId,
    total: l.total_cents,
    qtd: l.qtd,
    ticket: l.ticket_medio_cents,
    clientes: l.clientes,
  }));

  let faturado = 0;
  let naoFaturado = 0;
  for (const p of doVendedor) {
    if (!contaComoVenda(p.status) || diaNoFuso(p.created_at, fuso).slice(0, 7) !== mes) continue;
    if (p.status === "faturado") faturado += p.total_cents;
    else naoFaturado += p.total_cents;
  }

  const paraCarteira = linhas.map((p) => ({
    contact_id: p.contact_id,
    total_cents: p.total_cents,
    status: p.status,
    dia: diaNoFuso(p.created_at, fuso),
  }));
  const ciclo = cicloMedioDias(paraCarteira);
  const carteira = situacaoDaCarteira({ pedidos: paraCarteira, totalContatos: totalContatos ?? 0, hoje, cicloDias: ciclo });
  const compraram = clientesNoMes(paraCarteira, mes);
  const basePositivacao = carteira.ativos + carteira.inativosRecentes + carteira.inativosAntigos;

  const porCliente = new Map<string, number>();
  for (const p of linhas) {
    if (!p.contact_id || p.status !== "faturado") continue;
    porCliente.set(p.contact_id, (porCliente.get(p.contact_id) ?? 0) + p.total_cents);
  }
  const abc = curvaABC([...porCliente.entries()].map(([chave, cents]) => ({ chave, cents })));

  return {
    agregados: {
      mes,
      vendidoMes: totais.total_cents,
      qtdMes: totais.qtd,
      serieDiaria: serie.map((s) => ({ dia: s.dia, cents: s.total_cents })),
      metaLoja,
      metasVendedores,
      ranking,
      carteira: {
        ativos: carteira.ativos,
        inativosRecentes: carteira.inativosRecentes,
        inativosAntigos: carteira.inativosAntigos,
        prospects: carteira.prospects,
        cicloDias: carteira.cicloDias,
      },
      positivacao: { compraram, base: basePositivacao },
      abc: abc.faixas.map((f) => ({ faixa: f.faixa, clientes: f.clientes, cents: f.cents })),
      faturado,
      naoFaturado,
      seriesExtras,
    },
    totalContatos: totalContatos ?? 0,
    cortado,
  };
}
