/**
 * MCP write tool — crm_start_conversation_and_send (Spec 11 §3.2, lacuna do
 * cold-start externo).
 *
 * A LACUNA QUE ISTO FECHA. `crm_send_whatsapp_message` só manda mensagem para
 * um `conversation_id` que JÁ EXISTE — não abre conversa nova. O único
 * caminho que abria conversa com um contato NOVO era `POST /api/v1/contacts`
 * (`createContactHandler`), que (a) é cookie-session-only — uma automação
 * externa com chave `dsk_...` não passa por ali — e (b) escolhe a sessão do
 * canal sozinha (`sessaoProntaParaEnvio`, "WORKING primeiro; senão qualquer
 * uma"): o chamador não tinha como dizer POR QUAL número sair. Uma automação
 * de prospecção fria (ex.: n8n captando lead novo) que precise abrir a
 * conversa NUM canal específico não tinha ferramenta MCP para isso.
 *
 * DOUTRINA DIRC (Referenciar, não duplicar) — esta tool não reimplementa
 * nada, só compõe duas peças que já existem e já são a origem autorizada:
 *   - `openSharedContactConversation` (lib/messaging/open-shared-contact-conversation.ts),
 *     o MESMO helper que `POST /api/v1/conversations/open-with-contact` usa:
 *     acha o contato pelas grafias do telefone (`encontrarContatoPorTelefone`)
 *     ou cria um novo (`fn_upsert_wa_contact`), e abre/reabre a conversa 1:1 na
 *     sessão indicada via `ensureConversation` → `beginServiceAtOrigin` →
 *     `fn_service_begin` — a RPC cujo próprio comentário de migration diz
 *     "nova iniciativa autorizada (humano/MCP/regra), chamada NA ORIGEM".
 *   - `sendMessageHandler` (app/api/v1/messages/_handler.ts), o MESMO handler
 *     que `crm_send_whatsapp_message` chama — nenhum código de envio novo,
 *     mesmas guardas (bloqueio, mídia, template, boundary de atendimento).
 *
 * Idempotência: mesmo padrão de `crm_send_whatsapp_message` (tabela
 * `idempotency_keys`, TTL 24h) — a chave cobre o PAR abrir-conversa+enviar,
 * não só o envio, porque um retry não pode abrir uma segunda conversa.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import { sendMessageSchema } from "@/lib/schemas/messaging";
import { depsDoRitmo, registrarEnvioPorToken, segurarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";
import { createAdminClient } from "@/lib/supabase/admin";
import type { McpToolDefinition } from "../types";

const ENDPOINT_TAG = "mcp:crm_start_conversation_and_send";

const inputShape = {
  /** O ganho central desta tool: quem chama ESCOLHE o canal, sem auto-seleção. */
  channel_session_id: z
    .string()
    .uuid()
    .describe("Sessão de canal de onde a mensagem sai. Obrigatório — esta tool existe para deixar o chamador escolher, ao contrário da criação de contato pela tela, que pega qualquer canal WORKING."),
  contact_id: z.string().uuid().optional(),
  phone_number: z
    .string()
    .min(8)
    .max(32)
    .optional()
    .describe("Usado para achar um contato existente pelas grafias do número, ou criar um novo se nenhum bater."),
  name: z.string().trim().min(1).max(200).optional().describe("Nome do contato, usado só se um novo cadastro for criado."),
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

export const crmStartConversationAndSend: McpToolDefinition<typeof inputShape> = {
  name: "crm_start_conversation_and_send",
  description:
    "Abre uma conversa NOVA (ou reabre a existente) com um contato — existente via `contact_id`, " +
    "ou novo/achado pelo telefone via `phone_number` — num canal ESPECÍFICO escolhido em " +
    "`channel_session_id`, e envia a primeira mensagem. Use para iniciar contato com um lead que " +
    "ainda não tem conversa (ex.: automação de prospecção). Para responder numa conversa que já " +
    "existe, use `crm_send_whatsapp_message`. Forneça `idempotency_key` para evitar abrir a conversa " +
    "e mandar a mensagem em dobro num retry (TTL 24h).",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    if (!input.contact_id && !input.phone_number?.trim()) {
      throw new Error("Informe contact_id ou phone_number.");
    }

    const requestHash = hashRequest({
      channel_session_id: input.channel_session_id,
      contact_id: input.contact_id,
      phone_number: input.phone_number,
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

    // Freio anti-ban do número (#1491): aplicar ANTES de criar ou reabrir a conversa.
    // Se o freio segurar o envio por teto diário ou espaçamento, recusa com 429
    // sem deixar uma conversa vazia pendente no CRM.
    const ritmo = await depsDoRitmo(createAdminClient());
    const segurado = await segurarEnvioPorToken(ritmo, {
      organizationId: ctx.organizationId,
      channelSessionId: input.channel_session_id,
      requestId: ctx.requestId,
    });

    // Referencia a mesma origem autorizada que `open-with-contact` usa —
    // fn_service_begin decide reaproveitar a conversa aberta ou criar uma.
    const opened = await openSharedContactConversation(ctx.supabase, ctx.organizationId, {
      channel_session_id: input.channel_session_id,
      contact_id: input.contact_id,
      phone_number: input.phone_number,
      name: input.name,
    });

    const parsed = sendMessageSchema.parse({
      conversation_id: opened.conversation_id,
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
      contact_id: opened.contact_id,
      conversation_id: opened.conversation_id,
      message_id: message.id,
      status: message.status,
      external_id: message.external_id,
      sent_at: message.sent_at,
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
            console.error(
              "[mcp.start_conversation_and_send] idempotency cache failed",
              error.message,
            );
          }
        });
    }

    return response;
  },
};
