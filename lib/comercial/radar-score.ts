import type { HistoricoCompra } from "./radar-compras";

/**
 * O SCORE DO RADAR — priorização a partir do HISTÓRICO REAL, sem ML falso.
 *
 * Mesma doutrina de `inatividade.ts`: heurística aberta e documentada. O que o
 * score diz de verdade: "cliente muito atrasado contra o PRÓPRIO padrão, com
 * ticket alto e histórico de volume, vale o contato de hoje". A fórmula está
 * aberta abaixo para a equipe ajustar com o que aprender na prática.
 *
 * Regra de ouro da classificação: o nível segue a `situacao` do
 * `historicoDeCompra` (fonte única) — o atraso JÁ é `dias_sem_compra` contra o
 * intervalo histórico, então "23 dias sem comprar com padrão de 15" cai em
 * risco sem nenhuma regra fixa de dias. Nada aqui redefine o que a lista
 * clássica mostra; só ordena e agrega.
 */

export type NivelRadar = "saudavel" | "atencao" | "risco" | "critico";

export const ROTULO_NIVEL: Record<NivelRadar, string> = {
  saudavel: "Saudável",
  atencao: "Atenção",
  risco: "Risco",
  critico: "Crítico",
};

/** Nível a partir da situação (fonte única — ver cabeçalho).
 *
 * Exceções honestas, sem dia fixo para quem TEM padrão:
 * - `novo_sem_compras` (0 vendas válidas) não é carteira, é prospecção: quem
 *   chama filtra antes (ver `agregarRadar`).
 * - `primeira_compra` (1 ocasião, sem ciclo) não tem contra o que comparar:
 *   vale saudável até 90 dias e atenção depois — o único caso com corte de
 *   dias, e só porque sem ciclo não há outra régua. Nunca risco/crítico.
 */
export function classificarNivel(
  h: Pick<HistoricoCompra, "situacao"> & { dias_sem_compra?: number },
): NivelRadar {
  if (h.situacao === "primeira_compra" && (h.dias_sem_compra ?? 0) > 90) return "atencao";
  switch (h.situacao) {
    case "em_risco":
      return "critico";
    case "recompra_atrasada":
      return "risco";
    case "em_voo":
    case "oportunidade_aberta":
    case "cancelado_sem_nova":
      return "atencao";
    default:
      return "saudavel";
  }
}

/**
 * Score 0–100 de prioridade de contato HOJE.
 * - Urgência (50%): atraso contra o próprio intervalo (satura em 1 ciclo
 *   inteiro de atraso). Sem ciclo (compra única), dias/90.
 * - Valor (30%): ticket médio, teto em R$ 5.000 — mesma convenção do
 *   `scoreDeRecuperacao`, para os dois rankings falarem a mesma língua.
 * - Frequência (20%): teto em 10 pedidos.
 */
export function scoreRecompra(h: Pick<HistoricoCompra, "atraso_dias" | "dias_sem_compra" | "ticket_medio_cents" | "qtd_pedidos"> & {
  intervaloTipico: number | null;
}): number {
  const urgencia =
    (h.intervaloTipico != null && h.intervaloTipico > 0
      ? Math.min(1, h.atraso_dias / h.intervaloTipico)
      : Math.min(1, h.dias_sem_compra / 90)) * 50;
  const valor = Math.min(1, h.ticket_medio_cents / 500000) * 30;
  const frequencia = Math.min(1, h.qtd_pedidos / 10) * 20;
  return Math.round(urgencia + valor + frequencia);
}

/** Linha do radar com o contexto que a API entrega para filtros e ações. */
export interface LinhaRadar {
  contact_id: string;
  nome: string;
  fone: string | null;
  cidade: string | null;
  uf: string | null;
  vendedor_user_id: string | null;
  qtd_pedidos: number;
  ticket_medio_cents: number;
  intervalo_mediano_dias: number | null;
  intervalo_medio_dias: number | null;
  dias_sem_compra: number;
  atraso_dias: number;
  situacao: HistoricoCompra["situacao"];
  ultima_compra: string;
  ultimos: { id: string; dia: string; total_cents: number }[];
}

export function intervaloTipicoDe(l: Pick<LinhaRadar, "intervalo_mediano_dias" | "intervalo_medio_dias">): number | null {
  return l.intervalo_mediano_dias ?? l.intervalo_medio_dias ?? null;
}

export interface ResumoRadar {
  monitorados: number;
  /** Contatos com pedido mas sem nenhuma venda válida — prospecção, fora da saúde. */
  semCompraValida: number;
  emRisco: number;
  riscoPct: number;
  oportunidades: number;
  potencialCents: number;
  receitaRiscoCents: number;
  distrib: Record<NivelRadar, number>;
  recompra: { noPrazo: number; atrasados: number; muitoAtrasados: number; primeiraCompra: number };
  /** Eventos de compra por semana (12 últimas), a partir dos `ultimos`. */
  serie: { semana: string; rotulo: string; compras: number }[];
  /** Só quem tem atraso > 0, do maior score para o menor. */
  ranking: (LinhaRadar & { nivel: NivelRadar; score: number })[];
}

function segundaDe(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function rotuloSemana(segunda: string): string {
  const [a, m, dia] = segunda.split("-");
  void a;
  return `${dia}/${m}`;
}

/** Agregados do radar a partir das linhas — tudo derivado, nada inventado.
 *
 * Carteira = linhas com ao menos 1 venda válida. Contato com pedido mas sem
 * venda (só rascunho/cancelado/futuro) é prospecção: conta em `semCompraValida`
 * e fica FORA da saúde, do donut, da série e do ranking — antes ele caía em
 * "saudável" e inflava a carteira.
 */
export function agregarRadar(linhas: LinhaRadar[], hoje: string): ResumoRadar {
  const semCompraValida = linhas.filter((l) => l.qtd_pedidos === 0).length;
  const carteira = linhas.filter((l) => l.qtd_pedidos > 0);
  const comNivel = carteira.map((l) => {
    const h = {
      situacao: l.situacao,
      atraso_dias: l.atraso_dias,
      dias_sem_compra: l.dias_sem_compra,
      ticket_medio_cents: l.ticket_medio_cents,
      qtd_pedidos: l.qtd_pedidos,
      intervaloTipico: intervaloTipicoDe(l),
    };
    const nivel = classificarNivel({ situacao: l.situacao, dias_sem_compra: l.dias_sem_compra });
    return { ...l, nivel, score: scoreRecompra(h) };
  });

  const emRisco = comNivel.filter((l) => l.nivel === "risco" || l.nivel === "critico");
  const comAtraso = comNivel.filter((l) => l.atraso_dias > 0);

  const distrib: Record<NivelRadar, number> = { saudavel: 0, atencao: 0, risco: 0, critico: 0 };
  const recompra = { noPrazo: 0, atrasados: 0, muitoAtrasados: 0, primeiraCompra: 0 };
  for (const l of comNivel) {
    distrib[l.nivel]++;
    if (intervaloTipicoDe(l) == null) recompra.primeiraCompra++;
    else if (l.nivel === "critico") recompra.muitoAtrasados++;
    else if (l.atraso_dias > 0) recompra.atrasados++;
    else recompra.noPrazo++;
  }

  // Série semanal: cada `ultimos` é um evento de compra real (até 4/cliente).
  const porSemana = new Map<string, number>();
  for (const l of carteira) {
    for (const u of l.ultimos) {
      if (u.dia > hoje) continue;
      const s = segundaDe(u.dia);
      porSemana.set(s, (porSemana.get(s) ?? 0) + 1);
    }
  }
  const base = new Date(`${hoje}T12:00:00Z`).getTime();
  const serie: ResumoRadar["serie"] = [];
  for (let i = 11; i >= 0; i--) {
    const dia = new Date(base - i * 7 * 86400000).toISOString().slice(0, 10);
    const s = segundaDe(dia);
    serie.push({ semana: s, rotulo: rotuloSemana(s), compras: porSemana.get(s) ?? 0 });
  }

  const ranking = comAtraso.sort((a, b) => b.score - a.score || b.atraso_dias - a.atraso_dias);

  return {
    monitorados: carteira.length,
    semCompraValida,
    emRisco: emRisco.length,
    riscoPct: carteira.length === 0 ? 0 : Math.round((emRisco.length / carteira.length) * 1000) / 10,
    oportunidades: comAtraso.length,
    potencialCents: comAtraso.reduce((s, l) => s + l.ticket_medio_cents, 0),
    receitaRiscoCents: emRisco.reduce((s, l) => s + l.ticket_medio_cents, 0),
    distrib,
    recompra,
    serie,
    ranking,
  };
}

export interface FiltroRadar {
  busca: string;
  niveis: NivelRadar[];
  vendedor: string;
  cidade: string;
  diasMin: number;
  ticketMinCents: number;
  /** Só quem comprou há no máximo N dias. null = sem corte. */
  periodoDias: number | null;
}

export const FILTRO_RADAR_VAZIO: FiltroRadar = {
  busca: "",
  niveis: [],
  vendedor: "",
  cidade: "",
  diasMin: 0,
  ticketMinCents: 0,
  periodoDias: null,
};

/** Filtros que funcionam de verdade — todos sobre dados que a linha carrega. */
export function filtrarLinhas(linhas: LinhaRadar[], f: FiltroRadar): LinhaRadar[] {
  const busca = f.busca.trim().toLowerCase();
  const cidade = f.cidade.trim().toLowerCase();
  return linhas.filter((l) => {
    if (busca && !`${l.nome} ${l.fone ?? ""}`.toLowerCase().includes(busca)) return false;
    if (f.niveis.length > 0 && !f.niveis.includes(classificarNivel({ situacao: l.situacao, dias_sem_compra: l.dias_sem_compra }))) return false;
    if (f.vendedor && l.vendedor_user_id !== f.vendedor) return false;
    if (cidade) {
      const onde = `${l.cidade ?? ""}/${l.uf ?? ""}`.toLowerCase();
      if (!onde.includes(cidade) && !(l.cidade ?? "").toLowerCase().includes(cidade)) return false;
    }
    if (l.dias_sem_compra < f.diasMin) return false;
    if (l.ticket_medio_cents < f.ticketMinCents) return false;
    if (f.periodoDias != null && l.dias_sem_compra > f.periodoDias) return false;
    return true;
  });
}
