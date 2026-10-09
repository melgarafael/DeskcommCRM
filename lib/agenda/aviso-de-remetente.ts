import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import type { MotivoSemRemetente } from "./remetente-do-lembrete";

export const REF_REMETENTE_LEMBRETE = "agenda_reminder_sender";
const explicacoes: Record<MotivoSemRemetente, string> = {
  remetente_ambiguo: "Há mais de um canal disponível e a reserva não indica qual usar.",
  sem_canal: "Não há canal de mensagem disponível.",
  canal_indicado_indisponivel:
    "O canal indicado está desconectado, pausado, arquivado ou não pode enviar mensagens.",
  conversa_do_compromisso_invalida:
    "A conversa da reserva não corresponde a este contato e organização, ou está sem canal.",
  canal_fora_da_janela_24h:
    "O canal indicado não pode enviar texto livre fora da janela de atendimento.",
  falha_ao_ler_remetente:
    "Não foi possível consultar o canal da reserva. A próxima rodada tentará novamente.",
};

/** Um item por reserva, inclusive com dois crons concorrentes (índice parcial). */
export async function atualizarAvisoDeRemetente(
  admin: SupabaseClient,
  org: string,
  compromissoId: string,
  motivo: MotivoSemRemetente | null,
): Promise<void> {
  try {
    const filtro = () =>
      admin
        .from("agent_inbox_items")
        .select("id")
        .eq("organization_id", org)
        .eq("ref_kind", REF_REMETENTE_LEMBRETE)
        .eq("ref_id", compromissoId)
        .eq("status", "open");
    if (!motivo) {
      const { error } = await admin
        .from("agent_inbox_items")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("organization_id", org)
        .eq("ref_kind", REF_REMETENTE_LEMBRETE)
        .eq("ref_id", compromissoId)
        .eq("status", "open");
      if (error) throw error;
      return;
    }
    const { data, error: leitura } = await filtro().maybeSingle();
    if (leitura) throw leitura;
    const body = `${explicacoes[motivo]} O lembrete não foi enviado nem marcado como enviado. Confira a reserva na Agenda e o canal em Configurações → Tipos de agendamento. Corrigido dentro do prazo, a próxima rodada tenta enviar; avisos vencidos não são reenviados.`;
    const valores = { title: "Lembrete aguardando definição do canal", body };
    const { error } = data
      ? await admin
          .from("agent_inbox_items")
          .update(valores)
          .eq("id", data.id)
          .eq("organization_id", org)
          .eq("status", "open")
      : await admin.from("agent_inbox_items").insert({
          ...valores,
          organization_id: org,
          kind: "other",
          severity: "warn",
          ref_kind: REF_REMETENTE_LEMBRETE,
          ref_id: compromissoId,
          status: "open",
        });
    if (error && error.code !== "23505") throw error;
  } catch (error) {
    logger.error("[agenda-reminder] falha ao atualizar aviso de remetente", {
      organizationId: org,
      appointmentId: compromissoId,
      error: String(error),
    });
  }
}
