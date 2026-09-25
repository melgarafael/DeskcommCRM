/**
 * Identificador de ligações — quem está do outro lado de uma chamada, pelo
 * número. Reaproveita `encontrarContatoPorTelefone` (a mesma busca
 * anti-duplicação do WhatsApp: variantes com/sem nono dígito, contato
 * fundido nunca é alvo) em vez de reimplementar o lookup.
 *
 * Contato NOVO nasce com `source: "voip"` — nunca via `fn_upsert_wa_contact`,
 * que grava `source: "whatsapp"` e exige identidade de canal (wa_identity)
 * que uma chamada não tem.
 *
 * Devolve só o `contact_id`: o nome pra exibir é decisão de tela
 * (`rotuloDoContato`, lido direto de `contacts` via join em
 * `GET /api/v1/calls`), não deste resolvedor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";

/**
 * Acha o contato pelo número, ou cria um novo se não existir nenhum.
 *
 * `admin` é o client de service-role (RLS não filtra aqui — o worker de voz
 * não tem sessão de usuário) — quem chama já resolveu qual organização.
 */
export async function resolveOrCreateCallerContact(
  admin: SupabaseClient,
  orgId: string,
  rawPhone: string,
): Promise<string | null> {
  const canonico = canonicalPhoneBR(rawPhone);
  if (!canonico || canonico === "unknown") return null;

  const existente = await encontrarContatoPorTelefone(admin, orgId, canonico);
  if (existente) return existente.id;

  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: orgId,
      phone_number: canonico,
      source: "voip",
      source_metadata: { origem: "chamada_recebida" },
    })
    .select("id")
    .single();

  if (!error && data) return data.id as string;

  // Corrida: outra chamada (ou mensagem WhatsApp do mesmo número) criou o
  // contato entre o lookup e este insert — uniq_contacts_org_phone reprova
  // com 23505, e o lookup de novo acha quem venceu a corrida.
  if (error?.code === "23505") {
    const depois = await encontrarContatoPorTelefone(admin, orgId, canonico);
    if (depois) return depois.id;
  }
  return null;
}
