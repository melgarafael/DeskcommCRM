/**
 * O VÍNCULO DE QUEM VAI RECEBER — a régua única de "esta pessoa pode ser dona?".
 *
 * ─── Por que ele é um arquivo, e não uma função local ─────────────────────
 *
 * A régua nasceu dentro da ação `assign_owner` (#3822) e é a MESMA da doutrina
 * G3-04: responsável tem que ser atendente ATIVO da organização (membro não
 * revogado) e não pode ser `viewer`, que só lê. O item 3 da #3804 passou a
 * entregar a conversa ao responsável/dono da carteira no handoff da IA, e a
 * pergunta "essa pessoa pode receber?" é idêntica — se cada lado tivesse a sua
 * cópia, a primeira correção (um papel novo, um `accepted_at` que passa a
 * valer) faria um dos dois entregar a conversa a quem não atende.
 *
 * ─── A consulta tem TRÊS respostas, não duas ──────────────────────────────
 *
 * É membro; não é membro (`user_not_in_org` / `invalid_owner`); e não deu para
 * saber — a consulta falhou (`indeterminado`, com a mensagem para o suporte).
 * As duas últimas não se confundem: dizer "não é membro" quando a
 * infraestrutura caiu manda o operador mexer no que está certo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** O desfecho da conferência: serve, não serve (e por quê), ou não deu para saber. */
export type VinculoDoDestino =
  | { ok: true }
  | { ok: false; motivo: "user_not_in_org" | "invalid_owner" }
  | { ok: false; indeterminado: string };

/**
 * Confere o vínculo de `userId` com a organização. `admin` é service-role: o
 * `organization_id` aqui é do chamador (nunca de argumento de fora), e os dois
 * `.eq` são obrigatórios porque RLS não segura esta leitura.
 */
export async function conferirVinculoDoDestino(
  admin: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<VinculoDoDestino> {
  const { data: member, error: erroDaConsulta } = await admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (erroDaConsulta) {
    // A consulta também pode NÃO VOLTAR (rede, banco fora). Falha fechada na
    // ação, aberta na informação — código transitório e a mensagem do erro.
    return { ok: false, indeterminado: erroDaConsulta.message };
  }
  if (!member) return { ok: false, motivo: "user_not_in_org" };
  if ((member as { role?: string | null }).role === "viewer") {
    // Mesma régua do bulk-assign (G3-04 invalid_owner): viewer não atende.
    return { ok: false, motivo: "invalid_owner" };
  }
  return { ok: true };
}
