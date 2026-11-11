/**
 * Previsão ponderada do funil — A REGRA PURA (issue #1535).
 *
 * Quem gere uma equipe comercial pergunta toda semana: **quanto deve entrar, e
 * quando?** O funil guarda os ingredientes (valor + moeda, data prevista de
 * fechamento, etapa) e não faz a conta. Este módulo faz.
 *
 * Três decisões que não são detalhe:
 *
 * 1. **NUNCA SOMA MOEDAS DIFERENTES.** R$ 10 mil e € 4 mil não viram R$ 14 mil
 *    nem "14 mil de alguma coisa". Toda saída é agrupada por moeda, e os totais
 *    são por moeda — separar é o critério de aceite, não um extra.
 *
 * 2. **"SEM PROBABILIDADE" NUNCA É ZERO SILENCIOSO.** Um lead em etapa sem
 *    probabilidade calibrada não entra no ponderado como 0 (que sumiria com o
 *    valor da tela sem avisar) nem como bruto (que inflaria a promessa). Ele é
 *    reportado À PARTE, com o próprio valor, para o gestor ver o que falta
 *    calibrar.
 *
 * 3. **"SEM DATA" TAMBÉM É BALDE, NÃO EXCEÇÃO.** Sem `expected_close_date` não
 *    há mês para onde projetar; o valor continua visível, só sem cronograma.
 *
 * 4. **DUAS PARCELAS, NUNCA UM TOTAL.** Quem vende setup + mensalidade guarda o
 *    setup em `value_cents` e a mensalidade em `recurring_value_cents` (fatia 1
 *    da #3602). Cada balde projeta as DUAS, lado a lado e com o mesmo peso:
 *    `unico` (o valor único, como sempre foi) e `recorrente_mensal` (a
 *    mensalidade nova). Nenhum campo desta resposta soma as duas: somar é o
 *    defeito que a issue descreve. Os campos planos `bruto_cents` e
 *    `ponderado_cents` continuam existindo e continuam sendo SÓ o único — é o
 *    contrato de quem já lê esta resposta e a comparação com o que a tela
 *    mostrava antes. O vocabulário (`unico` / `recorrente_mensal`) é o mesmo de
 *    `lib/metrics/valores-do-periodo.ts`: a previsão é o futuro do que aquela
 *    régua mede no passado.
 *
 * A fonte da probabilidade é escolhida por funil em
 * `crm_pipelines.settings.previsao.fonte`:
 *   - `"etapa"` (padrão): a calibração do gestor em `crm_stages.win_probability`;
 *   - `"ia_quando_houver"`: `crm_lead_scores.ai_probability` quando existe,
 *     caindo para a etapa quando não.
 * Etapas `is_won` e `is_lost` valem implicitamente 100 e 0 — na regra, não
 * gravado (migration 0426).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { PERIODICIDADE_PADRAO } from "@/lib/leads/valor-recorrente";

export type FonteDeProbabilidade = "etapa" | "ia_quando_houver";

export const FONTE_PADRAO: FonteDeProbabilidade = "etapa";

/** O que a regra precisa saber de cada etapa. */
export interface EtapaDaPrevisao {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
  /** `null` = etapa sem probabilidade calibrada → balde "sem probabilidade". */
  win_probability: number | null;
}

/** O que a regra precisa saber de cada negócio ABERTO. */
export interface LeadDaPrevisao {
  id: string;
  stage_id: string | null;
  status: string;
  value_cents: number | null;
  currency: string | null;
  /** Coluna `date` do Postgres: `"YYYY-MM-DD"` ou `null`. */
  expected_close_date: string | null;
  /** A mensalidade nova (fatia 1 da #3602). `null` = negócio de valor único. */
  recurring_value_cents?: number | null;
  /** `"monthly"` na v1; ausente com mensalidade presente também é mensal. */
  recurring_period?: string | null;
  /** Duração em meses; `null` = sem prazo. A projeção NÃO multiplica por ela. */
  recurring_months?: number | null;
  /** De `crm_lead_scores`, quando a fonte é `ia_quando_houver`. 0–100. */
  ai_probability?: number | null;
}

/**
 * Uma das duas parcelas de um balde — o MESMO par bruto/ponderado, duas vezes.
 *
 * Não existe campo com a soma das parcelas, e é de propósito: `unico` e
 * `recorrente_mensal` entram em meses diferentes do caixa (o setup uma vez, a
 * mensalidade todo mês) e somá-las produziria um número que não acontece.
 */
export interface ParcelaDoBalde {
  bruto_cents: number;
  ponderado_cents: number;
}

/** Um recorte por moeda: o valor bruto, o ponderado e quantos negócios. */
export interface Balde {
  moeda: string;
  /**
   * ⚠️ SÓ A PARCELA ÚNICA (`unico.bruto_cents`). O nome é o de antes da #3602 e
   * continua igual de propósito: quem já lê esta resposta não pode passar a
   * receber um número com a mensalidade embutida sem saber.
   */
  bruto_cents: number;
  /** ⚠️ SÓ A PARCELA ÚNICA (`unico.ponderado_cents`), pela mesma razão. */
  ponderado_cents: number;
  /** Negócios abertos neste balde (únicos e recorrentes juntos). */
  n: number;
  /** O valor ÚNICO projetado: `value_cents` × probabilidade. */
  unico: ParcelaDoBalde;
  /** A MENSALIDADE projetada: `recurring_value_cents` mensal × a mesma probabilidade. */
  recorrente_mensal: ParcelaDoBalde;
}

/**
 * Recorrência que a projeção MENSAL não soma: periodicidade que este build não
 * projeta por mês (hoje o CHECK do banco só aceita `monthly`, mas o vocabulário
 * é aberto e um build mais novo pode gravar outra).
 *
 * Fica reportada à parte, com o valor, em vez de sumir: o defeito da #3602 é
 * exatamente dinheiro que existe e não aparece em número nenhum.
 */
export interface RecorrenciaForaDoMes {
  moeda: string;
  bruto_cents: number;
  ponderado_cents: number;
  n: number;
}

/** Um mês de `expected_close_date`, dentro de uma moeda. */
export interface FaixaDeMes extends Balde {
  /** `"YYYY-MM"`. */
  mes: string;
}

export interface Previsao {
  fonte: FonteDeProbabilidade;
  /** Por moeda × mês de `expected_close_date`, em ordem de moeda e de mês. */
  meses: FaixaDeMes[];
  /** Por moeda. NUNCA um total único: moeda diferente não soma. */
  totais: Balde[];
  /** Negócios abertos sem data prevista — valor visível, cronograma ausente. */
  sem_data: Balde[];
  /**
   * Negócios em etapa sem probabilidade (ou sem pontuação da IA, quando a
   * fonte é `ia_quando_houver`). Reportado à parte, com o valor real.
   */
  sem_probabilidade: Balde[];
  /**
   * Recorrências que a parcela `recorrente_mensal` NÃO soma por não serem
   * mensais — visíveis com o valor, e fora do cronograma de propósito.
   */
  recorrencia_nao_mensal: RecorrenciaForaDoMes[];
}

const parcelaVazia = (): ParcelaDoBalde => ({ bruto_cents: 0, ponderado_cents: 0 });

const baldeVazio = (moeda: string): Balde => ({
  moeda,
  bruto_cents: 0,
  ponderado_cents: 0,
  n: 0,
  unico: parcelaVazia(),
  recorrente_mensal: parcelaVazia(),
});

/**
 * Soma UM negócio no balde, nas duas parcelas.
 *
 * Os campos planos recebem só a parcela única: é a retrocompatibilidade
 * declarada no cabeçalho deste módulo, e o teste `previsao.test.ts` fixa que
 * nenhum deles carrega a mensalidade.
 */
function somar(alvo: Balde, unico: ParcelaDoBalde, recorrenteMensal: ParcelaDoBalde): void {
  alvo.unico.bruto_cents += unico.bruto_cents;
  alvo.unico.ponderado_cents += unico.ponderado_cents;
  alvo.recorrente_mensal.bruto_cents += recorrenteMensal.bruto_cents;
  alvo.recorrente_mensal.ponderado_cents += recorrenteMensal.ponderado_cents;
  alvo.bruto_cents += unico.bruto_cents;
  alvo.ponderado_cents += unico.ponderado_cents;
  alvo.n += 1;
}

/** ISO 4217 em caixa alta; sem moeda declarada o funil é BRL, como o resto da tela. */
function moedaDe(lead: LeadDaPrevisao): string {
  const bruta = (lead.currency ?? "").trim().toUpperCase();
  return bruta || "BRL";
}

function dentroDe0a100(valor: number | null | undefined): number | null {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) return null;
  return Math.max(0, Math.min(100, Math.round(valor)));
}

/**
 * Centavos que uma coluna de valor pode somar.
 *
 * Coluna nula soma zero (negócio sem valor é estado legítimo), e valor negativo
 * ou não-finito entra como zero em vez de DIMINUIR a projeção — a mesma régua
 * de `lib/metrics/valores-do-periodo.ts`, para o passado e o futuro da mesma
 * carteira não se lerem por dois critérios.
 */
function centavos(valor: number | null | undefined): number {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return 0;
  return Math.max(0, Math.round(valor));
}

/**
 * A recorrência de UM negócio, separada no que esta projeção soma e no que ela
 * reporta à parte.
 *
 * `mensal` é a parcela `recorrente_mensal` do balde. Periodicidade ausente é
 * mensal (regra 2 da fatia 1: o default é do produto, não do formulário) — e
 * periodicidade que este build NÃO conhece não é somada como se fosse mensal:
 * inventaria um número. Ela vai para `foraDoMes` e continua visível em
 * `recorrencia_nao_mensal`, com o valor real.
 *
 * A duração (`recurring_months`) NÃO multiplica nada aqui: a previsão é do mês
 * em que o negócio fecha, não do contrato inteiro. "Valor do contrato =
 * único + mensalidade × meses" seria outro número, de outro recorte.
 */
function recorrenciaDoLead(lead: LeadDaPrevisao): { mensal: number; foraDoMes: number } {
  const valor = centavos(lead.recurring_value_cents);
  if (valor === 0) return { mensal: 0, foraDoMes: 0 };
  const periodicidade = (lead.recurring_period ?? "").trim() || PERIODICIDADE_PADRAO;
  return periodicidade === PERIODICIDADE_PADRAO
    ? { mensal: valor, foraDoMes: 0 }
    : { mensal: 0, foraDoMes: valor };
}

/**
 * A probabilidade de UM negócio, em 0–100, ou `null` quando não há calibração.
 *
 * `null` é o caso que o balde "sem probabilidade" existe para mostrar — ele não
 * vira 0 em nenhum ponto desta função.
 */
export function probabilidadeDoLead(
  lead: LeadDaPrevisao,
  etapa: EtapaDaPrevisao | undefined,
  fonte: FonteDeProbabilidade,
): number | null {
  // Sem etapa não há desfecho conhecido (lead órfão ou etapa de outro funil).
  if (!etapa) return null;
  // Ganho e perda são estrutura, não calibração: 100 e 0 implícitos, sem gravar.
  if (etapa.is_won) return 100;
  if (etapa.is_lost) return 0;
  if (fonte === "ia_quando_houver") {
    const daIa = dentroDe0a100(lead.ai_probability);
    if (daIa !== null) return daIa;
  }
  return dentroDe0a100(etapa.win_probability);
}

function acumular(baldes: Map<string, Balde>, moeda: string): Balde {
  const existente = baldes.get(moeda);
  if (existente) return existente;
  const novo = baldeVazio(moeda);
  baldes.set(moeda, novo);
  return novo;
}

const DATA_VALIDA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A previsão de um funil: negócios ABERTOS agrupados por moeda × mês.
 *
 * Ordem das saídas dentro de `meses`: moeda, depois mês crescente — é a ordem
 * que a tela lê e a única estável (o Map preserva a ordem de inserção, mas a
 * ordenação explícita não depende da ordem de chegada dos leads).
 *
 * Todo balde (mês, total, "sem data", "sem probabilidade") traz as duas
 * parcelas de cada negócio: `unico` e `recorrente_mensal`. A recorrência que
 * não é mensal não entra em nenhuma delas — sai em `recorrencia_nao_mensal`,
 * com valor, para não sumir.
 */
export function previsao(
  leadsAbertos: readonly LeadDaPrevisao[],
  etapas: readonly EtapaDaPrevisao[],
  opcoes: { fonte: FonteDeProbabilidade },
): Previsao {
  const fonte = opcoes.fonte === "ia_quando_houver" ? "ia_quando_houver" : "etapa";
  const porId = new Map(etapas.map((e) => [e.id, e]));

  const meses = new Map<string, FaixaDeMes>();
  const totais = new Map<string, Balde>();
  const semData = new Map<string, Balde>();
  const semProbabilidade = new Map<string, Balde>();
  const recorrenciaNaoMensal = new Map<string, RecorrenciaForaDoMes>();

  for (const lead of leadsAbertos) {
    if (lead.status !== "open") continue;

    const moeda = moedaDe(lead);
    const bruto = Math.max(0, lead.value_cents ?? 0);
    const { mensal, foraDoMes } = recorrenciaDoLead(lead);
    const prob = probabilidadeDoLead(
      lead,
      lead.stage_id ? porId.get(lead.stage_id) : undefined,
      fonte,
    );

    // RECORRÊNCIA QUE A PROJEÇÃO MENSAL NÃO SOMA: reportada com o valor, antes
    // de qualquer `continue`, para não sumir com o negócio que a carrega. Sem
    // probabilidade ela entra com ponderado 0 — o mesmo critério do balde
    // "sem probabilidade", de que este negócio também faz parte.
    if (foraDoMes > 0) {
      const baldeFora = recorrenciaNaoMensal.get(moeda) ?? {
        moeda,
        bruto_cents: 0,
        ponderado_cents: 0,
        n: 0,
      };
      baldeFora.bruto_cents += foraDoMes;
      baldeFora.ponderado_cents += prob === null ? 0 : Math.round((foraDoMes * prob) / 100);
      baldeFora.n += 1;
      recorrenciaNaoMensal.set(moeda, baldeFora);
    }

    // SEM PROBABILIDADE: não pesa e não some. Vem antes da data de propósito —
    // um negócio sem probabilidade e sem data é incerto nos DOIS eixos, e
    // contá-lo duas vezes sugeriria que são problemas separados.
    if (prob === null) {
      somar(
        acumular(semProbabilidade, moeda),
        { bruto_cents: bruto, ponderado_cents: 0 },
        { bruto_cents: mensal, ponderado_cents: 0 },
      );
      continue;
    }

    // AS DUAS PARCELAS, e a MESMA probabilidade nas duas: o que muda entre elas
    // é o que o cliente paga de uma vez e o que ele passa a pagar todo mês, não
    // o quanto se acredita no fechamento.
    const unico = { bruto_cents: bruto, ponderado_cents: Math.round((bruto * prob) / 100) };
    const recorrenteMensal = {
      bruto_cents: mensal,
      ponderado_cents: Math.round((mensal * prob) / 100),
    };

    somar(acumular(totais, moeda), unico, recorrenteMensal);

    const data = lead.expected_close_date;
    if (!data || !DATA_VALIDA.test(data)) {
      somar(acumular(semData, moeda), unico, recorrenteMensal);
      continue;
    }

    const mes = data.slice(0, 7);
    const chave = `${moeda}::${mes}`;
    const faixa = meses.get(chave) ?? { ...baldeVazio(moeda), mes };
    somar(faixa, unico, recorrenteMensal);
    meses.set(chave, faixa);
  }

  // Baldes de moedas diferentes nunca se misturam: a ordem é a da moeda, e a
  // genérica serve aos `Balde` e às `RecorrenciaForaDoMes`.
  const ordenar = <T extends { moeda: string }>(a: T, b: T) => a.moeda.localeCompare(b.moeda);

  return {
    fonte,
    meses: [...meses.values()].sort(
      (a, b) => ordenar(a, b) || a.mes.localeCompare(b.mes),
    ),
    totais: [...totais.values()].sort(ordenar),
    sem_data: [...semData.values()].sort(ordenar),
    sem_probabilidade: [...semProbabilidade.values()].sort(ordenar),
    recorrencia_nao_mensal: [...recorrenciaNaoMensal.values()].sort(ordenar),
  };
}

/**
 * A fonte declarada no funil, com o padrão quando não há nada declarado.
 *
 * Valor torto vira o padrão, não erro: `settings` é jsonb escrito por várias
 * superfícies e uma configuração corrompida não pode derrubar a leitura do
 * funil inteiro.
 */
export function fontePrevisao(settings: unknown): FonteDeProbabilidade {
  const previsaoSettings =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>).previsao
      : undefined;
  const fonte =
    typeof previsaoSettings === "object" && previsaoSettings !== null
      ? (previsaoSettings as Record<string, unknown>).fonte
      : undefined;
  return fonte === "ia_quando_houver" ? "ia_quando_houver" : FONTE_PADRAO;
}

/**
 * Carrega e calcula a previsão de UM funil.
 *
 * ⚠️ O CLIENTE É O QUE O CHAMADOR PASSAR. Na rota REST ele é o de SESSÃO, e
 * isso é o que faz valer `visibility_mode = "own"` (migration 0036): um
 * cliente admin furaria o isolamento e devolveria a previsão dos outros
 * atendentes. Este módulo não escolhe o cliente — só o usa, com o filtro
 * explícito de organização por convenção do repo.
 *
 * Lança `ApiError(404)` quando o funil não é desta organização — mesma resposta
 * de um funil inexistente, porque dizer "existe, mas não é seu" já vaza.
 */
export async function carregarPrevisao(
  supabase: SupabaseClient,
  entrada: { organizationId: string; pipelineId: string; requestId: string },
): Promise<Previsao & { pipeline_id: string }> {
  const { organizationId, pipelineId, requestId } = entrada;

  const { data: funil, error: funilErr } = await supabase
    .from("crm_pipelines")
    .select("id, settings")
    .eq("id", pipelineId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (funilErr) throw new Error(funilErr.message);
  if (!funil) throw new ApiError(404, "not_found", undefined, requestId, "Funil não encontrado.");

  const fonte = fontePrevisao(funil.settings);

  const [etapasRes, leadsRes, scoresRes] = await Promise.all([
    supabase
      .from("crm_stages")
      .select("id, name, is_won, is_lost, win_probability")
      .eq("organization_id", organizationId)
      .eq("pipeline_id", pipelineId)
      .eq("is_archived", false)
      .order("position", { ascending: true }),
    supabase
      .from("crm_leads")
      .select(
        "id, stage_id, status, value_cents, currency, expected_close_date, " +
          "recurring_value_cents, recurring_period, recurring_months",
      )
      .eq("organization_id", organizationId)
      .eq("pipeline_id", pipelineId)
      .eq("status", "open")
      .order("position_in_stage", { ascending: true }),
    fonte === "ia_quando_houver"
      ? supabase
          .from("crm_lead_scores")
          .select("lead_id, ai_probability")
          .eq("organization_id", organizationId)
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (etapasRes.error) throw new Error(etapasRes.error.message);
  if (leadsRes.error) throw new Error(leadsRes.error.message);
  if (scoresRes.error) throw new Error(scoresRes.error.message);

  const probabilidadesDaIa = new Map<string, number | null>();
  for (const linha of (scoresRes.data ?? []) as Array<{
    lead_id: string;
    ai_probability: number | null;
  }>) {
    probabilidadesDaIa.set(linha.lead_id, linha.ai_probability);
  }

  const etapas = (etapasRes.data ?? []) as unknown as EtapaDaPrevisao[];
  const leads = ((leadsRes.data ?? []) as unknown as LeadDaPrevisao[]).map((l) => ({
    ...l,
    ai_probability: probabilidadesDaIa.get(l.id) ?? null,
  }));

  return { pipeline_id: funil.id, ...previsao(leads, etapas, { fonte }) };
}
