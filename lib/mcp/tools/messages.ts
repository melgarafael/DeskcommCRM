/**
 * MCP write tool — crm_send_whatsapp_message (Spec 11 §3.2).
 *
 * Wrappa `sendMessageHandler` com camada de idempotência (tabela
 * `idempotency_keys`). Se o mesmo `idempotency_key` for invocado de novo,
 * retorna o `message_id` cacheado sem inserir/enviar de novo.
 *
 * A LACUNA QUE O `phone_number` FECHA (issue #2812, item 3). Até aqui a tool só
 * mandava para uma `conversation_id` JÁ EXISTENTE: o agente que atendeu no
 * Instagram/Messenger, com o telefone que o próprio cliente informou na ficha
 * (#2593), não tinha como abrir (ou reaproveitar) a conversa no WhatsApp da
 * organização — faltava a metade "e agora?". Agora, sem `conversation_id`, a
 * tool aceita `phone_number` e resolve/acha a conversa 1:1 do contato no número
 * de WhatsApp PRONTO da organização.
 *
 * DOUTRINA DIRC (Referenciar, não duplicar) — nenhuma regra nova aqui:
 *   - o número é escolhido pela MESMA regra da casa que a criação de conversa
 *     usa, `sessaoProntaParaEnvio` (WORKING primeiro; senão qualquer número vivo
 *     que mande mensagem — `lib/automation/start-conversation.ts`), a mesma que
 *     `crm_start_conversation_and_send` e `open-with-contact` já usam;
 *   - a conversa é achada/reaberta/criada pelo MESMO helper
 *     `openSharedContactConversation` — que por sua vez compõe
 *     `encontrarContatoPorTelefone` + `fn_upsert_wa_contact` + `fn_service_begin`;
 *   - enviar continua sendo SÓ o `sendMessageHandler` (mesmas guardas de
 *     bloqueio, mídia, template e boundary de atendimento).
 * O freio anti-ban é aplicado ANTES de abrir, pelo mesmo motivo do
 * `crm_start_conversation_and_send`: freio que recusa não pode deixar uma
 * conversa vazia nascida.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import { sendMessageSchema } from "@/lib/schemas/messaging";
import {
  depsDoRitmo,
  registrarEnvioPorToken,
  segurarEnvioPorToken,
  type EnvioSegurado,
} from "@/lib/messaging/ritmo-do-envio-por-token";
import { createAdminClient } from "@/lib/supabase/admin";
import type { McpToolDefinition } from "../types";

const ENDPOINT_TAG = "mcp:crm_send_whatsapp_message";

const inputShape = {
  conversation_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Conversa que já existe. Omita quando o que você tem é o telefone: aí a conversa 1:1 é achada (ou criada) por `phone_number` no número de WhatsApp pronto da organização.",
    ),
  phone_number: z
    .string()
    .trim()
    .min(8)
    .max(32)
    .optional()
    .describe(
      "Telefone do cliente (E.164 ou com DDD). Usado só quando `conversation_id` é omitido: o contato é achado pelas grafias do número (ou cadastrado, se ainda não existir) e a conversa é aberta/reaproveitada no número de WhatsApp pronto da organização.",
    ),
  body: z.string().min(1).max(4096).optional(),
  media_url: z.string().url().optional(),
  media_mime: z.string().optional(),
  type: z
    .enum(["text", "image", "audio", "document", "sticker", "video", "location", "contact"])
    .optional()
    .default("text"),
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Chave para deduplicação (24h TTL). Recomendado run_id+step."),
};

function hashRequest(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export const crmSendWhatsappMessage: McpToolDefinition<typeof inputShape> = {
  name: "crm_send_whatsapp_message",
  description:
    "Envia uma mensagem WhatsApp outbound. Informe `conversation_id` para responder numa conversa existente, " +
    "ou `phone_number` para abrir (ou reaproveitar) a conversa 1:1 daquele contato no número de WhatsApp pronto " +
    "da organização e mandar a primeira mensagem — é o caminho para continuar no WhatsApp quem falou por " +
    "Instagram/Messenger. Forneça `idempotency_key` para evitar duplicação em retries (TTL 24h).",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const conversationIdInformado = input.conversation_id?.trim();
    const telefone = input.phone_number?.trim();
    if (!conversationIdInformado && !telefone) {
      throw new ApiError(
        422,
        "validation_error",
        undefined,
        ctx.requestId,
        "Informe `conversation_id` (uma conversa existente) ou `phone_number` (o telefone do cliente, para abrir ou reaproveitar a conversa no WhatsApp).",
      );
    }

    const requestHash = hashRequest({
      conversation_id: conversationIdInformado ?? null,
      phone_number: telefone ?? null,
      body: input.body,
      media_url: input.media_url,
      type: input.type,
    });

    if (input.idempotency_key) {
      const { data: cached } = await ctx.supabase
        .from("idempotency_keys")
        .select("response_body")
        .eq("organization_id", ctx.organizationId)
        .eq("endpoint", ENDPOINT_TAG)
        .eq("key", input.idempotency_key)
        .maybeSingle();
      if (cached) {
        return {
          ...(cached.response_body as Record<string, unknown>),
          deduplicated: true,
        };
      }
    }

    // Freio anti-ban do número: o MCP é sempre token, e o teto de chamadas
    // (`lib/mcp/rate-limit.ts`) não sabe de warm-up nem de teto diário do número.
    const ritmo = await depsDoRitmo(createAdminClient());

    let conversationId: string;
    let contactId: string | undefined;
    let segurado: EnvioSegurado;

    if (conversationIdInformado) {
      conversationId = conversationIdInformado;
      segurado = await segurarEnvioPorToken(ritmo, {
        organizationId: ctx.organizationId,
        conversationId,
        requestId: ctx.requestId,
      });
    } else {
      // Telefone → número da organização. A sessão é resolvida pela regra da casa
      // (`sessaoProntaParaEnvio`) ANTES de abrir: o freio aplicado nela não deixa
      // a conversa nascer quando o número está no teto/espaçamento.
      const channelSessionId = await sessaoProntaParaEnvio(ctx.supabase, ctx.organizationId);
      if (!channelSessionId) {
        throw new ApiError(
          422,
          "session_not_found",
          undefined,
          ctx.requestId,
          "Nenhum número de WhatsApp pronto para envio nesta organização.",
        );
      }
      segurado = await segurarEnvioPorToken(ritmo, {
        organizationId: ctx.organizationId,
        channelSessionId,
        requestId: ctx.requestId,
      });

      let aberta: Awaited<ReturnType<typeof openSharedContactConversation>>;
      try {
        aberta = await openSharedContactConversation(ctx.supabase, ctx.organizationId, {
          channel_session_id: channelSessionId,
          phone_number: telefone,
        });
      } catch (erro) {
        const motivo = erro instanceof Error ? erro.message : "";
        // Contato pessoal é escrita para fora da operação (spec 21, etapa 12):
        // recusa com o motivo, como `crm_start_conversation_and_send` faz.
        if (motivo === "contact_personal") {
          return {
            permitido: false,
            motivo: "contato_pessoal",
            mensagem:
              "este contato foi marcado como pessoal — ele está fora da operação: não abra " +
              "conversa nem envie nada para ele.",
          };
        }
        if (motivo === "invalid_phone") {
          throw new ApiError(
            422,
            "invalid_phone",
            undefined,
            ctx.requestId,
            "O telefone informado não é um número de WhatsApp válido.",
          );
        }
        throw erro;
      }
      conversationId = aberta.conversation_id;
      contactId = aberta.contact_id;
    }

    const parsed = sendMessageSchema.parse({
      conversation_id: conversationId,
      type: input.type,
      body: input.body,
      media_url: input.media_url,
      media_mime: input.media_mime,
    });

    const message = await sendMessageHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      parsed,
    );
    await registrarEnvioPorToken(ritmo, ctx.organizationId, segurado, message.status);

    const response = {
      message_id: message.id,
      status: message.status,
      external_id: message.external_id,
      sent_at: message.sent_at,
      // Quando a conversa foi resolvida pelo telefone, o chamador recebe o id —
      // e o `contato_aberto_por_telefone` registra no retorno que a conversa
      // nasceu/reapareceu por este caminho (auditoria de "aberta a partir do
      // canal social").
      ...(contactId
        ? { conversation_id: conversationId, contact_id: contactId, contato_aberto_por_telefone: true }
        : {}),
    };

    if (input.idempotency_key) {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await ctx.supabase
        .from("idempotency_keys")
        .insert({
          organization_id: ctx.organizationId,
          endpoint: ENDPOINT_TAG,
          key: input.idempotency_key,
          request_hash: requestHash,
          response_body: response,
          status_code: 200,
          expires_at: expiresAt,
        })
        .then(({ error }) => {
          if (error && error.code !== "23505") {
            console.error("[mcp.send_whatsapp] idempotency cache failed", error.message);
          }
        });
    }

    return response;
  },
};
