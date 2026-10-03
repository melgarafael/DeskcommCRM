/**
 * Pure trigger predicates for the 4 handoff gates (EPIC-06 wave 3).
 *
 *   G1 — checkG1(body)               — usuário pede humano (regex PT-BR).
 *   G3 — checkG3({ confidence, ... }) — bot inseguro. É **OU**, não "+": qualquer um
 *        dos dois sinais basta (similaridade medida abaixo do limiar, OU marcador de
 *        incerteza no texto). O "+" que este cabeçalho dizia até 2026-09-20 descrevia um
 *        gate mais conservador do que o que roda, e quem lesse daqui para decidir se o
 *        gate é agressivo concluiria o contrário. O código está certo — dois sinais
 *        independentes de insegurança, e exigir os dois juntos deixaria passar o texto
 *        que se declara inseguro apoiado em material de boa similaridade.
 *   G4 — checkG4Legal(body)          — termos jurídicos no inbound.
 *   G4 — checkG4Stage(leadId, org)   — lead está em stage `requires_human=true`.
 *
 * (G2 = low sentiment é consumido por `ai-handoff-from-sentiment.handler.ts`,
 *  já dispara via evento `ai.sentiment_alert` emitido pelo sentiment worker.)
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import {
  G1_REGEX,
  G4_LEGAL_REGEX,
  containsUncertaintyMarkers,
} from "@/lib/ai/handoff/regex";

export function checkG1(body: string): boolean {
  if (!body) return false;
  return G1_REGEX.test(body);
}

export function checkG4Legal(body: string): boolean {
  if (!body) return false;
  return G4_LEGAL_REGEX.test(body);
}

/**
 * A PREFERÊNCIA DA ORGANIZAÇÃO sobre o G4 jurídico — `organizations.settings.handoff.g4_juridico`.
 *
 * Guardada em `organizations.settings` (jsonb) porque é o mecanismo que o repo
 * JÁ usa por organização (`settings.jev`, `settings.llm`, `settings.proposals`,
 * `settings.routing`, …) — nada de migration nova para um booleano (medido na
 * #2097; ver `lib/ai/decisao/config.ts`, que documenta o mesmo argumento).
 *
 * SÓ o `false` booleano desliga. Ausente, string `"false"`, número, objeto
 * torto ou `settings` que não é objeto = LIGADO: quem não configurou nada
 * continua com exatamente o resultado de hoje, e um valor escrito errado não
 * pode silenciar o gate. É o mesmo "falha fechada" de `capacidadesLigadas`.
 *
 * Pura — não consulta banco; a leitura é `checkG4LegalNaOrganizacao`.
 */
export function g4JuridicoLigado(settings: unknown): boolean {
  const raiz =
    settings !== null && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : null;
  const handoff =
    raiz?.handoff !== null && typeof raiz?.handoff === "object" && !Array.isArray(raiz.handoff)
      ? (raiz.handoff as Record<string, unknown>)
      : null;
  return handoff?.g4_juridico !== false;
}

/**
 * G4 com a preferência da organização (#2097) — é ela quem o worker chama.
 *
 * A ordem das checagens NÃO muda: a mesma gate, o mesmo texto, o mesmo motivo
 * de handoff (`legal_mention`). O que muda é quem decide se ela vale.
 *
 * Duas decisões de desenho, ambas medidas:
 *
 * 1. **O regex roda ANTES do banco.** `G4_LEGAL_REGEX.test` é de custo zero, e
 *    a grande maioria das mensagens não tem vocabulário jurídico — nesses casos
 *    NENHUMA leitura extra acontece, então o custo por mensagem é o de antes.
 * 2. **Não li = ligado.** Erro de banco, linha ausente ou exceção voltam
 *    `true` (o resultado de hoje): uma leitura recusada não pode transformar
 *    "menção a Procon" em resposta automática da IA por acidente — é o lado
 *    conservador da mesma falha fechada de `capacidadesDaOrganizacao`, mas no
 *    sentido inverso porque aqui o estado padrão é o comportamento atual.
 *
 * `db` é passado (e não construído aqui) para o teste unitário poder usar um
 * banco falso; no worker é o `createAdminClient()` de sempre — service role,
 * com o filtro `.eq("id", …)` que já isola a organização.
 */
export async function checkG4LegalNaOrganizacao(
  db: SupabaseClient,
  organizationId: string,
  body: string,
): Promise<boolean> {
  if (!checkG4Legal(body)) return false;
  try {
    const { data, error } = await db
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) return true;
    return g4JuridicoLigado((data as { settings?: unknown } | null)?.settings);
  } catch (err) {
    logger.warn("[handoff] checkG4LegalNaOrganizacao falhou — mantendo o G4 ligado", {
      organization_id: organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

export interface CheckG3Input {
  /**
   * Similaridade do material de RAG que sustentou a resposta, ou `null` quando
   * NÃO HOUVE medição (nenhuma citação recuperada).
   *
   * `null` não é zero: zero afirma "o material é péssimo", e como todo limiar
   * plausível é maior que zero, essa afirmação escalava para humano TODA resposta
   * que não consultou a base — uma saudação respondida perfeitamente inclusive.
   * Mesma regra de `lib/leads/score-writer.ts` ("zero é uma afirmação") e do
   * `nao_avaliado` de `lib/leads/classificacao-inicial.ts`.
   */
  confidence: number | null;
  outputText: string;
  threshold: number;
}

export function checkG3(input: CheckG3Input): boolean {
  // Desestruturado de propósito: o TypeScript não estreita acesso a PROPRIEDADE
  // (`input.confidence`) através de um booleano aliasado, então a versão com
  // `input.confidence` exigia um `as number` — e escape de tipo num arquivo que é
  // o coração do gate é a primeira coisa que alguém copia. Com o const local o
  // estreitamento funciona e o cast some, com a mesma semântica.
  const { confidence } = input;
  const houveMedicao = confidence !== null && Number.isFinite(confidence);
  const lowConfidence = houveMedicao && confidence < input.threshold;
  return lowConfidence || containsUncertaintyMarkers(input.outputText ?? "");
}

/**
 * G4 — verifica se o lead está numa stage configurada como `requires_human=true`.
 * Service-role bypassa RLS → filtro `organization_id` programático obrigatório.
 *
 * Retorna `false` se `leadId` for null ou em qualquer falha (handoff via stage
 * é best-effort — não derruba o pipeline).
 */
export async function checkG4Stage(
  leadId: string | null,
  organizationId: string,
): Promise<boolean> {
  if (!leadId) return false;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("crm_leads")
      .select("id, stage_id, organization_id, crm_stages:stage_id(requires_human, organization_id)")
      .eq("id", leadId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (error || !data) return false;
    type LeadRow = {
      id: string;
      stage_id: string | null;
      organization_id: string;
      crm_stages:
        | { requires_human: boolean | null; organization_id: string }
        | { requires_human: boolean | null; organization_id: string }[]
        | null;
    };
    const row = data as unknown as LeadRow;
    const stage = Array.isArray(row.crm_stages) ? row.crm_stages[0] : row.crm_stages;
    if (!stage) return false;
    if (stage.organization_id !== organizationId) return false;
    return stage.requires_human === true;
  } catch (err) {
    logger.warn("[handoff-orchestrator] checkG4Stage failed", {
      lead_id: leadId,
      organization_id: organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
