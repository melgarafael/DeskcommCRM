/** Conversão do nascimento causado pela mensagem CTWA atual. */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { ativacaoLeadMeta, leadNasceuAposAtivacao } from "@/lib/conversoes/ativacao-lead-meta";
import { lerProvaMetaLeadSubmitted } from "@/lib/leads/prova-meta-lead-submitted";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";
import { transporteDe } from "@/lib/plataformas-de-anuncio/registry";
import { createAdminClient } from "@/lib/supabase/admin";

const KEY = "conversoes.nascimento_meta";
const ESPERA_MS = 5 * 60 * 1000;

async function conferirAtivacao(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  nasceuEm: string,
): Promise<"liberado" | "desativado" | "anterior" | "indisponivel"> {
  const { data, error } = await admin
    .from("organizations")
    .select("meta_lead_birth_enabled_at")
    .eq("id", orgId)
    .maybeSingle();
  // Falha de leitura é transitória: o dispatcher deve tentar de novo.
  if (error) return "indisponivel";
  const linha = data as unknown as { meta_lead_birth_enabled_at?: unknown } | null;
  if (!linha || ativacaoLeadMeta(linha.meta_lead_birth_enabled_at) === null) return "desativado";
  return leadNasceuAposAtivacao(linha.meta_lead_birth_enabled_at, nasceuEm)
    ? "liberado"
    : "anterior";
}

function resultado(status: HandlerResult["status"], detail?: string): HandlerResult {
  return { consumer_key: KEY, status, detail };
}
function retry(detail: string): HandlerResult {
  return {
    consumer_key: KEY,
    status: "retry",
    retry_at: new Date(Date.now() + ESPERA_MS).toISOString(),
    detail,
  };
}

async function handle(row: EventRow): Promise<HandlerResult> {
  if (row.entity_kind !== "crm_lead" || !row.entity_id)
    return resultado("skipped", "entidade_invalida");
  if (
    row.event_type === "ad_conversion.retry_requested" &&
    row.payload.event_name !== "LeadSubmitted"
  )
    return resultado("skipped", "outro_evento");
  if (row.event_type !== "lead.created" && row.event_type !== "ad_conversion.retry_requested")
    return resultado("skipped", "outro_evento");

  const admin = createAdminClient();
  try {
    const { data: lead, error: leadError } = await admin
      .from("crm_leads")
      .select("id,contact_id,created_at,source_metadata")
      .eq("organization_id", row.organization_id)
      .eq("id", row.entity_id)
      .maybeSingle();
    if (leadError) return retry("leitura_do_lead");
    if (!lead) return resultado("skipped", "lead_inexistente");
    const prova = lerProvaMetaLeadSubmitted(lead.source_metadata);
    if (!prova) return resultado("skipped", "sem_prova_causal");
    if (!lead.contact_id) return resultado("skipped", "sem_contato");

    // O livro por clique assume mensagens persistidas depois da migration.
    // A consulta pela identidade (nao apenas pela mensagem) impede que o mesmo
    // clid em outro contato reabra o caminho legado e duplique LeadSubmitted.
    // Sem linha, preserva o lead.created/retry anterior a esta migration.
    const { data: clickAtual, error: clickError } = await admin
      .from("meta_ctwa_click_dispatches")
      .select("id")
      .eq("organization_id", row.organization_id)
      .eq("ctwa_clid", prova.ctwa_clid)
      .maybeSingle();
    if (clickError) return retry("leitura_do_clique");
    if (clickAtual) return resultado("skipped", "clique_assumido_pelo_novo_consumidor");

    const ativacao = await conferirAtivacao(admin, row.organization_id, lead.created_at);
    if (ativacao === "indisponivel") return retry("leitura_da_ativacao");
    if (ativacao === "desativado") return resultado("skipped", "lead_submitted_desativado");
    if (ativacao === "anterior") return resultado("skipped", "anterior_ativacao");

    const { data: mensagem, error: messageError } = await admin
      .from("messages")
      .select("direction,contact_id,conversation_id,created_at,metadata")
      .eq("organization_id", row.organization_id)
      .eq("id", prova.message_id)
      .maybeSingle();
    if (messageError) return retry("leitura_da_mensagem");
    const ancora = (mensagem?.metadata as Record<string, unknown> | null)?.meta_ctwa_message_v1;
    if (
      !mensagem ||
      mensagem.direction !== "inbound" ||
      mensagem.contact_id !== lead.contact_id ||
      mensagem.conversation_id !== prova.conversation_id ||
      Date.parse(mensagem.created_at) !== Date.parse(prova.captured_at) ||
      !ancora ||
      typeof ancora !== "object" ||
      (ancora as Record<string, unknown>).platform !== "meta_ads" ||
      (ancora as Record<string, unknown>).source_type !== "ad" ||
      (ancora as Record<string, unknown>).ctwa_clid !== prova.ctwa_clid
    )
      return resultado("skipped", "prova_nao_confere_com_mensagem");

    const { data: contato, error: contactError } = await admin
      .from("contacts")
      .select("phone_number")
      .eq("organization_id", row.organization_id)
      .eq("id", lead.contact_id)
      .maybeSingle();
    if (contactError) return retry("leitura_do_contato");

    const { data: claim, error: claimError } = await admin.rpc("fn_claim_meta_lead_submitted", {
      p_org: row.organization_id,
      p_lead: lead.id,
    });
    if (claimError) return retry("claim_indisponivel");
    const posse = claim as { acquired?: boolean; token?: string; status?: string } | null;
    if (!posse?.acquired || !posse.token) {
      if (posse?.status === "busy") return retry("lease_vigente");
      if (posse?.status === "invalid_ledger") return resultado("error", "ledger_invalido");
      return resultado("skipped", posse?.status === "sent" ? "ja_enviada" : "sem_prova_causal");
    }

    const concluir = async (
      status: "sent" | "skipped" | "error",
      reason: string | null,
      detail: string | null,
    ): Promise<HandlerResult> => {
      const { data, error } = await admin.rpc("fn_settle_meta_lead_submitted", {
        p_org: row.organization_id,
        p_lead: lead.id,
        p_token: posse.token,
        p_status: status,
        p_reason: reason,
        p_detail: detail,
      });
      if (error || data !== true) return retry("settlement_indisponivel");
      return resultado(
        status === "sent" ? "ok" : status === "error" ? "error" : "skipped",
        reason ?? undefined,
      );
    };

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

    // Uma desativação pode ocorrer enquanto mensagem, claim e credencial são lidos.
    // Uma chamada HTTP que já começou pode terminar; nenhuma nova começa após esta checagem.
    const aindaAtiva = await conferirAtivacao(admin, row.organization_id, lead.created_at);
    if (aindaAtiva === "indisponivel") {
      const settled = await concluir("skipped", "nova_tentativa_agendada", "leitura_da_ativacao");
      return settled.status === "skipped" ? retry("leitura_da_ativacao") : settled;
    }
    if (aindaAtiva !== "liberado")
      return await concluir(
        "skipped",
        aindaAtiva === "anterior" ? "anterior_ativacao" : "lead_submitted_desativado",
        null,
      );

    const envio = await transporte.enviar(credencial.credencial, {
      organizationId: row.organization_id,
      leadId: lead.id,
      evento: "LeadSubmitted",
      eventoNaPlataforma: "LeadSubmitted",
      eventoId: `${lead.id}:LeadSubmitted`,
      ocorridoEm: new Date(lead.created_at),
      cliqueDeOrigem: prova.ctwa_clid,
      telefone: contato?.phone_number ?? null,
      valorCentavos: null,
      moeda: "",
    });
    if (envio.tipo === "transitorio" || envio.tipo === "processando") {
      const motivo =
        envio.tipo === "processando" ? "aguardando_processamento" : "nova_tentativa_agendada";
      const settled = await concluir("skipped", motivo, envio.detalhe);
      return settled.status === "skipped" ? retry(motivo) : settled;
    }
    if (envio.tipo === "permanente")
      return await concluir("error", "recusado_pela_plataforma", envio.detalhe);
    return await concluir(
      credencial.credencial.testEventCode ? "skipped" : "sent",
      credencial.credencial.testEventCode ? "evento_de_teste" : null,
      null,
    );
  } catch {
    // Lease expira se houve crash/erro; o mesmo event_id cobre o replay remoto.
    return retry("falha_no_processamento");
  }
}

export const conversaoDeNascimentoMetaHandler: EventHandler = {
  key: KEY,
  naOrgParada: "pula",
  events: ["lead.created", "ad_conversion.retry_requested"],
  handle,
};
