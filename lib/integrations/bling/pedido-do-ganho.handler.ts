/**
 * Consumidor de `lead.won` para gerar Pedido de Venda no Bling ERP v3.
 *
 * Dispara automaticamente quando um negócio é ganho no CRM, caso
 * o switch `auto_create_order` esteja ativo na organização.
 */

import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  obterClienteBlingAutenticado,
  obterConfiguracaoBling,
  registrarLogBling,
} from "./store";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export const CONSUMIDOR_BLING_PEDIDO = "integracoes.bling-pedido-do-ganho.v1";

const res = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMIDOR_BLING_PEDIDO,
  status,
  detail,
});

async function handle(row: EventRow): Promise<HandlerResult> {
  const admin = createAdminClient();
  const orgId = row.organization_id;

  // 1. Checagem de isolamento e ativação
  const config = await obterConfiguracaoBling(admin, orgId);
  if (!config || !config.is_enabled || !config.features?.auto_create_order) {
    return res("skipped", "recurso_desativado");
  }

  const payload = (row.payload ?? {}) as { lead_id?: string; value_cents?: number };
  const leadId = typeof payload.lead_id === "string" ? payload.lead_id : (row.entity_id ?? null);
  if (!leadId) {
    return res("skipped", "lead_id_ausente");
  }

  // 2. Buscar dados do Lead no CRM
  const { data: lead, error: erroLead } = await admin
    .from("crm_leads")
    .select("id, title, value_cents, currency, contact_id, status")
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .maybeSingle();

  if (erroLead || !lead || lead.status !== "won") {
    return res("skipped", "lead_nao_encontrado_ou_nao_ganho");
  }

  // 3. Obter cliente autenticado do Bling
  const { client, error: erroClient } = await obterClienteBlingAutenticado(admin, orgId);
  if (erroClient || !client) {
    logger.warn("[bling.pedido] Não foi possível autenticar cliente Bling", { error: erroClient });
    return res("error", erroClient || "falha_autenticacao_bling");
  }

  // 4. Buscar dados do Contato
  let idContatoBling: number | undefined;
  let nomeContato = "Cliente CRM";

  if (lead.contact_id) {
    const { data: contato } = await admin
      .from("contacts")
      .select("id, name, email, phone, metadata")
      .eq("organization_id", orgId)
      .eq("id", lead.contact_id)
      .maybeSingle();

    if (contato) {
      nomeContato = contato.name || nomeContato;
      const meta = contato.metadata as Record<string, any> | null;
      const doc = meta?.documento || meta?.cpf || meta?.cnpj;

      const resContato = await client.criarOuAtualizarContato({
        nome: nomeContato,
        email: contato.email || undefined,
        celular: contato.phone || undefined,
        numeroDocumento: typeof doc === "string" ? doc : undefined,
      });

      if (resContato.ok && resContato.idContato) {
        idContatoBling = resContato.idContato;
      }
    }
  }

  if (!idContatoBling) {
    // Cria contato genérico no Bling com o título do negócio se não tiver contato associado
    const resContatoAvulso = await client.criarOuAtualizarContato({
      nome: nomeContato,
    });
    if (resContatoAvulso.ok && resContatoAvulso.idContato) {
      idContatoBling = resContatoAvulso.idContato;
    }
  }

  if (!idContatoBling) {
    await registrarLogBling(admin, orgId, {
      operation: "create_order",
      direction: "outbound",
      status: "failed",
      details: { leadId, motivo: "falha_ao_identificar_contato_no_bling" },
      error_message: "Não foi possível criar ou associar contato no Bling",
    });
    return res("error", "falha_contato_bling");
  }

  // 5. Montar e disparar Pedido de Venda no Bling
  const valorTotal = (lead.value_cents ?? 0) / 100;
  const resPedido = await client.criarPedidoVenda({
    contato: { id: idContatoBling },
    itens: [
      {
        descricao: lead.title || "Venda CRM",
        quantidade: 1,
        valor: valorTotal > 0 ? valorTotal : 1.0,
      },
    ],
    observacoes: `Gerado automaticamente via DeskcommCRM a partir da oportunidade ganha #${leadId}.`,
  });

  await registrarLogBling(admin, orgId, {
    operation: "create_order",
    direction: "outbound",
    status: resPedido.ok ? "success" : "failed",
    details: {
      leadId,
      idPedidoBling: resPedido.idPedido,
      numeroPedidoBling: resPedido.numero,
    },
    error_message: resPedido.ok ? null : (resPedido.error ?? null),
  });

  if (!resPedido.ok) {
    return res("error", resPedido.error || "erro_ao_criar_pedido_bling");
  }

  // 6. Registrar auditoria do sistema
  audit({
    action: "bling.updated",
    organizationId: orgId,
    resourceType: "crm_lead",
    resourceId: leadId,
    metadata: {
      pedidoCriadoNoBling: true,
      idPedidoBling: resPedido.idPedido,
      numeroPedidoBling: resPedido.numero,
    },
  });

  return res("ok", `pedido_bling_criado_${resPedido.idPedido}`);
}

export const blingPedidoDoGanhoHandler: EventHandler = {
  key: CONSUMIDOR_BLING_PEDIDO,
  events: ["lead.won"],
  naOrgParada: "pula",
  handle,
};
