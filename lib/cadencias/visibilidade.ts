/**
 * A sessão enxerga este negócio? Lido pelo client da SESSÃO: a RLS de
 * `crm_leads` (`fn_can_view_lead`) decide, como nas rotas de negócio. As rotas
 * de inscrição escrevem com service_role, então perguntam aqui antes.
 */
import { createClient } from "@/lib/supabase/server";

export async function negocioVisivel(orgId: string, leadId: string): Promise<boolean | "erro"> {
  const sessao = await createClient();
  const { data, error } = await sessao.from("crm_leads").select("id").eq("organization_id", orgId).eq("id", leadId).maybeSingle();
  if (error) return "erro";
  return data !== null;
}
