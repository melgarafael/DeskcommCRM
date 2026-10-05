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
 * Devolve `{ id, is_blocked }`: o bloqueio viaja junto porque a recusa da
 * ligação decide pelo `is_blocked` positivo. O nome pra exibir é
 * decisão de tela (`rotuloDoContato`, lido direto de `contacts` via join em
 * `GET /api/v1/calls`), não deste resolvedor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { encontrarContatoPorTelefoneComBloqueio } from "@/lib/channels/contato-por-telefone";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";

/** Quem ligou, com o bloqueio lido na mesma consulta que resolveu o contato. */
export interface ContatoDaChamada {
  id: string;
  /** Só `true` positivo recusa (fail-open: `false`/`null` segue como hoje). */
  is_blocked: boolean;
}

/**
 * Acha o contato pelo número, ou cria um novo se não existir nenhum.
 *
 * `admin` é o client de service-role (RLS não filtra aqui — o worker de voz
 * não tem sessão de usuário) — quem chama já resolveu qual organização.
 *
 * Devolve `{ id, is_blocked }`: `is_blocked` vem NA MESMA consulta do lookup
 * (sem consulta extra); contato criado na hora nasce com `is_blocked` falso
 * (default da coluna). `null` em falha ou número inválido — o caminho `null`
 * (contato desconhecido) nunca recusa.
 */
export async function resolveOrCreateCallerContact(
  admin: SupabaseClient,
  orgId: string,
  rawPhone: string,
): Promise<ContatoDaChamada | null> {
  const canonico = canonicalPhoneBR(rawPhone);
  if (!canonico || canonico === "unknown") return null;

  const existente = await encontrarContatoPorTelefoneComBloqueio(admin, orgId, canonico);
  if (existente) return { id: existente.id, is_blocked: existente.is_blocked === true };

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

  if (!error && data) return { id: data.id as string, is_blocked: false };

  // Corrida: outra chamada (ou mensagem WhatsApp do mesmo número) criou o
  // contato entre o lookup e este insert — uniq_contacts_org_phone reprova
  // com 23505, e o lookup de novo acha quem venceu a corrida.
  if (error?.code === "23505") {
    const depois = await encontrarContatoPorTelefoneComBloqueio(admin, orgId, canonico);
    if (depois) return { id: depois.id, is_blocked: depois.is_blocked === true };
  }
  return null;
}
