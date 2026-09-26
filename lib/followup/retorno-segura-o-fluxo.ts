/**
 * O RETORNO AGENDADO SEGURA O FLUXO DE SILÊNCIO.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * Medido numa instalação real (25/09/2026): a cliente disse "só recebo o
 * salário no dia 30", o agente agendou o retorno para o dia 30 com
 * `schedule_followup` e respondeu "te escrevo no dia 30, sem pressa". Uma hora
 * depois, o fluxo de silêncio — que não sabia de retorno nenhum — voltou a
 * escrever pedindo os dados de entrega; no dia seguinte repetiria a oferta que
 * ela já tinha aceitado, e dois dias depois a "última oportunidade". O sistema
 * desmentia, sozinho, a promessa que ele mesmo tinha feito.
 *
 * ─── A regra ───────────────────────────────────────────────────────────────
 *
 * Com um retorno VIVO para o contato, o fluxo de silêncio não fala por cima:
 *   - a varredura não inscreve o contato (`contatosComRetornoVivo`);
 *   - a inscrição que já estava andando fica segurada até `FOLGA_DEPOIS_DO_RETORNO_MS`
 *     depois do retorno (`quandoDoRetornoVivo` + `reavaliarDepoisDoRetorno`).
 *     Se o cliente responder ao retorno, o `cancel_on_reply` do fluxo o encerra
 *     como sempre; se não responder, o fluxo retoma de onde estava.
 *
 * Só o gatilho de SILÊNCIO: é ele que insiste com quem parou de falar, e é ele
 * que contradiz "te escrevo no dia 30". Fluxo por etapa ou por caso responde a um
 * FATO novo (o pedido foi confirmado, o caso foi aberto) e não deve esperar.
 *
 * ─── O que conta como retorno ──────────────────────────────────────────────
 *
 * Uma linha de `cron_jobs` `kind='at'`, `job_kind='followup_turn'`, agendada
 * (`enabled`, sem `cancelled_at` — ver `situacaoDoRetorno` em `retorno.ts`) e que
 * NÃO é o turno de um passo de fluxo. O motor de fluxo enfileira os próprios
 * passos na mesma tabela e no mesmo `job_kind`, com `followup_enrollment_id` no
 * payload; contá-los faria cada fluxo segurar a si mesmo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Quanto o fluxo espera DEPOIS do retorno antes de retomar. Um dia: o tempo de a
 * pessoa ler e responder ao que foi prometido. Menos que isso, o fluxo emendaria
 * uma mensagem na outra no mesmo dia — o bombardeio que a regra existe para evitar.
 */
export const FOLGA_DEPOIS_DO_RETORNO_MS = 24 * 3_600_000;

export function reavaliarDepoisDoRetorno(quandoDoRetorno: string): string {
  return new Date(Date.parse(quandoDoRetorno) + FOLGA_DEPOIS_DO_RETORNO_MS).toISOString();
}

function retornosVivos(admin: SupabaseClient, orgId: string) {
  return admin
    .from("cron_jobs")
    .select("contact_id, next_run_at")
    .eq("organization_id", orgId)
    .eq("kind", "at")
    .eq("job_kind", "followup_turn")
    .eq("enabled", true)
    .is("cancelled_at", null)
    .is("payload->>followup_enrollment_id", null);
}

/** Contatos da organização com retorno vivo — a varredura de silêncio os pula. */
export async function contatosComRetornoVivo(admin: SupabaseClient, orgId: string): Promise<Set<string>> {
  const { data, error } = await retornosVivos(admin, orgId);
  if (error) throw new Error(`retorno_vivo_query_failed: ${error.message}`);
  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ contact_id: string | null }>) {
    if (row.contact_id) ids.add(row.contact_id);
  }
  return ids;
}

/**
 * Quando dispara o retorno vivo MAIS TARDIO do contato, ou `null` sem retorno.
 * O mais tardio porque é depois dele que o fluxo pode voltar a falar.
 */
export async function quandoDoRetornoVivo(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<string | null> {
  const { data, error } = await retornosVivos(admin, orgId)
    .eq("contact_id", contactId)
    .order("next_run_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`retorno_vivo_query_failed: ${error.message}`);
  const row = (data ?? [])[0] as { next_run_at: string } | undefined;
  return row?.next_run_at ?? null;
}
