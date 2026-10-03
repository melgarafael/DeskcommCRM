/**
 * O consumidor das conversões de ETAPA do Google Ads.
 *
 * Nasceu (0402) para UMA etapa de qualificação, configurada na própria conexão.
 * Desde a 0436 lê `google_ads_conversion_rules`: cada etapa do funil pode ter a
 * sua ação de conversão, e o evento no livro-razão é o `event_name` da regra —
 * `QualifiedLead` para a qualificação migrada, `Etapa:<uuid>` para as novas.
 *
 * As travas de sempre continuam aqui, e em ordem:
 *  - o que já foi enviado não sai de novo (sair e voltar à etapa não duplica);
 *  - movimento anterior à regra não envia (`configured_at`, a trava de
 *    retroatividade: ligar uma regra não despeja o histórico no Google);
 *  - a etapa precisa ser desta organização e estar aberta (ganho é compra, e é
 *    do consumidor de venda);
 *  - o canal de entrada do negócio precisa atender o filtro da regra.
 *
 * O reenvio (`ad_conversion.retry_requested`) usa o RETRATO gravado no primeiro
 * envio — quando aconteceu e qual ação —, nunca a regra de agora: mudar a regra
 * depois não pode redirecionar uma conversão antiga para outra ação.
 */
import { z } from "zod";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import type { NomeDoEvento } from "@/lib/plataformas-de-anuncio/types";
import { processarConversao } from "./envio.handler";
import { lerRegistro } from "./registro-de-envio";
import { canalAtende, canalDoLead, ehEventoDeEtapa, lerRegraDaEtapa } from "./regras-google";

const KEY = "conversoes.qualificacao";
const ignorar = (detail: string): HandlerResult => ({
  consumer_key: KEY,
  status: "skipped",
  detail,
});

async function enviar(
  row: EventRow,
  evento: string,
  ocorridoEm: string,
  googleActionId: string,
): Promise<HandlerResult> {
  const resultado = await processarConversao(row, {
    ocorridoEm,
    googleActionId,
    evento: evento as NomeDoEvento,
  });
  return { ...resultado, consumer_key: KEY };
}

async function handle(row: EventRow): Promise<HandlerResult> {
  if (!row.entity_id) return ignorar("sem_entidade");
  const admin = createAdminClient();
  try {
    if (row.event_type === "ad_conversion.retry_requested") {
      const evento = row.payload.event_name;
      if (!ehEventoDeEtapa(evento)) return ignorar("outro_evento");
      const registro = await lerRegistro(
        admin,
        row.organization_id,
        row.entity_id,
        evento as NomeDoEvento,
      );
      if (registro?.status === "sent") return ignorar("ja_enviada");
      if (!registro?.event_occurred_at || !registro.google_action_id)
        return ignorar("sem_qualificacao_registrada");
      return await enviar(row, evento, registro.event_occurred_at, registro.google_action_id);
    }

    if (row.event_type !== "lead.stage_changed") return ignorar("outro_evento");
    const etapaId = z.uuid().safeParse(row.payload.to_stage_id);
    if (!etapaId.success || !row.created_at || !Number.isFinite(Date.parse(row.created_at)))
      return ignorar("sem_etapa_ou_data");

    const regra = await lerRegraDaEtapa(admin, row.organization_id, etapaId.data);
    if (!regra || !regra.enabled) return ignorar("etapa_sem_qualificacao");

    const registro = await lerRegistro(
      admin,
      row.organization_id,
      row.entity_id,
      regra.eventName as NomeDoEvento,
    );
    if (registro?.status === "sent") return ignorar("ja_enviada");
    if (registro?.event_occurred_at && registro.google_action_id)
      return await enviar(
        row,
        regra.eventName,
        registro.event_occurred_at,
        registro.google_action_id,
      );

    if (Date.parse(row.created_at) < Date.parse(regra.configuredAt))
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

    if (regra.channel !== "todos") {
      const canal = await canalDoLead(admin, row.organization_id, row.entity_id);
      if (!canalAtende(regra.channel, canal)) return ignorar("canal_fora_da_regra");
    }

    return await enviar(row, regra.eventName, row.created_at, regra.googleActionId);
  } catch {
    return {
      consumer_key: KEY,
      status: "retry",
      retry_at: new Date(Date.now() + 300_000).toISOString(),
      detail: "Não foi possível processar a conversão da etapa. Nova tentativa agendada.",
    };
  }
}

export const conversaoDeQualificacaoHandler: EventHandler = {
  key: KEY,
  naOrgParada: "pula",
  events: ["lead.stage_changed", "ad_conversion.retry_requested"],
  handle,
};
