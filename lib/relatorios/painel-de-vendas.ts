/**
 * O PAINEL DE VENDAS — a conta, sem banco e sem tela.
 *
 * ─── A pergunta ──────────────────────────────────────────────────────────────
 *
 * "Quanto vendi no período, quantas vendas foram, qual o ticket médio, quanto
 * converti e como isso andou dia a dia?" — tudo numa tela só, em cartões
 * grandes. A fonte são os negócios do funil, e não as comandas.
 *
 * ─── O que é uma VENDA aqui (duas origens, nunca em dobro) ──────────────────
 *
 *  - VENDA REGISTRADA (`vendas_registradas`, migration 9449): o vendedor
 *    registrou "vendeu R$ 180 em 20/11" no negócio. Conta pela DATA dela, em
 *    QUALQUER etapa do card, e o mesmo negócio pode ter várias (recompra).
 *  - NEGÓCIO GANHO SEM VENDA REGISTRADA: o card foi para a etapa de ganho e
 *    ninguém registrou venda — conta como uma venda, pelo valor do card e pela
 *    data do GANHO, no fuso da organização (o comportamento de antes).
 *  - Negócio ganho QUE TEM venda registrada (de qualquer data) não conta pelo
 *    ganho: as vendas registradas dele já contam. Sem isto o mesmo dinheiro
 *    entraria duas vezes.
 *
 * ─── As réguas (o contrato da rota `/api/v1/reports/painel-de-vendas`) ──────
 *
 *  - VALOR VENDIDO = soma das vendas NA MOEDA DA ORGANIZAÇÃO. Venda em outra
 *    moeda conta como venda, fica fora da soma e é dita (`excluidos.outra_moeda`).
 *  - TICKET MÉDIO = valor vendido ÷ vendas COM valor. Venda sem valor não puxa a
 *    média para baixo; é contada à parte (`vendas_sem_valor`). Sem base, `null`.
 *  - CONVERSÃO = negócios ganhos ÷ (ganhos + perdidos) FECHADOS na janela — é
 *    a taxa de ganho dos NEGÓCIOS, não das vendas (uma recompra não é um negócio
 *    novo ganho). Sem nenhum fechado, `null` — nunca 0%.
 *  - SÉRIE = um ponto por DIA; acima de `DIAS_DA_SERIE_DIARIA` dias, por MÊS.
 *    Dia sem venda é ponto zero, não buraco.
 *  - TAGS de uma venda = as dela + as do negócio, normalizadas: uma venda sem
 *    tag num negócio "atacado" é de atacado.
 *  - RECORTE (funil e tag) = a MESMA regra da lista de vendas do Faturamento
 *    (`passaNoFiltro`). Vale para as vendas e para a conversão. Os cartões, os
 *    rankings e a lista desta tela saem da MESMA lista de vendas — nunca de
 *    réguas diferentes.
 */
import { normalizarTagDoRelatorio, passaNoFiltro, type FiltroDoRelatorio } from "./comercial";
import { dataNoFuso, proximoDia, type JanelaDoRelatorio } from "./janela";

/** Acima disto a série vira mensal. */
export const DIAS_DA_SERIE_DIARIA = 62;

/** Quantas linhas a lista de vendas do painel traz (as mais recentes). */
export const LIMITE_DA_LISTA_DO_PAINEL = 100;
/** Quantas linhas cada ranking traz. */
export const LIMITE_DOS_RANKINGS = 10;

export interface NegocioDoPainel {
  id?: string;
  status: string;
  closed_at: string | null;
  value_cents: number | null;
  currency: string | null;
  pipeline_id?: string | null;
  tags?: string[] | null;
  contact_id?: string | null;
  title?: string | null;
  /** O responsável pelo negócio — o vendedor de um card ganho sem venda registrada. */
  owner_user_id?: string | null;
}

/** Uma venda REGISTRADA (`vendas_registradas`), como o painel a lê. */
export interface VendaRegistradaDoPainel {
  id: string;
  lead_id: string | null;
  contact_id: string | null;
  valor_cents: number;
  currency: string;
  /** AAAA-MM-DD — o dia da venda na parede da empresa. */
  data: string;
  tags: string[];
  /** Quem registrou a venda — o vendedor dela. */
  created_by?: string | null;
}

/** O negócio dono de uma venda registrada (funil, tags e título vêm dele). */
export interface NegocioDaVenda {
  pipeline_id: string | null;
  tags: string[] | null;
  title: string | null;
  contact_id: string | null;
}

export type GranularidadeDoPainel = "dia" | "mes";

export interface PontoDaSerie {
  /** `AAAA-MM-DD` (dia) ou `AAAA-MM` (mês), na parede da organização. */
  chave: string;
  vendas: number;
  centavos: number;
}

/** Uma venda do período, das duas origens, já com o recorte aplicável. */
export interface VendaDoPeriodo {
  id: string;
  origem: "registrada" | "ganho";
  lead_id: string | null;
  contact_id: string | null;
  pipeline_id: string | null;
  titulo: string | null;
  tags: string[];
  /** Na moeda da organização. `0` = sem valor preenchido; `null` = outra moeda. */
  centavos: number | null;
  /** AAAA-MM-DD. */
  dia: string;
  /** Quem vendeu: quem registrou a venda, ou o responsável pelo card ganho. */
  vendedor_user_id: string | null;
}

export interface LinhaDeRanking {
  chave: string;
  centavos: number;
  vendas: number;
}

export interface PainelDeVendas {
  moeda: string;
  vendas: number;
  vendido_centavos: number;
  vendas_com_valor: number;
  vendas_sem_valor: number;
  ticket_medio_centavos: number | null;
  /** Negócios ganhos e perdidos FECHADOS na janela — a base da conversão. */
  negocios_ganhos: number;
  perdidos: number;
  /** De 0 a 1. `null` quando nada fechou na janela. */
  conversao: number | null;
  granularidade: GranularidadeDoPainel;
  serie: PontoDaSerie[];
  /** Quantas das vendas vieram de cada origem. */
  origens: { registradas: number; ganhos_sem_registro: number };
  excluidos: { outra_moeda: number };
  /** Funis e tags das vendas do período, ANTES do recorte — as opções dos seletores. */
  opcoes: { pipeline_ids: string[]; tags: string[] };
  rankings: { tags: LinhaDeRanking[]; clientes: LinhaDeRanking[]; funis: LinhaDeRanking[] };
  /** As vendas do recorte, da mais recente para a mais antiga, até o limite. */
  lista: VendaDoPeriodo[];
  /** Quantas vendas o recorte tem no total (a lista pode estar cortada). */
  vendas_no_recorte: number;
}

/** Quantos dias de calendário a janela cobre (`de` e `ate` inclusivos). */
export function diasDaJanela(de: string, ate: string): number {
  let dias = 0;
  for (let dia = de; dia <= ate && dias <= 1000; dia = proximoDia(dia)) dias++;
  return dias;
}

/** As chaves da série, na ordem, cobrindo a janela inteira. */
export function chavesDaSerie(de: string, ate: string, granularidade: GranularidadeDoPainel): string[] {
  const chaves: string[] = [];
  for (let dia = de; dia <= ate && chaves.length <= 1000; dia = proximoDia(dia)) {
    const chave = granularidade === "dia" ? dia : dia.slice(0, 7);
    if (chaves[chaves.length - 1] !== chave) chaves.push(chave);
  }
  return chaves;
}

/** Tags normalizadas e sem repetição, na ordem da primeira aparição. */
function unirTags(...listas: Array<readonly string[] | null | undefined>): string[] {
  const vistas = new Set<string>();
  const saida: string[] = [];
  for (const lista of listas) {
    for (const crua of lista ?? []) {
      const tag = normalizarTagDoRelatorio(crua);
      if (tag === "" || vistas.has(tag)) continue;
      vistas.add(tag);
      saida.push(tag);
    }
  }
  return saida;
}

function ranking(vendas: readonly VendaDoPeriodo[], chaves: (v: VendaDoPeriodo) => readonly string[]): LinhaDeRanking[] {
  const porChave = new Map<string, LinhaDeRanking>();
  for (const venda of vendas) {
    for (const chave of chaves(venda)) {
      const linha = porChave.get(chave) ?? { chave, centavos: 0, vendas: 0 };
      linha.vendas++;
      linha.centavos += venda.centavos ?? 0;
      porChave.set(chave, linha);
    }
  }
  return [...porChave.values()]
    .sort((a, b) => b.centavos - a.centavos || b.vendas - a.vendas || a.chave.localeCompare(b.chave))
    .slice(0, LIMITE_DOS_RANKINGS);
}

export function montarPainelDeVendas(entrada: {
  negocios: readonly NegocioDoPainel[];
  janela: JanelaDoRelatorio;
  moedaDaOrganizacao: string;
  /** Funil e tag JÁ normalizada (`normalizarTagDoRelatorio`). Ausente = sem recorte. */
  filtro?: FiltroDoRelatorio;
  /** Vendas registradas com `data` dentro da janela. */
  vendasRegistradas?: readonly VendaRegistradaDoPainel[];
  /** O negócio de cada venda registrada (por `lead_id`). */
  negociosDasVendas?: ReadonlyMap<string, NegocioDaVenda>;
  /** Negócios que têm QUALQUER venda registrada: o ganho deles não conta de novo. */
  negociosComVendaRegistrada?: ReadonlySet<string>;
}): PainelDeVendas {
  const { janela } = entrada;
  const filtro: FiltroDoRelatorio = entrada.filtro ?? { pipeline_id: null, tag: null };
  const moeda = entrada.moedaDaOrganizacao.trim().toUpperCase();
  const comRegistro = entrada.negociosComVendaRegistrada ?? new Set<string>();
  const granularidade: GranularidadeDoPainel =
    diasDaJanela(janela.de, janela.ate) > DIAS_DA_SERIE_DIARIA ? "mes" : "dia";

  const inicio = Date.parse(janela.from);
  const fim = Date.parse(janela.to);
  const naJanela = (iso: string | null): number | null => {
    if (typeof iso !== "string") return null;
    const instante = Date.parse(iso);
    // Janela SEMIABERTA, como a consulta.
    return Number.isFinite(instante) && instante >= inicio && instante < fim ? instante : null;
  };
  // `null` = OUTRA MOEDA (fica fora da soma); `0` = sem valor preenchido.
  const centavosNaMoeda = (valor: number | null, moedaDaVenda: string | null): number | null =>
    (moedaDaVenda ?? moeda).trim().toUpperCase() === moeda ? (typeof valor === "number" ? valor : 0) : null;

  // ── 1. As vendas do período, das duas origens ─────────────────────────────
  const todas: VendaDoPeriodo[] = [];
  let outraMoeda = 0;
  for (const v of entrada.vendasRegistradas ?? []) {
    if (v.data < janela.de || v.data > janela.ate) continue;
    const negocio = v.lead_id ? entrada.negociosDasVendas?.get(v.lead_id) : undefined;
    const centavos = centavosNaMoeda(v.valor_cents, v.currency);
    if (centavos === null) outraMoeda++;
    todas.push({
      id: v.id,
      origem: "registrada",
      lead_id: v.lead_id,
      contact_id: v.contact_id ?? negocio?.contact_id ?? null,
      pipeline_id: negocio?.pipeline_id ?? null,
      titulo: negocio?.title ?? null,
      tags: unirTags(v.tags, negocio?.tags),
      centavos,
      dia: v.data,
      vendedor_user_id: v.created_by ?? null,
    });
  }
  for (const n of entrada.negocios) {
    if (n.status !== "won") continue;
    const instante = naJanela(n.closed_at);
    if (instante === null) continue;
    // O negócio que tem venda registrada conta pelas vendas, não pelo ganho.
    if (n.id && comRegistro.has(n.id)) continue;
    const centavos = centavosNaMoeda(n.value_cents, n.currency);
    if (centavos === null) outraMoeda++;
    todas.push({
      id: n.id ?? `ganho-${todas.length}`,
      origem: "ganho",
      lead_id: n.id ?? null,
      contact_id: n.contact_id ?? null,
      pipeline_id: n.pipeline_id ?? null,
      titulo: n.title ?? null,
      tags: unirTags(n.tags),
      centavos,
      dia: dataNoFuso(new Date(instante), janela.tz),
      vendedor_user_id: n.owner_user_id ?? null,
    });
  }

  // ── 2. As opções dos seletores: o período inteiro, antes do recorte ───────
  const opcoes = {
    pipeline_ids: [...new Set(todas.map((v) => v.pipeline_id).filter((p): p is string => p !== null))].sort(),
    tags: [...new Set(todas.flatMap((v) => v.tags))].sort((a, b) => a.localeCompare(b)),
  };

  // ── 3. O recorte — a MESMA regra da lista do Faturamento ─────────────────
  const vendas = todas.filter((v) => passaNoFiltro({ pipeline_id: v.pipeline_id, tags: v.tags }, filtro));

  // ── 4. Os cartões e a série ──────────────────────────────────────────────
  const serie: PontoDaSerie[] = chavesDaSerie(janela.de, janela.ate, granularidade).map((chave) => ({
    chave,
    vendas: 0,
    centavos: 0,
  }));
  const indice = new Map(serie.map((ponto, i) => [ponto.chave, i]));
  let vendido = 0;
  let comValor = 0;
  let semValor = 0;
  for (const v of vendas) {
    const ponto = serie[indice.get(granularidade === "dia" ? v.dia : v.dia.slice(0, 7)) ?? -1];
    if (ponto) ponto.vendas++;
    if (v.centavos !== null && v.centavos > 0) {
      comValor++;
      vendido += v.centavos;
      if (ponto) ponto.centavos += v.centavos;
    } else if (v.centavos !== null) {
      semValor++;
    }
  }

  // ── 5. A conversão: negócios FECHADOS na janela (ganhos e perdidos) ──────
  let ganhos = 0;
  let perdidos = 0;
  for (const n of entrada.negocios) {
    if (naJanela(n.closed_at) === null) continue;
    if (!passaNoFiltro({ pipeline_id: n.pipeline_id ?? null, tags: n.tags ?? null }, filtro)) continue;
    if (n.status === "won") ganhos++;
    else if (n.status === "lost") perdidos++;
  }

  // ── 6. Rankings e a lista ────────────────────────────────────────────────
  const ordenadas = [...vendas].sort((a, b) => b.dia.localeCompare(a.dia) || a.id.localeCompare(b.id));
  return {
    moeda,
    vendas: vendas.length,
    vendido_centavos: vendido,
    vendas_com_valor: comValor,
    vendas_sem_valor: semValor,
    ticket_medio_centavos: comValor > 0 ? Math.round(vendido / comValor) : null,
    negocios_ganhos: ganhos,
    perdidos,
    conversao: ganhos + perdidos > 0 ? ganhos / (ganhos + perdidos) : null,
    granularidade,
    serie,
    origens: {
      registradas: vendas.filter((v) => v.origem === "registrada").length,
      ganhos_sem_registro: vendas.filter((v) => v.origem === "ganho").length,
    },
    excluidos: { outra_moeda: outraMoeda },
    opcoes,
    rankings: {
      tags: ranking(vendas, (v) => v.tags),
      clientes: ranking(vendas, (v) => (v.contact_id ? [v.contact_id] : [])),
      funis: ranking(vendas, (v) => (v.pipeline_id ? [v.pipeline_id] : [])),
    },
    lista: ordenadas.slice(0, LIMITE_DA_LISTA_DO_PAINEL),
    vendas_no_recorte: vendas.length,
  };
}
