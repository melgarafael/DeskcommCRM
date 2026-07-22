/**
 * Gate de gatilho AUTOMÁTICO de follow-up (Task 7.2).
 *
 * Regra (spec 2026-07-21, seletor no agente): um gatilho AUTOMÁTICO
 * (silence/stage_change/conversation_end — `TriggerConfig.kind` em
 * `api-schemas.ts`) só pode criar um enrollment para um pointer se algum
 * agente PUBLICADO (`ai_agent_versions.status='published'`) da mesma org tem
 * `followup.enabled=true` e `followup.flow_pointer_ids` inclui esse pointer.
 * Enrollment MANUAL (`POST /api/v1/ai/followups/enrollments`) NÃO passa por
 * este gate — é escolha explícita de um humano, ortogonal ao vínculo do
 * agente.
 *
 * Nenhum consumidor chama isto ainda: a Onda 6/7 só entrega enrollment manual
 * (`app/api/v1/ai/followups/enrollments/route.ts`) e o worker de tick
 * (`lib/followup/engine.ts` avança enrollments já existentes, não CRIA a
 * partir de um gatilho automático). A Onda 8 (Task 8.1, silence/stage →
 * enrollment) é quem PRECISA chamar `isPointerEnabledForAutomaticTrigger`
 * antes de inserir a linha em `followup_enrollments` — documentado no
 * HANDOFF. Exportado + testado agora pra não nascer morto quando a Onda 8
 * plugar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Interface estreita de DB — mesma doutrina de `AdminClient`/`ReactivityAdminClient`
 *  (narrow por consumidor, não `SupabaseClient` direto, pra ficar testável sem Postgres). */
export interface FollowupGateDb {
  /** IDs de pointer habilitados por pelo menos 1 versão PUBLICADA da org. */
  loadEnabledPublishedFollowupPointerIds(orgId: string): Promise<string[]>;
}

interface FollowupColumnShape {
  enabled?: unknown;
  flow_pointer_ids?: unknown;
}

/** Gate puro: dado o conjunto (já carregado) de pointers habilitados, decide. */
export async function isPointerEnabledForAutomaticTrigger(
  db: FollowupGateDb,
  orgId: string,
  pointerId: string,
): Promise<boolean> {
  const enabledIds = await db.loadEnabledPublishedFollowupPointerIds(orgId);
  return enabledIds.includes(pointerId);
}

/** Production adapter: lê `ai_agent_versions.followup` via o client service-role real. */
export function createSupabaseFollowupGateDb(admin: SupabaseClient): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupPointerIds(orgId) {
      const { data, error } = await admin
        .from("ai_agent_versions")
        .select("followup")
        .eq("organization_id", orgId)
        .eq("status", "published");
      if (error) throw new Error(`followup_gate_query_failed: ${error.message}`);

      const ids = new Set<string>();
      for (const row of (data ?? []) as Array<{ followup: FollowupColumnShape | null }>) {
        const f = row.followup;
        if (!f || f.enabled !== true || !Array.isArray(f.flow_pointer_ids)) continue;
        for (const id of f.flow_pointer_ids) {
          if (typeof id === "string") ids.add(id);
        }
      }
      return [...ids];
    },
  };
}
