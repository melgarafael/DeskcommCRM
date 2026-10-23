/**
 * A REMARCAÇÃO E O CANCELAMENTO QUE CHEGAM PELO GOOGLE AGENDA viram evento.
 *
 * ## O que faltava
 *
 * Quando alguém muda pelo Google um compromisso que nasceu no CRM, a
 * sincronização aplica a mudança (`fn_google_appointment`, ação `commit` com
 * `apply_remote`) e grava a linha na timeline do lead — e só. Nenhum
 * `appointment.rescheduled` nem `appointment.cancelled` era emitido, então
 * quem escuta esses eventos (o aviso de agendamento no WhatsApp, as regras de
 * automação, os webhooks) não sabia que o horário tinha mudado. É exatamente o
 * caso que o aviso existe para pegar: a agenda mexida FORA do CRM.
 *
 * ## Por que aqui, e não dentro da função do banco
 *
 * `fn_google_appointment` tem quatro definições no baseline e cerca de 12 KB;
 * redefini-la inteira para acrescentar um INSERT trocaria um efeito pequeno por
 * um risco grande. O executor já tem o antes e o depois na mão, e emitir por
 * `emit_event` é o caminho de evento de domínio do produto.
 *
 * ## O tipo do gatilho sai de `gatilhoDaTransicao`
 *
 * Nunca de um literal: é a fonte única dos gatilhos da agenda
 * (`lib/automation/gatilhos-em-uma-fonte.test.ts`).
 *
 * ## Nunca lança
 *
 * A mudança já foi gravada no banco. Falhar em AVISAR não pode desfazer nem
 * repetir a sincronização — vira log, como no laço da rota da agenda.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { payloadDoAviso } from "@/lib/agenda/aviso-do-compromisso";
import { gatilhoDaTransicao, type SituacaoAnterior } from "@/lib/agenda/laco";
import { ENTIDADE_DO_AGENDAMENTO } from "@/lib/agenda/tipos";
import { logger } from "@/lib/logger";

/** O recorte do compromisso que decide a notícia. */
export interface EstadoDoCompromisso {
  id: string;
  contact_id: string | null;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  status: string;
  location_kind?: string | null;
}

/**
 * A mudança aplicada vinda do Google, como transição da agenda — ou `null`
 * quando nada que importe a quem escuta mudou.
 */
export function transicaoVindaDoGoogle(
  antes: EstadoDoCompromisso,
  depois: EstadoDoCompromisso,
): "rescheduled" | "cancelled" | null {
  // `apply_remote` só aceita compromisso vivo; o resto é defesa.
  if (antes.status !== "pending" && antes.status !== "confirmed") return null;
  if (depois.status === "cancelled") return "cancelled";
  const mesmoInstante = (a: string, b: string) => Date.parse(a) === Date.parse(b);
  if (!mesmoInstante(antes.starts_at, depois.starts_at) || !mesmoInstante(antes.ends_at, depois.ends_at)) {
    return "rescheduled";
  }
  return null;
}

export async function emitirMudancaVindaDoGoogle(
  db: SupabaseClient,
  organizationId: string,
  antes: EstadoDoCompromisso,
  depois: EstadoDoCompromisso,
): Promise<void> {
  const transicao = transicaoVindaDoGoogle(antes, depois);
  if (!transicao) return;
  const gatilho = gatilhoDaTransicao(antes.status as SituacaoAnterior, transicao);
  if (!gatilho) return;

  try {
    // O tipo e os negócios ligados, lidos do banco como faz a rota da agenda:
    // `event_type_name` é contrato que as condições de regra já leem.
    // ⚠️ `organization_id` filtrado À MÃO: o client é o de service role.
    const { data: linha } = await db
      .from("calendar_appointments")
      .select("event_type_id, title")
      .eq("organization_id", organizationId)
      .eq("id", depois.id)
      .maybeSingle();
    const eventTypeId = (linha as { event_type_id?: string | null } | null)?.event_type_id ?? null;
    const titulo = (linha as { title?: string | null } | null)?.title ?? "";
    const { data: tipo } = eventTypeId
      ? await db
          .from("calendar_event_types")
          .select("slug, name")
          .eq("organization_id", organizationId)
          .eq("id", eventTypeId)
          .maybeSingle()
      : { data: null };
    const { data: links } = await db
      .from("crm_lead_links")
      .select("lead_id")
      .eq("organization_id", organizationId)
      .eq("target_kind", "appointment")
      .eq("target_id", depois.id);

    const { error } = await db.rpc("emit_event", {
      p_organization_id: organizationId,
      p_event_type: gatilho,
      p_entity_kind: ENTIDADE_DO_AGENDAMENTO,
      p_entity_id: depois.id,
      p_payload: payloadDoAviso({
        appointmentId: depois.id,
        contactId: depois.contact_id,
        transicao,
        fuso: depois.time_zone,
        nomeDoTipo: (tipo as { name?: string } | null)?.name ?? titulo,
        compromisso: {
          starts_at: depois.starts_at,
          ends_at: depois.ends_at,
          status: depois.status,
          location_kind: depois.location_kind ?? null,
          event_type_id: eventTypeId,
        },
        tipo: (tipo as { slug?: string; name?: string } | null) ?? null,
        leadIds: ((links ?? []) as Array<{ lead_id: string }>).map((l) => l.lead_id),
        autor: "google",
      }),
      p_metadata: { origem: "google_sync" },
    } as never);
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.error("[agenda-google] mudança vinda do Google não virou evento", {
      organization_id: organizationId,
      appointment_id: depois.id,
      gatilho,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
