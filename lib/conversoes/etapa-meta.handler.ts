/**
 * O consumidor das conversões de ETAPA da Meta (migration 0524).
 *
 * O par de `qualificacao.handler.ts`, que faz o mesmo para o Google: quando um
 * negócio entra numa etapa com regra da Meta ligada, o evento padrão escolhido
 * (`InitiateCheckout`, `LeadSubmitted`…) vai ao conjunto de dados da Meta — só
 * para quem veio de anúncio da Meta, pelo clique-para-WhatsApp ou pela página
 * com UTM da Meta (`leitura-da-atribuicao.ts`).
 *
 * As travas são as mesmas do Google, e na mesma ordem:
 *  - o que já foi enviado não sai de novo (sair e voltar à etapa não duplica);
 *  - movimento anterior à regra não envia (`configured_at`: ligar uma regra
 *    não despeja o histórico do funil na Meta);
 *  - a etapa precisa ser desta organização e estar aberta (ganho é a compra, e
 *    é do consumidor de venda; perda não é conversão).
 *
 * O reenvio (`ad_conversion.retry_requested`) usa o RETRATO gravado no primeiro
 * envio — quando aconteceu e qual evento —, nunca a regra de agora.
 */
import { z } from "zod";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { processarConversao } from "./envio.handler";
import { lerRegistro } from "./registro-de-envio";
import { ehEventoDeEtapaMeta, lerRegraMetaDaEtapa } from "./regras-meta";

const KEY = "conversoes.etapa_meta";
const ignorar = (detail: string): HandlerResult => ({
  consumer_key: KEY,
  status: "skipped",
  detail,
});

async function enviar(
  row: EventRow,
  evento: `MetaEtapa:${string}`,
  ocorridoEm: string,
  eventoMeta: string,
): Promise<HandlerResult> {
  const resultado = await processarConversao(row, { ocorridoEm, evento, eventoMeta });
  return { ...resultado, consumer_key: KEY };
}

async function handle(row: EventRow): Promise<HandlerResult> {
  if (!row.entity_id) return ignorar("sem_entidade");
  const admin = createAdminClient();
  try {
    if (row.event_type === "ad_conversion.retry_requested") {
      const evento = row.payload.event_name;
      if (!ehEventoDeEtapaMeta(evento)) return ignorar("outro_evento");
      const registro = await lerRegistro(admin, row.organization_id, row.entity_id, evento);
      if (registro?.status === "sent") return ignorar("ja_enviada");
      if (!registro?.event_occurred_at || !registro.meta_event_name)
        return ignorar("sem_etapa_registrada");
      return await enviar(row, evento, registro.event_occurred_at, registro.meta_event_name);
    }

    if (row.event_type !== "lead.stage_changed") return ignorar("outro_evento");
    const etapaId = z.uuid().safeParse(row.payload.to_stage_id);
    if (!etapaId.success || !row.created_at || !Number.isFinite(Date.parse(row.created_at)))
      return ignorar("sem_etapa_ou_data");

    const regra = await lerRegraMetaDaEtapa(admin, row.organization_id, etapaId.data);
    if (!regra || !regra.enabled) return ignorar("etapa_sem_regra_meta");
    if (!ehEventoDeEtapaMeta(regra.eventName)) return ignorar("regra_invalida");

    const registro = await lerRegistro(admin, row.organization_id, row.entity_id, regra.eventName);
    if (registro?.status === "sent") return ignorar("ja_enviada");
    if (registro?.event_occurred_at && registro.meta_event_name)
      return await enviar(
        row,
        regra.eventName,
        registro.event_occurred_at,
        registro.meta_event_name,
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

    return await enviar(row, regra.eventName, row.created_at, regra.metaEvent);
  } catch {
    return {
      consumer_key: KEY,
      status: "retry",
      retry_at: new Date(Date.now() + 300_000).toISOString(),
      detail: "Não foi possível processar o evento de etapa da Meta. Nova tentativa agendada.",
    };
  }
}

export const conversaoDeEtapaMetaHandler: EventHandler = {
  key: KEY,
  naOrgParada: "pula",
  events: ["lead.stage_changed", "ad_conversion.retry_requested"],
  handle,
};
