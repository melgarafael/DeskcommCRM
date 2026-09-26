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
  /** De `crm_lead_scores`, quando a fonte é `ia_quando_houver`. 0–100. */
  ai_probability?: number | null;
}

/** Um recorte por moeda: o valor bruto, o ponderado e quantos negócios. */
export interface Balde {
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
}

const baldeVazio = (moeda: string): Balde => ({
  moeda,
  bruto_cents: 0,
  ponderado_cents: 0,
  n: 0,
});

function somar(alvo: Balde, bruto: number, ponderado: number): void {
  alvo.bruto_cents += bruto;
  alvo.ponderado_cents += ponderado;
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

  for (const lead of leadsAbertos) {
    if (lead.status !== "open") continue;

    const moeda = moedaDe(lead);
    const bruto = Math.max(0, lead.value_cents ?? 0);
    const prob = probabilidadeDoLead(
      lead,
      lead.stage_id ? porId.get(lead.stage_id) : undefined,
      fonte,
    );

    // SEM PROBABILIDADE: não pesa e não some. Vem antes da data de propósito —
    // um negócio sem probabilidade e sem data é incerto nos DOIS eixos, e
    // contá-lo duas vezes sugeriria que são problemas separados.
    if (prob === null) {
      somar(acumular(semProbabilidade, moeda), bruto, 0);
      continue;
    }

    const ponderado = Math.round((bruto * prob) / 100);
    somar(acumular(totais, moeda), bruto, ponderado);

    const data = lead.expected_close_date;
    if (!data || !DATA_VALIDA.test(data)) {
      somar(acumular(semData, moeda), bruto, ponderado);
      continue;
    }

    const mes = data.slice(0, 7);
    const chave = `${moeda}::${mes}`;
    const faixa = meses.get(chave) ?? { ...baldeVazio(moeda), mes };
    somar(faixa, bruto, ponderado);
    meses.set(chave, faixa);
  }

  const ordenar = (a: Balde, b: Balde) => a.moeda.localeCompare(b.moeda);

  return {
    fonte,
    meses: [...meses.values()].sort(
      (a, b) => ordenar(a, b) || a.mes.localeCompare(b.mes),
    ),
    totais: [...totais.values()].sort(ordenar),
    sem_data: [...semData.values()].sort(ordenar),
    sem_probabilidade: [...semProbabilidade.values()].sort(ordenar),
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
      .select("id, stage_id, status, value_cents, currency, expected_close_date")
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
