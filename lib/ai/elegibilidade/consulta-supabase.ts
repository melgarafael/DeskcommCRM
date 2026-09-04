/**
 * Ler o estado de elegibilidade de uma conversa via `supabase-js` (service role).
 *
 * Espelho de `consulta-pg.ts` para os caminhos que NÃO têm um pool `pg` à mão —
 * o worker legado (`workers/ai-response-worker.ts`), o envio inline de texto fixo
 * do follow-up (`lib/followup/enviar-texto-fixo.ts`), o worker de sentimento e o
 * orquestrador de handoff do lado do CRM. TODOS têm de respeitar o MESMO gate
 * que o drain e o turno do agent-engine: nenhum caminho pode mandar mensagem de
 * IA para uma conversa que uma origem elegível não autorizou.
 *
 * A regra pura (`decidirElegibilidade`) e a normalização
 * (`montarEstadoDeElegibilidade`) são as mesmas dos dois lados — só o transporte
 * muda.
 *
 * ─── Fail-closed ───────────────────────────────────────────────────────────
 *
 * `decidirElegibilidadeDaConversaViaSupabase` DEVOLVE a decisão, ou `null` só
 * quando a conversa não existe. Erro de query VIRA EXCEÇÃO — e cada chamador
 * destes caminhos secundários trata exceção como "não responder" (fail-closed):
 * são caminhos de retaguarda, o caminho robusto é o do agent-engine, e um erro
 * ao ler `contacts.ai_authorized_at` quase sempre é schema pela metade (imagem
 * nova, baseline ainda não aplicado) — exatamente quando NÃO se quer a IA solta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  decidirElegibilidade,
  montarEstadoDeElegibilidade,
  type DecisaoDeElegibilidade,
} from "./gate";

interface ConversaEmbed {
  bot_silenced_until: string | null;
  assignee_kind: string | null;
  contacts: { force_human: boolean | null; ai_authorized_at: string | null } | null;
  channel_sessions: { metadata: Record<string, unknown> | null } | null;
}

/**
 * Roda a query e a regra. `null` = conversa não encontrada. Lança em erro de
 * banco — o chamador (caminho secundário) trata como "não responder".
 */
export async function decidirElegibilidadeDaConversaViaSupabase(
  admin: SupabaseClient,
  input: { organizationId: string; conversationId: string; agora: Date; ttlMs: number },
): Promise<DecisaoDeElegibilidade | null> {
  const { data, error } = await admin
    .from("conversations")
    .select(
      "bot_silenced_until, assignee_kind, contacts:contact_id(force_human, ai_authorized_at), channel_sessions:channel_session_id(metadata)",
    )
    .eq("organization_id", input.organizationId)
    .eq("id", input.conversationId)
    .maybeSingle();

  if (error) {
    throw new Error(`elegibilidade: leitura falhou — ${error.message}`);
  }
  if (data == null) return null;

  const row = data as unknown as ConversaEmbed;
  return decidirElegibilidade(
    montarEstadoDeElegibilidade({
      aiGate: row.channel_sessions?.metadata?.["ai_gate"] ?? null,
      forceHuman: row.contacts?.force_human ?? false,
      assigneeKind: row.assignee_kind,
      botSilencedUntil: row.bot_silenced_until,
      aiAuthorizedAt: row.contacts?.ai_authorized_at ?? null,
      agora: input.agora,
      ttlMs: input.ttlMs,
    }),
  );
}
