import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  obterConfiguracaoBling,
  registrarLogBling,
} from "@/lib/integrations/bling/store";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const { token } = await ctx.params;

  if (!token) {
    return fail("invalid_input", "Token de identificação do webhook é obrigatório", 400, {
      requestId,
    });
  }

  const admin = createAdminClient();

  // 1. Resolver organização através do token (que é o organization_id ou id de integração)
  const { data: integracao, error: erroOrg } = await admin
    .from("bling_integrations")
    .select("organization_id, is_enabled, features")
    .or(`organization_id.eq.${token},id.eq.${token}`)
    .maybeSingle();

  if (erroOrg || !integracao) {
    logger.warn("[bling.webhook] Organização não localizada para o token fornecido", { token });
    return fail("not_found", "Integração não encontrada", 404, { requestId });
  }

  const orgId = integracao.organization_id;
  const config = await obterConfiguracaoBling(admin, orgId);

  if (!config || !config.is_enabled) {
    return ok({ received: true, ignored: "integracao_desativada" }, { requestId });
  }

  const rawBody = await req.text();
  const contentType = req.headers.get("content-type") ?? "";
  const isForm = contentType.includes("application/x-www-form-urlencoded");

  let body: Record<string, any> = {};
  if (isForm) {
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    if (params.data && typeof params.data === "string") {
      try {
        body = JSON.parse(params.data);
      } catch {
        body = params;
      }
    } else {
      body = params;
    }
  } else {
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      body = { raw: rawBody };
    }
  }

  // 2. Registrar evento de entrada para auditoria
  const eventName = body.event || body.tipo || body.topic || "generic_update";

  await registrarLogBling(admin, orgId, {
    operation: `webhook_${eventName}`,
    direction: "inbound_webhook",
    status: "success",
    details: body,
    error_message: null,
  });

  // 3. Processar Notificação de Rastreamento (se ativo)
  const rastreioAtivo = config.features?.tracking_notifications ?? false;

  // Bling pode enviar dados de envio/rastreamento dentro de body.data ou direto
  const dados = body.data || body.retorno || body;
  const codigoRastreio =
    dados.codigoRastreio ||
    dados.codigo_rastreio ||
    dados.rastreamento ||
    dados.tracking_code ||
    dados.objeto;

  const numeroPedido =
    dados.numeroPedido ||
    dados.numero ||
    dados.numero_pedido ||
    dados.pedido?.numero;

  const urlRastreio = dados.urlRastreio || dados.url || dados.link;

  if (rastreioAtivo && codigoRastreio) {
    try {
      // Localizar contato pelo documento, telefone ou id do Bling
      const idContatoBling = dados.contato?.id || dados.cliente?.id;
      const telefone = dados.contato?.celular || dados.contato?.telefone || dados.telefone;
      const doc = dados.contato?.numeroDocumento || dados.contato?.cnpj || dados.contato?.cpf;

      let contato: any = null;

      if (telefone) {
        const digitos = String(telefone).replace(/\D/g, "");
        if (digitos.length >= 8) {
          const { data: contatosTel } = await admin
            .from("contacts")
            .select("id, name, phone")
            .eq("organization_id", orgId)
            .ilike("phone", `%${digitos.slice(-8)}%`)
            .limit(1);

          if (contatosTel && contatosTel.length > 0) contato = contatosTel[0];
        }
      }

      if (!contato && doc) {
        const digitosDoc = String(doc).replace(/\D/g, "");
        const { data: contatosDoc } = await admin
          .from("contacts")
          .select("id, name, phone, metadata")
          .eq("organization_id", orgId)
          .limit(20);

        if (contatosDoc) {
          contato = contatosDoc.find((c) => {
            const m = c.metadata as Record<string, any> | null;
            const docCadastrado = String(m?.documento || m?.cpf || m?.cnpj || "").replace(/\D/g, "");
            return docCadastrado === digitosDoc;
          });
        }
      }

      // Se localizou o contato, procura a conversa mais recente
      if (contato) {
        const { data: conv } = await admin
          .from("conversations")
          .select("id, channel_session_id")
          .eq("organization_id", orgId)
          .eq("contact_id", contato.id)
          .order("last_message_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (conv) {
          const primeiroNome = (contato.name || "Cliente").split(" ")[0];
          const mensagemTexto =
            `📦 Olá, ${primeiroNome}! Seu pedido${numeroPedido ? ` #${numeroPedido}` : ""} foi despachado!\n\n` +
            `🚚 Código de rastreamento: *${codigoRastreio}*\n` +
            (urlRastreio ? `Acompanhe por aqui: ${urlRastreio}\n\n` : "\n") +
            `Qualquer dúvida estamos à disposição por aqui!`;

          await admin.from("messages").insert({
            organization_id: orgId,
            conversation_id: conv.id,
            channel_session_id: conv.channel_session_id,
            contact_id: contato.id,
            type: "text",
            direction: "outbound",
            status: "queued",
            body: mensagemTexto,
            sent_via: "system",
            metadata: {
              origin: "bling_webhook_tracking",
              tracking_code: codigoRastreio,
              order_number: numeroPedido,
            },
          });

          logger.info("[bling.webhook] Notificação de rastreio enfileirada no WhatsApp", {
            contatoId: contato.id,
            codigoRastreio,
          });
        }
      }
    } catch (err: any) {
      logger.warn("[bling.webhook] Falha ao processar envio de notificação de rastreio", {
        error: err?.message,
      });
    }
  }

  return ok({ received: true }, { requestId });
}
