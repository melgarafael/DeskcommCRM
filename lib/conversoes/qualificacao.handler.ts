import { z } from "zod";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { processarConversao } from "./envio.handler";
import { lerRegistro } from "./registro-de-envio";

const KEY = "conversoes.qualificacao";
const ignorar = (detail: string): HandlerResult => ({
  consumer_key: KEY,
  status: "skipped",
  detail,
});

async function handle(row: EventRow): Promise<HandlerResult> {
  if (!row.entity_id) return ignorar("sem_entidade");
  if (
    row.event_type === "ad_conversion.retry_requested" &&
    row.payload.event_name !== "QualifiedLead"
  )
    return ignorar("outro_evento");
  const admin = createAdminClient();
  try {
    const registro = await lerRegistro(admin, row.organization_id, row.entity_id, "QualifiedLead");
    if (registro?.status === "sent") return ignorar("ja_enviada");
    let ocorridoEm = registro?.event_occurred_at;
    let googleActionId = registro?.google_action_id;
    if (!ocorridoEm || !googleActionId) {
      if (row.event_type !== "lead.stage_changed") return ignorar("sem_qualificacao_registrada");
      const etapaId = z.uuid().safeParse(row.payload.to_stage_id);
      if (!etapaId.success || !row.created_at || !Number.isFinite(Date.parse(row.created_at)))
        return ignorar("sem_etapa_ou_data");
      const { data: config, error } = await admin
        .from("ad_platform_connections")
        .select(
          "google_qualification_stage_id, google_qualification_action_id, google_qualification_configured_at",
        )
        .eq("organization_id", row.organization_id)
        .eq("platform", "google_ads")
        .maybeSingle();
      if (error) throw error;
      if (
        !config ||
        config.google_qualification_stage_id !== etapaId.data ||
        !config.google_qualification_action_id
      )
        return ignorar("etapa_sem_qualificacao");
      if (
        !config.google_qualification_configured_at ||
        Date.parse(row.created_at) < Date.parse(config.google_qualification_configured_at)
      )
        return ignorar("anterior_a_configuracao");
      const { data: etapa, error: erroEtapa } = await admin
        .from("crm_stages")
        .select("id")
        .eq("organization_id", row.organization_id)
        .eq("id", etapaId.data)
        .eq("is_won", false)
        .eq("is_lost", false)
        .maybeSingle();
      if (erroEtapa) throw erroEtapa;
      if (!etapa) return ignorar("etapa_invalida");
      ocorridoEm = row.created_at;
      googleActionId = config.google_qualification_action_id as string;
    }
    const resultado = await processarConversao(row, { ocorridoEm, googleActionId });
    return { ...resultado, consumer_key: KEY };
  } catch {
    return {
      consumer_key: KEY,
      status: "retry",
      retry_at: new Date(Date.now() + 300_000).toISOString(),
      detail: "Não foi possível processar a qualificação. Nova tentativa agendada.",
    };
  }
}

export const conversaoDeQualificacaoHandler: EventHandler = {
  key: KEY,
  events: ["lead.stage_changed", "ad_conversion.retry_requested"],
  handle,
};
