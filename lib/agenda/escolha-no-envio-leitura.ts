import type { SupabaseClient } from "@supabase/supabase-js";

import { followupPublicadoDoEnrollment } from "@/lib/agent-engine/agent/janela-de-followup";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { followupPublicadoSupabase } from "@/lib/followup/janela-de-disparo";
import { logger } from "@/lib/logger";

import { ESCOLHA_PADRAO, lerEscolhaNoEnvio, type EscolhaNoEnvio } from "./escolha-no-envio";

/**
 * A LEITURA da escolha de envio (#3813) — separada do vocabulário de propósito.
 *
 * `lib/agenda/escolha-no-envio.ts` é importado por SCHEMAS (a validação da regra
 * e a do follow-up publicado), que rodam no caminho de save; trazer para lá a
 * leitura do banco arrastaria o motor de follow-up inteiro para dentro de uma
 * validação de payload. Aqui moram só as duas leituras — Supabase e `pg` — do
 * MESMO campo.
 *
 * ═══ Onde a escolha do FLUXO mora ═══
 *
 * Em `ai_agent_versions.followup.quando_ha_compromisso`, ao lado de
 * `send_window`: as duas são regras de ENVIO proativo do follow-up, e a mesma
 * configuração publicada já é lida pelos dois caminhos (o inline de
 * `enviar-texto-fixo.ts` e o turno do worker). Duas casas para a mesma pergunta
 * divergem no dia em que só uma for atualizada.
 */

/**
 * A escolha do fluxo de follow-up, da configuração publicada do agente pinado
 * no enrollment.
 *
 * Falha de leitura NÃO derruba o envio: cai no padrão (`adiar`), que é o
 * comportamento de hoje. O contrário — estourar — deixaria um campo de
 * preferência derrubar um fluxo inteiro; e o padrão é justamente o lado seguro.
 */
export async function escolhaDoFluxo(
  admin: SupabaseClient,
  organizationId: string,
  enrollmentId: string,
): Promise<EscolhaNoEnvio> {
  try {
    const followup = await followupPublicadoSupabase(admin, organizationId, enrollmentId);
    return lerEscolhaNoEnvio(followup);
  } catch (err) {
    logger.warn("[agenda] escolha do follow-up não lida; vale o padrão (adiar)", {
      organization_id: organizationId,
      enrollment_id: enrollmentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return ESCOLHA_PADRAO;
  }
}

/** A MESMA leitura do lado `pg` (o turno do worker fala `pg`, não PostgREST). */
export async function escolhaDoFluxoPg(
  db: Queryable,
  organizationId: string,
  enrollmentId: string,
): Promise<EscolhaNoEnvio> {
  try {
    const followup = await followupPublicadoDoEnrollment(db, organizationId, enrollmentId);
    return lerEscolhaNoEnvio(followup);
  } catch (err) {
    logger.warn("[agenda] escolha do follow-up não lida (pg); vale o padrão (adiar)", {
      organization_id: organizationId,
      enrollment_id: enrollmentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return ESCOLHA_PADRAO;
  }
}
