// lib/propostas/aviso-de-revisao.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { logger } from "@/lib/logger";
import { montarDocumentoDaProposta, type PropostaParaDocumento } from "./documento/documento-da-proposta";
import type { ContatoParaDocumento } from "./documento/montar-dados";

/**
 * Consumido por `lib/propostas/aviso-no-whatsapp.handler.ts` — o aviso no
 * WhatsApp da equipe que pode revisar. O push ao celular NÃO vem por aqui: ele
 * nasce no barramento da Central (`central.aviso_criado`, migration 0442) e sai
 * por `lib/notifications/push-dos-avisos.ts`. O literal está repetido dentro do
 * `.insert` abaixo de propósito: é lá que a cerca de eventos o lê.
 */
export const EVENTO_PROPOSTA_PRONTA_PARA_REVISAO = "proposal.ready_for_review";

const TITULO_MAXIMO = 80;

export function tituloDoAviso(titulo: string | null, cliente: string | null): string {
  const nome = (titulo ?? "").trim().slice(0, TITULO_MAXIMO) || "sem título";
  return cliente ? `Proposta «${nome}» de ${cliente} está pronta para revisão` : `Proposta «${nome}» está pronta para revisão`;
}

async function contatoDaProposta(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string | null,
): Promise<ContatoParaDocumento | null> {
  if (!contactId) return null;
  const { data } = await supabase
    .from("contacts")
    .select("name, display_name")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  return (data as ContatoParaDocumento | null) ?? null;
}

/**
 * Abre o aviso "proposta pronta para revisão" na Central quando a IA
 * rascunha — e, SÓ quando abre um item novo, emite o evento que o aviso no
 * WhatsApp consome. O push ao celular é outro caminho: nasce do
 * `central.aviso_criado` que o trigger da Central emite (0442), não deste
 * evento. Fire-and-forget: nada aqui derruba o rascunho.
 */
export async function avisarQuePropostaPrecisaDeRevisao(
  supabase: SupabaseClient,
  organizationId: string,
  propostaId: string,
): Promise<void> {
  try {
    const { data: existente } = await supabase
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", "proposta_pronta_para_revisao")
      .eq("ref_id", propostaId)
      .eq("status", "open")
      .maybeSingle();
    if (existente) return;

    const { data: linha } = await supabase
      .from("crm_proposals")
      .select("titulo, lead_id, contact_id")
      .eq("organization_id", organizationId)
      .eq("id", propostaId)
      .maybeSingle();
    const proposta = linha as { titulo: string | null; lead_id: string | null; contact_id: string | null } | null;
    const cliente = nomeDoContato(await contatoDaProposta(supabase, organizationId, proposta?.contact_id ?? null));

    const { error } = await supabase.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: "proposta_pronta_para_revisao",
      severity: "warn",
      title: tituloDoAviso(proposta?.titulo ?? null, cliente),
      body: "A IA rascunhou esta proposta. Confirme o modelo, preencha o que falta no documento e confira os preços antes de enviar.",
      ref_kind: "proposal",
      ref_id: propostaId,
      status: "open",
    });
    if (error) {
      logger.error("[aviso-de-revisao] falha ao abrir aviso na Central", { error: error.message, propostaId });
      return;
    }

    const { error: erroDoEvento } = await supabase.from("event_log").insert({
      organization_id: organizationId,
      event_type: "proposal.ready_for_review",
      entity_kind: "proposal",
      entity_id: propostaId,
      payload: { proposal_id: propostaId, lead_id: proposta?.lead_id ?? null },
    });
    if (erroDoEvento) {
      logger.warn("[aviso-de-revisao] aviso aberto, mas o evento de notificação não foi gravado", {
        error: erroDoEvento.message,
        propostaId,
      });
    }
  } catch (e) {
    logger.error("[aviso-de-revisao] falha inesperada ao abrir aviso", { error: String(e), propostaId });
  }
}

/**
 * Fecha o aviso quando a proposta está DE FATO pronta — modelo confirmado,
 * preço definido e zero pendência no documento (P4A) — ou, com
 * `forcar: true`, incondicionalmente (enviada ou descartada).
 */
export async function resolverAvisoDeRevisaoSeProntaOuEncerrada(
  supabase: SupabaseClient,
  organizationId: string,
  propostaId: string,
  opts: { forcar?: boolean } = {},
): Promise<void> {
  try {
    if (!opts.forcar) {
      const { data } = await supabase
        .from("crm_proposals")
        .select(
          "template_slug, lead_id, pricing_status, secoes_editadas, briefing_json, total_cents, moeda, prazo_dias_uteis, valid_until, created_at, contact_id",
        )
        .eq("organization_id", organizationId)
        .eq("id", propostaId)
        .maybeSingle();
      const proposta = data as (PropostaParaDocumento & { pricing_status: string; contact_id: string | null }) | null;
      if (!proposta || proposta.template_slug === null || proposta.pricing_status === "missing") return;

      const contato = await contatoDaProposta(supabase, organizationId, proposta.contact_id);
      const documento = await montarDocumentoDaProposta(supabase, organizationId, proposta, contato);
      if (!documento || documento.camposFaltando.length > 0) return;
    }

    const { error } = await supabase
      .from("agent_inbox_items")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("organization_id", organizationId)
      .eq("kind", "proposta_pronta_para_revisao")
      .eq("ref_id", propostaId)
      .eq("status", "open");
    if (error) {
      logger.error("[aviso-de-revisao] falha ao resolver aviso na Central", { error: error.message, propostaId });
    }
  } catch (e) {
    logger.error("[aviso-de-revisao] falha inesperada ao resolver aviso", { error: String(e), propostaId });
  }
}
