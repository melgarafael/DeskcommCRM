/** LeadSubmitted por clique inbound, independente de nascimento de card. */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { ativacaoLeadMeta, leadNasceuAposAtivacao } from "./ativacao-lead-meta";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";
import { transporteDe } from "@/lib/plataformas-de-anuncio/registry";
import { createAdminClient } from "@/lib/supabase/admin";

const KEY = "conversoes.clique_meta";
const ESPERA_MS = 5 * 60 * 1000;
const uuid = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i;

const resultado = (status: HandlerResult["status"], detail: string): HandlerResult => ({
  consumer_key: KEY,
  status,
  detail,
});
const retry = (detail: string): HandlerResult => ({
  ...resultado("retry", detail),
  retry_at: new Date(Date.now() + ESPERA_MS).toISOString(),
});

async function handle(row: EventRow): Promise<HandlerResult> {
  const fromMessage = row.event_type === "message.received";
  const fromRetry = row.event_type === "ad_conversion.click_retry_requested";
  if (!fromMessage && !fromRetry) return resultado("skipped", "outro_evento");
  const messageId = row.payload.message_id;
  const clickId = row.payload.click_id;
  if (
    fromMessage &&
    (row.entity_kind !== "message" ||
      row.entity_id !== messageId ||
      typeof messageId !== "string" ||
      !uuid.test(messageId))
  )
    return resultado("skipped", "sem_mensagem");
  if (
    fromRetry &&
    (row.entity_kind !== "meta_ctwa_click" ||
      typeof clickId !== "string" ||
      !uuid.test(clickId) ||
      row.entity_id !== clickId)
  )
    return resultado("skipped", "sem_clique");

  const admin = createAdminClient();
  try {
    const { data: click, error: clickError } = await admin
      .from("meta_ctwa_click_dispatches")
      .select(
        "id,contact_id,first_message_id,ctwa_clid,captured_at,activation_at_capture,status,event_id",
      )
      .eq("organization_id", row.organization_id)
      .eq(fromMessage ? "first_message_id" : "id", fromMessage ? messageId : clickId)
      .maybeSingle();
    if (clickError) return retry("leitura_do_clique");
    // Mensagem organica ou segunda mensagem do mesmo clique nao tem linha.
    if (!click) return resultado("skipped", fromMessage ? "sem_clique_novo" : "clique_inexistente");
    if (click.status === "sent") return resultado("skipped", "ja_enviada");
    if (
      !click.activation_at_capture ||
      !leadNasceuAposAtivacao(click.activation_at_capture, click.captured_at)
    )
      return resultado("skipped", "lead_submitted_desativado_no_clique");
    if (click.event_id !== `${click.id}:LeadSubmitted`)
      return resultado("error", "identidade_do_clique_invalida");

    const conferirAtivacao = async (): Promise<"liberado" | "desativado" | "indisponivel"> => {
      const { data: org, error } = await admin
        .from("organizations")
        .select("meta_lead_birth_enabled_at")
        .eq("id", row.organization_id)
        .maybeSingle();
      if (error) return "indisponivel";
      const current = (org as { meta_lead_birth_enabled_at?: unknown } | null)
        ?.meta_lead_birth_enabled_at;
      // Igualdade do epoch impede que reativacao recupere clique da ativacao anterior.
      return ativacaoLeadMeta(current) !== null &&
        ativacaoLeadMeta(current) === ativacaoLeadMeta(click.activation_at_capture)
        ? "liberado"
        : "desativado";
    };
    const { data: claim, error: claimError } = await admin.rpc("fn_claim_meta_ctwa_click", {
      p_org: row.organization_id,
      p_click: click.id,
    });
    if (claimError) return retry("claim_indisponivel");
    const posse = claim as { acquired?: boolean; token?: string; status?: string } | null;
    if (!posse?.acquired || !posse.token) {
      if (posse?.status === "busy") return retry("lease_vigente");
      if (posse?.status === "sent") return resultado("skipped", "ja_enviada");
      if (posse?.status === "legacy_sent")
        return resultado("skipped", "lead_submitted_legado_enviado");
      return resultado("error", posse?.status ?? "claim_recusado");
    }

    const concluir = async (
      status: "sent" | "skipped" | "error",
      reason: string | null,
      detail: string | null,
    ): Promise<HandlerResult> => {
      const { data, error } = await admin.rpc("fn_settle_meta_ctwa_click", {
        p_org: row.organization_id,
        p_click: click.id,
        p_token: posse.token,
        p_status: status,
        p_reason: reason,
        p_detail: detail,
      });
      if (error || data !== true) return retry("settlement_indisponivel");
      return resultado(
        status === "sent" ? "ok" : status === "error" ? "error" : "skipped",
        reason ?? "enviado",
      );
    };

    const ativacao = await conferirAtivacao();
    if (ativacao === "indisponivel") {
      const settled = await concluir("skipped", "nova_tentativa_agendada", "leitura_da_ativacao");
      return settled.status === "skipped" ? retry("leitura_da_ativacao") : settled;
    }
    if (ativacao === "desativado")
      return await concluir("skipped", "lead_submitted_desativado", null);

    const { data: contact, error: contactError } = await admin
      .from("contacts")
      .select("phone_number")
      .eq("organization_id", row.organization_id)
      .eq("id", click.contact_id)
      .maybeSingle();
    if (contactError) return retry("leitura_do_contato");
    if (!contact) return await concluir("skipped", "contato_excluido", null);

    const credencial = await lerCredencial(admin, row.organization_id, "meta_ads", {
      exigirAcaoDeVenda: false,
    });
    if (!credencial.ok) {
      if (credencial.motivo === "leitura_indisponivel") {
        const settled = await concluir("skipped", "nova_tentativa_agendada", credencial.motivo);
        return settled.status === "skipped" ? retry(credencial.motivo) : settled;
      }
      return await concluir("skipped", credencial.motivo, null);
    }
    const transporte = transporteDe("meta_ads");
    if (!transporte) return await concluir("skipped", "plataforma_sem_transporte", null);

    // Ultima leitura imediatamente antes do POST; uma chamada ja iniciada pode terminar.
    const aindaAtiva = await conferirAtivacao();
    if (aindaAtiva === "indisponivel") {
      const settled = await concluir("skipped", "nova_tentativa_agendada", "leitura_da_ativacao");
      return settled.status === "skipped" ? retry("leitura_da_ativacao") : settled;
    }
    if (aindaAtiva !== "liberado")
      return await concluir("skipped", "lead_submitted_desativado", null);

    const envio = await transporte.enviar(credencial.credencial, {
      organizationId: row.organization_id,
      leadId: null,
      evento: "LeadSubmitted",
      eventoNaPlataforma: "LeadSubmitted",
      eventoId: click.event_id,
      ocorridoEm: new Date(click.captured_at),
      cliqueDeOrigem: click.ctwa_clid,
      telefone: contact.phone_number,
      valorCentavos: null,
      moeda: "",
    });
    if (envio.tipo === "transitorio" || envio.tipo === "processando") {
      const reason =
        envio.tipo === "processando" ? "aguardando_processamento" : "nova_tentativa_agendada";
      const settled = await concluir("skipped", reason, envio.detalhe);
      return settled.status === "skipped" ? retry(reason) : settled;
    }
    if (envio.tipo === "permanente")
      return await concluir("error", "recusado_pela_plataforma", envio.detalhe);
    return await concluir(
      credencial.credencial.testEventCode ? "skipped" : "sent",
      credencial.credencial.testEventCode ? "evento_de_teste" : null,
      null,
    );
  } catch {
    // A lease expira; o event_id por clique permanece igual na proxima tentativa.
    return retry("falha_no_processamento");
  }
}

export const conversaoDeCliqueMetaHandler: EventHandler = {
  key: KEY,
  naOrgParada: "pula",
  events: ["message.received", "ad_conversion.click_retry_requested"],
  handle,
};
