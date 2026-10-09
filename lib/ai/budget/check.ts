/**
 * O estado do orçamento de IA, como a TELA o lê.
 *
 * ═══ O NÚMERO EXIBIDO É O NÚMERO QUE DECIDE ═══
 *
 * Este arquivo lia `ai_budgets.current_month_consumed_cents` — um contador
 * materializado pelo gatilho `fn_update_budget_consumption`, que soma
 * `NEW.cost_cents` **sem olhar a data** e nunca zera (o `runBudgetReset` jamais
 * foi agendado e acabou apagado com o resto do código morto de orçamento; o
 * único recomputo em produção é o apêndice da 0140, que só roda
 * no `install.sh`/`update.sh`). Numa instalação que não atualiza há três meses,
 * o card comparava três meses de gasto contra um teto MENSAL.
 *
 * Enquanto o teto não vinculava nada, isso era um número feio numa tela. A
 * partir da 0159 ele decide se a IA para de responder — e pedir que alguém arme
 * uma proteção contra um número que não é o número que decide é pedir que ela se
 * proteja de uma mentira. Então a leitura passa pela régua ÚNICA,
 * `public.fn_gasto_de_ia_do_mes`, a mesma que o gate chama dentro de
 * `SQL_ORCAMENTO`.
 *
 * DEGRADAÇÃO DECLARADA: se a RPC falhar — o caso concreto é o clone cujo
 * `update.sh` (que roda **sem** `ON_ERROR_STOP`) engoliu o apêndice e não tem a
 * função —, a leitura cai para a coluna materializada e LOGA a causa. É um
 * número pior, mas é exatamente o de ontem; um erro na tela de Uso não é.
 *
 * Usa o admin client porque quem chama já resolveu a organização de fonte
 * confiável (JWT via `requireRole`, ou a sessão do Server Component). Nunca
 * derive a org do body.
 */
import {
  LIMIAR_PADRAO_PCT,
  normalizarChaveDeOrcamento,
  normalizarModoDeOrcamento,
  type ChaveDeOrcamento,
  type ModoDeOrcamento,
} from "@/lib/agent-engine/edge/llm/orcamento";
import { PONTO_TRANSCRICAO_DE_AUDIO } from "@/lib/ai/pontos/registro";
import { ORIGENS_DA_TRANSCRICAO_POR_SERVICO } from "@/lib/messaging/media/transcription";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { carregarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";

export interface BudgetStatus {
  organization_id: string;
  /** Centavo de DÓLAR — `llm_calls.cost_cents` vem de `pricing.ts`, que calcula em USD. */
  monthly_limit_cents: number;
  /** Idem. Vem de `fn_gasto_de_ia_do_mes`, a mesma régua que o gate usa. */
  current_month_consumed_cents: number;
  pct: number;
  alarm_threshold_pct: number;
  /** O que a organização escolheu que acontece ao chegar no teto. */
  enforcement_mode: ModoDeOrcamento;
  /**
   * Quando a parada começa a valer. `null` = não está armada — nunca esteve, ou
   * foi desarmada (o PATCH zera a coluna ao sair de `bloquear`, senão a carência
   * ficaria pré-gasta e o próximo armar valeria no ato).
   */
  enforcement_effective_at: string | null;
  /**
   * Há chamadas de IA NESTE MÊS cujo custo o produto não sabe calcular
   * (`llm_calls.cost_cents is null` numa linha `ok` que não é de transcrição
   * pelo serviço, degraus 1 e 2 — o porquê das duas exclusões está na
   * consulta, em `getBudgetStatus`).
   *
   * ⚠️ É O FURO DEBAIXO DA PROTEÇÃO INTEIRA, e por isso ele é um campo do
   * contrato e não uma nota num doc. `pricing.ts` casa o `model` por id EXATO
   * (tolerando o sufixo de data e o prefixo `provider/`, #1929) e devolve `null`
   * para modelo fora da tabela — id da OpenRouter como `z-ai/glm-4.7` segue sem
   * preço. A régua trata custo nulo
   * como zero (`coalesce`), então nessas instalações o gasto medido é MENOR que
   * o real — no limite, zero: o teto nunca dispara e o card mostra "US$ 0,00
   * gastos" enquanto o dinheiro sai.
   *
   * O conserto de raiz é o motor consultar `ai_models` (onde o catálogo da
   * OpenRouter já grava preço real — `lib/ai/cost.ts`), e é item próprio. No
   * intervalo, a tela não pode PROMETER uma parada que não vai acontecer: este
   * campo é o que ela usa para dizer a verdade ao lado da opção.
   */
  gasto_incompleto: boolean;
  /**
   * O valor EFETIVO da chave de orçamento desta INSTALAÇÃO, já normalizado: a
   * linha de `platform_settings` escrita na tela de admin (`/admin/sistema`)
   * acima, o `.env` como piso. A tela precisa dele para não oferecer uma
   * proteção que o operador desligou: um controle que o processo ignora é pior
   * que controle nenhum — e era o defeito da issue #1034.
   */
  enforcement_env: ChaveDeOrcamento;
  /**
   * Há um `budget_exceeded` ABERTO na Central — o único produtor real de "a IA
   * está parada por gasto" (`aplicarOrcamento`, em `run-model-call.ts`).
   *
   * Não é recalculado a partir dos números daqui de propósito: repetir as
   * condições de `decidirOrcamento` na tela criaria uma segunda decisão, e a
   * segunda decisão sempre diverge da que age. Os badges antigos liam
   * `is_throttled`/`is_disabled`, que têm leitor e nenhum escritor vivo — o card
   * ficava em SILÊNCIO justamente enquanto o gate recusava.
   */
  blocked_now: boolean;
  current_period_start: string;
  last_alarm_sent_at: string | null;
  updated_at: string;
}

const COLUMNS =
  "organization_id, monthly_limit_cents, current_month_consumed_cents, alarm_threshold_pct, enforcement_mode, enforcement_effective_at, current_period_start, last_alarm_sent_at, updated_at";

const DEFAULTS = {
  // Organização sem linha em `ai_budgets` cai em "sem teto", nunca em "teto
  // zero" — 0 é ausência de limite em toda a feature (ver `decidirOrcamento`).
  monthly_limit_cents: 0,
  current_month_consumed_cents: 0,
  alarm_threshold_pct: LIMIAR_PADRAO_PCT,
};

function pctOf(consumed: number, limit: number): number {
  if (!limit || limit <= 0) return 0;
  return Math.round((consumed * 10000) / limit) / 100;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * O primeiro instante do mês corrente, em UTC — a MESMA janela de
 * `fn_gasto_de_ia_do_mes` (`date_trunc('month', now())`). Só divergem se o banco
 * não estiver em UTC, e só nas primeiras horas da virada do mês.
 */
function inicioDoMesUtc(): string {
  const hoje = new Date();
  return new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1)).toISOString();
}

/**
 * O gasto do mês pela régua única. `cents: null` = a régua não respondeu, e
 * `causa` diz por quê — um campo e não um par booleano+string, porque dois
 * campos que só fazem sentido juntos são dois campos que podem discordar.
 */
async function gastoDoMes(
  admin: AdminClient,
  orgId: string,
): Promise<{ cents: number | null; causa: string | null }> {
  const { data, error } = await admin.rpc("fn_gasto_de_ia_do_mes", { p_org: orgId });
  if (error) return { cents: null, causa: error.message };
  // `numeric` pode chegar como string dependendo do serializador; coagir sempre.
  const n = Number(data ?? 0);
  if (!Number.isFinite(n)) return { cents: null, causa: `retorno não numérico: ${String(data)}` };
  return { cents: n, causa: null };
}

/** Snapshot completo para a tela / API. Nunca lança: degrada para o default. */
export async function getBudgetStatus(orgId: string): Promise<BudgetStatus> {
  const admin = createAdminClient();
  // O valor EFETIVO da chave (issue #1034): lê a linha da instalação ANTES de
  // montar o snapshot, para o card não oferecer uma proteção que a tela de
  // admin desligou — nem esconder uma que ela ligou. Nunca lança: sem leitura
  // boa, cai no piso do `.env`, que é exatamente o comportamento de ontem.
  const instalacao = await carregarComportamentoDaInstalacao();
  const enforcementEnv = instalacao.orcamento_de_ia;

  const [linhaRes, gasto, bloqueioRes, semPrecoRes] = await Promise.all([
    admin.from("ai_budgets").select(COLUMNS).eq("organization_id", orgId).maybeSingle(),
    gastoDoMes(admin, orgId),
    admin
      .from("agent_inbox_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("kind", "budget_exceeded")
      // Só o orçamento da ORG e o legado sem referência: a mesma régua do
      // retratarAvisos de app/api/v1/ai/budget/route.ts. O aviso do teto do
      // PLANO (ref_kind='plano') não é deste card nem se destrava por ele.
      .or("ref_kind.is.null,ref_kind.eq.ai_budget")
      .eq("status", "open"),
    // O furo de medição, medido onde ele aparece: chamada do mês sem custo
    // conhecido. `idx_llm_calls_org_time (organization_id, created_at)` serve o
    // filtro; `head: true` não traz linha nenhuma.
    //
    // Duas linhas têm `cost_cents` nulo sem que o modelo seja desconhecido, e o
    // aviso diria a quem lê que é: a de FALHA (o provedor recusou, zero token
    // cobrado) e a de transcrição pelo SERVIÇO (degraus 1 e 2 da escada), que
    // tem preço próprio e não devolve tokens — toda instalação de WhatsApp que
    // recebe um áudio acenderia o aviso. O degrau 3 da mesma escada é o modelo
    // de conversa, cobrado por token: sem preço na tabela, ele É o furo, e
    // excluir o `purpose` inteiro o apagava. Por isso o corte é pela origem
    // gravada na linha; transcrição sem origem conta (na dúvida, avisa).
    admin
      .from("llm_calls")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .is("cost_cents", null)
      .eq("status", "ok")
      .or(
        `purpose.neq.${PONTO_TRANSCRICAO_DE_AUDIO},origem_da_escolha.is.null,` +
          `origem_da_escolha.not.in.(${ORIGENS_DA_TRANSCRICAO_POR_SERVICO.join(",")})`,
      )
      .gte("created_at", inicioDoMesUtc()),
  ]);

  const data = linhaRes.data;
  const blockedNow = (bloqueioRes.count ?? 0) > 0;
  // Degrada para "medição completa" quando a consulta falha: afirmar um furo que
  // não se mediu assusta quem está protegido de verdade. O erro é logado abaixo.
  const gastoIncompleto = (semPrecoRes.count ?? 0) > 0;

  // As três leituras degradam para o lado frouxo (sem teto, modo off, sem
  // parada) — mas NUNCA em silêncio: um card que diz "sem limite" porque a
  // consulta falhou é indistinguível de um que diz a verdade, e é sobre ele que
  // a pessoa decide se está protegida.
  if (linhaRes.error) {
    logger.warn("ai-budget: leitura do orçamento falhou — a tela mostra o default", {
      organization_id: orgId,
      causa: linhaRes.error.message,
    });
  }
  if (bloqueioRes.error) {
    logger.warn("ai-budget: não deu para saber se há parada aberta — a tela dirá que não", {
      organization_id: orgId,
      causa: bloqueioRes.error.message,
    });
  }
  if (gasto.causa !== null) {
    logger.warn("ai-budget: gasto do mês veio da coluna materializada, não da régua", {
      organization_id: orgId,
      causa: gasto.causa,
    });
  }
  if (semPrecoRes.error) {
    logger.warn("ai-budget: não deu para saber se há chamada sem preço conhecido no mês", {
      organization_id: orgId,
      causa: semPrecoRes.error.message,
    });
  }

  if (!data) {
    const periodStart = inicioDoMesUtc().slice(0, 10);
    // Sem linha não há coluna materializada para onde cair: a régua ou responde,
    // ou o gasto conhecido é zero — que é a verdade, já que o gatilho de
    // `llm_calls` cria a linha na primeira chamada paga.
    const consumido = gasto.cents ?? DEFAULTS.current_month_consumed_cents;
    return {
      organization_id: orgId,
      monthly_limit_cents: DEFAULTS.monthly_limit_cents,
      current_month_consumed_cents: consumido,
      pct: 0,
      alarm_threshold_pct: DEFAULTS.alarm_threshold_pct,
      enforcement_mode: "off",
      enforcement_effective_at: null,
      enforcement_env: enforcementEnv,
      blocked_now: blockedNow,
      gasto_incompleto: gastoIncompleto,
      current_period_start: periodStart,
      last_alarm_sent_at: null,
      updated_at: new Date().toISOString(),
    };
  }

  const monthlyLimit = Number(data.monthly_limit_cents ?? 0);
  const consumed = gasto.cents ?? Number(data.current_month_consumed_cents ?? 0);

  return {
    organization_id: data.organization_id,
    monthly_limit_cents: monthlyLimit,
    current_month_consumed_cents: consumed,
    pct: pctOf(consumed, monthlyLimit),
    alarm_threshold_pct: Number(data.alarm_threshold_pct ?? DEFAULTS.alarm_threshold_pct),
    enforcement_mode: normalizarModoDeOrcamento(data.enforcement_mode as string | null),
    enforcement_effective_at: (data.enforcement_effective_at as string | null) ?? null,
    enforcement_env: enforcementEnv,
    blocked_now: blockedNow,
    gasto_incompleto: gastoIncompleto,
    current_period_start: String(data.current_period_start),
    last_alarm_sent_at: (data.last_alarm_sent_at as string | null) ?? null,
    updated_at: String(data.updated_at),
  };
}
