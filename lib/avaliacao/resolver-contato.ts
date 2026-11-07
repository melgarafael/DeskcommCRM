import type { SupabaseClient } from "@supabase/supabase-js";

import { encontrarContatoPorTelefone, encontrarContatoPorTelefoneComNome } from "@/lib/channels/contato-por-telefone";
import { normalizePhoneBR } from "@/lib/channels/phone-variants";

export async function resolverContatoParaAgendamento(
  supabase: SupabaseClient,
  orgId: string,
  entrada: { contact_id?: string; client_name?: string; client_phone?: string; client_email?: string },
): Promise<{ contact_id: string; created: boolean }> {
  if (entrada.contact_id) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("id", entrada.contact_id)
      .maybeSingle();
    if (!data?.id) throw new Error("contact_not_found");
    return { contact_id: data.id, created: false };
  }

  const phone = entrada.client_phone ? normalizePhoneBR(entrada.client_phone) : null;
  if (!phone || !entrada.client_name?.trim()) throw new Error("client_required");

  const existente = await encontrarContatoPorTelefone(supabase, orgId, entrada.client_phone!);
  if (existente) {
    return { contact_id: existente.id, created: false };
  }

  const { data, error } = await supabase
    .from("contacts")
    .insert({
      organization_id: orgId,
      name: entrada.client_name.trim(),
      phone_number: phone,
      email: entrada.client_email?.trim() || null,
    })
    .select("id")
    .single();

  if (error) throw error;
  return { contact_id: data.id, created: true };
}

export async function buscarContatoPorTelefoneParaApi(
  admin: SupabaseClient,
  orgId: string,
  rawPhone: string,
) {
  return encontrarContatoPorTelefoneComNome(admin, orgId, rawPhone);
}
