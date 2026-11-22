/**
 * De qual NEGÓCIO é este compromisso — a leitura que acompanha o desfecho (#4515).
 *
 * Mora em módulo próprio, e não no handler da agenda, porque quem responde a
 * pergunta é a ferramenta MCP (`crm_set_appointment_outcome` devolve
 * `negocio`), e não a escrita: assim a tool não passa a depender do arquivo de
 * handler inteiro — que é grande, é mockado por vários testes e é editado por
 * outras frentes ao mesmo tempo.
 *
 * A fonte é o VÍNCULO (`crm_lead_links`), não o negócio ativo do contato: a
 * pergunta é "de qual negócio é ESTE horário", e o vínculo é justamente o que o
 * dossiê usa para listar o compromisso. `organization_id` vai em toda query
 * porque, pelo MCP, o client é service-role e a RLS não vale: sem o filtro, um
 * id de outra empresa responderia.
 *
 * Lista vazia é RESPOSTA (compromisso de contato que ainda não virou negócio),
 * nunca erro — e por isso o `.in` só roda com ids de verdade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ALVO_DE_VINCULO_DO_AGENDAMENTO } from "@/lib/agenda/tipos";

export async function negociosDoCompromisso(
  supabase: SupabaseClient,
  organizationId: string,
  appointmentId: string,
): Promise<Array<{ id: string; titulo: string }>> {
  const { data: vinculos } = await supabase
    .from("crm_lead_links")
    .select("lead_id")
    .eq("organization_id", organizationId)
    .eq("target_kind", ALVO_DE_VINCULO_DO_AGENDAMENTO)
    .eq("target_id", appointmentId);

  const ids = (Array.isArray(vinculos) ? vinculos : [])
    .map((linha) => (linha as { lead_id?: unknown }).lead_id)
    .filter((id): id is string => typeof id === "string" && !!id);
  if (ids.length === 0) return [];

  const { data: leads } = await supabase
    .from("crm_leads")
    .select("id, title")
    .eq("organization_id", organizationId)
    .in("id", ids);

  return (Array.isArray(leads) ? leads : []).map((linha) => {
    const lead = linha as { id: string; title?: string | null };
    return { id: lead.id, titulo: lead.title?.trim() || lead.id };
  });
}
