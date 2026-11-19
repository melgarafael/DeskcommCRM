/**
 * A META EM VALOR DE VENDA — a fatia 2 da #3025 (issue #4796).
 *
 * ─── O número que a meta por quantidade não sabe dizer ──────────────────────
 *
 * A meta da fatia 1 conta VENDAS GANHAS. Numa agência de viagens uma venda de
 * R$ 3 mil e outra de R$ 80 mil contam igual nessa régua — e o gestor cobra o
 * time pelo FATURAMENTO do mês, que é outro número. Aqui o indicador `valor_vendido`
 * transforma o alvo em reais (guardados em CENTAVOS, a mesma unidade de
 * `crm_leads.value_cents`) e o realizado na soma do que foi fechado.
 *
 * ─── A janela é a MESMA da contagem, e é por isso que ela vem por parâmetro ─
 *
 * `status = 'won'` E `closed_at` em `[from, to)`. Nada de janela própria, nada
 * de `created_at`: o negócio pode ter nascido em julho e fechado em setembro, e
 * a venda é de setembro. As funções abaixo REAPLICAM esse par mesmo quando a
 * consulta já filtrou (defesa em profundidade): a sabotagem que troca a coluna
 * da janela derruba o teste, em vez de passar calada por causa de um `where`
 * que alguém já tinha escrito.
 *
 * ─── Valor nulo ou zero NÃO é venda de R$ 0 ────────────────────────────────
 *
 * Quem não preenche valor no card é a maioria. Somar `null` como zero não muda
 * a soma, mas CONTAR o negócio como "venda de valor" muda o número de vendas
 * medidas e a média por venda. Por isso o balde separa `negocios_com_valor` de
 * `ignorados_sem_valor`, e o zero entra no segundo — o card sem preço não
 * fabrica R$ 0,00 fantasma.
 *
 * ─── Moeda: somar dólar com real produz um número que não existe ───────────
 *
 * A meta em valor é na moeda da ORGANIZAÇÃO (o alvo está em centavos dela). Um
 * ganho em outra moeda não entra na soma: ele é contado em `ignorados_outra_moeda`
 * em vez de ser convertido por câmbio inventado. Negócio com moeda nula é da
 * moeda da organização (a mesma reserva que `lib/money` usa).
 *
 * Módulo PURO: recebe linhas, devolve números. Quem lê o banco é a rota.
 */

/** Os indicadores que uma meta pode ter. O default é o da fatia 1. */
export const INDICADORES_DE_META = ["vendas_ganhas", "valor_vendido"] as const;

export type IndicadorDeMeta = (typeof INDICADORES_DE_META)[number];

/**
 * Meta antiga, gravada antes deste campo existir, continua valendo por
 * QUANTIDADE — é o comportamento que ela tinha quando foi cadastrada.
 */
export const INDICADOR_PADRAO: IndicadorDeMeta = "vendas_ganhas";

/** Texto vindo do banco (ou de um cliente antigo) → indicador conhecido. */
export function normalizarIndicador(valor: unknown): IndicadorDeMeta {
  return valor === "valor_vendido" ? "valor_vendido" : INDICADOR_PADRAO;
}

/** A linha do negócio como a soma precisa dela — nada além disso. */
export interface NegocioDaMeta {
  status: string | null;
  closed_at: string | null;
  pipeline_id?: string | null;
  owner_user_id?: string | null;
  currency?: string | null;
  value_cents?: number | null;
}

export interface JanelaDaMeta {
  from: string;
  to: string;
}

export interface ValorRealizado {
  /** Soma em centavos da moeda da organização. Piso quando `truncado`. */
  centavos: number;
  /** Quantos negócios efetivamente somaram valor (> 0). */
  negocios_com_valor: number;
  /** Ganhos da janela sem valor medido: `null`, zero ou negativo. */
  ignorados_sem_valor: number;
  /** Ganhos da janela em OUTRA moeda (não entram na soma). */
  ignorados_outra_moeda: number;
}

/**
 * Soma o realizado em valor dos negócios GANHOS fechados dentro da janela.
 *
 * `pipelineId` recorta o funil da meta (o filtro por funil é a fatia seguinte;
 * se a meta tem funil gravado, ela é respeitada aqui de graça). `vendedorId`
 * recorta a meta individual.
 */
export function somarValorRealizado(params: {
  negocios: readonly NegocioDaMeta[];
  janela: JanelaDaMeta;
  moeda: string | null;
  pipelineId?: string | null;
  vendedorId?: string | null;
}): ValorRealizado {
  const { negocios, janela, moeda, pipelineId, vendedorId } = params;
  const de = Date.parse(janela.from);
  const ate = Date.parse(janela.to);

  let centavos = 0;
  let negociosComValor = 0;
  let semValor = 0;
  let outraMoeda = 0;

  for (const negocio of negocios) {
    if (negocio.status !== "won") continue;
    if (!negocio.closed_at) continue;
    const fechadoEm = Date.parse(negocio.closed_at);
    // A MESMA régua da contagem: `[from, to)`, limite de cima exclusivo.
    if (!Number.isFinite(fechadoEm) || fechadoEm < de || fechadoEm >= ate) continue;
    if (pipelineId && negocio.pipeline_id !== pipelineId) continue;
    if (vendedorId && negocio.owner_user_id !== vendedorId) continue;

    const moedaDoNegocio = negocio.currency ?? null;
    if (moedaDoNegocio && moeda && moedaDoNegocio !== moeda) {
      outraMoeda += 1;
      continue;
    }

    const valor = negocio.value_cents;
    // `null`, ausente, zero e negativo NÃO viram venda de R$ 0 fantasma.
    if (typeof valor !== "number" || !Number.isFinite(valor) || valor <= 0) {
      semValor += 1;
      continue;
    }
    centavos += valor;
    negociosComValor += 1;
  }

  return {
    centavos,
    negocios_com_valor: negociosComValor,
    ignorados_sem_valor: semValor,
    ignorados_outra_moeda: outraMoeda,
  };
}

/**
 * Projeção até o fim da janela, no ritmo medido até agora.
 *
 * `realizado / fração decorrida`. `null` quando não há o que projetar: janela
 * que ainda não começou (nada medido) ou que já terminou (o número final é o
 * próprio realizado — projetar seria repetir). Zero realizado projeta zero.
 */
export function projetarFimDaJanela(params: {
  realizado: number;
  janela: JanelaDaMeta;
  agora: Date;
}): number | null {
  const { realizado, janela, agora } = params;
  const de = Date.parse(janela.from);
  const ate = Date.parse(janela.to);
  const agoraMs = agora.getTime();
  if (!Number.isFinite(de) || !Number.isFinite(ate) || ate <= de) return null;
  if (agoraMs < de || agoraMs >= ate) return null;
  const fracao = (agoraMs - de) / (ate - de);
  if (fracao <= 0) return null;
  return Math.round(realizado / fracao);
}

export interface ProgressoDaMeta {
  percentual: number;
  falta: number;
  atingida: boolean;
}

/**
 * O derivado que a tela mostra — o MESMO para quantidade e para valor.
 *
 * Percentual acima de 100 é informação; a barra para em 100 e "quanto falta"
 * nunca é negativo (passar da meta não vira dívida).
 */
export function progressoDaMeta(params: { alvo: number; realizado: number }): ProgressoDaMeta {
  const { alvo, realizado } = params;
  if (!Number.isFinite(alvo) || alvo <= 0) {
    // Não se inventa percentual com denominador inválido; quem chama já recusou
    // a linha antes. Devolver `0%` aqui seria uma medida falsa.
    return { percentual: 0, falta: 0, atingida: false };
  }
  return {
    percentual: Math.round((realizado / alvo) * 100),
    falta: Math.max(0, alvo - realizado),
    atingida: realizado >= alvo,
  };
}
