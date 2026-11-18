import type { SupabaseClient } from "@supabase/supabase-js";

export interface ContatoAutorizadoDoTeste {
  id: string;
  name: string | null;
  phone_number: string | null;
}

/** A identidade é resolvida no servidor; a amostra não autoriza dados cadastrais. */
export async function resolverContatoDoTeste(
  db: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<ContatoAutorizadoDoTeste | null> {
  const { data, error } = await db
    .from("contacts")
    .select("id,name,phone_number,is_blocked,is_anonymized,kind")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (error || !data || data.is_blocked || data.is_anonymized || data.kind === "whatsapp_group")
    return null;
  return { id: data.id, name: data.name, phone_number: data.phone_number };
}
