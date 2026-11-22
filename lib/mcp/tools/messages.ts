/**
 * MCP write tools — enviar mensagem e enviar MATERIAL DA EMPRESA (#4129).
 *
 * As duas wrappam `sendMessageHandler` com a idempotência de
 * `lib/mcp/idempotencia-da-ferramenta.ts` (#1613, item B): a chave é reservada
 * ANTES do efeito, a mesma chave com o mesmo pedido devolve a resposta gravada
 * sem enviar de novo, com pedido diferente é 409 `idempotency_conflict`, e com a
 * primeira chamada ainda em curso é 409 `idempotency_in_progress`.
 *
 * ⚠️ NÃO existe um segundo caminho de envio: `crm_send_material` prepara o
 * arquivo (cópia do bucket da empresa para a pasta da conversa) e chama o MESMO
 * `sendMessageHandler` do Inbox, das campanhas e do turno do agente. O que ele
 * NÃO faz é ler o material: material é enviado, não consultado.
 */
import { z } from "zod";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  canalDaConversa,
  prepararMaterialDaEmpresa,
} from "@/lib/agent-engine/agent/materiais-da-empresa";
import { copiarMaterialNoStorage } from "@/lib/materiais/copiar-no-storage";
import { sendMessageSchema } from "@/lib/schemas/messaging";
import { depsDoRitmo, registrarEnvioPorToken, segurarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";
import { createAdminClient } from "@/lib/supabase/admin";
import { enviarComChave } from "../idempotencia-da-ferramenta";
import type { McpToolDefinition } from "../types";

const ENDPOINT_TAG = "mcp:crm_send_whatsapp_message";

const inputShape = {
  conversation_id: z.string().uuid(),
  body: z.string().min(1).max(4096).optional(),
  media_url: z.string().url().optional(),
  // #5034: arquivo que o cliente MCP já subiu ao CRM (`POST /api/v1/conversations/{id}/media` devolve o
  // `storage_path`). Sem link público: documento de cliente não precisa ir para a internet. A posse do
  // arquivo (organização E esta conversa) é conferida pelo `sendMessageHandler`, a mesma régua do Inbox.
  media_storage_path: z.string().optional().describe("storage_path de POST /api/v1/conversations/{id}/media; dispensa media_url"),
  media_filename: z.string().optional(),
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

export const crmSendWhatsappMessage: McpToolDefinition<typeof inputShape> = {
  name: "crm_send_whatsapp_message",
  description:
    "Envia uma mensagem WhatsApp outbound para uma conversa existente. Forneça `idempotency_key` para evitar duplicação em retries (TTL 24h).",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  // #5034: o nome do arquivo pode carregar o nome do paciente ou do cliente, e a auditoria é só de
  // acréscimo (não some quando a mensagem some). O caminho também: quem erra e cola um caminho LOCAL
  // ("C:/clientes/Maria/laudo.pdf") deixaria o nome na trilha mesmo com o envio recusado. Fica o fato
  // de que havia, não o valor.
  redigirParaAuditoria: (args) => ({
    ...args,
    ...(args.media_filename === undefined ? {} : { media_filename: "[redigido]" }),
    ...(args.media_storage_path === undefined ? {} : { media_storage_path: "[redigido]" }),
  }),
  handler: async (input, ctx) => {
    const parsed = sendMessageSchema.parse({
      conversation_id: input.conversation_id,
      type: input.type,
      body: input.body,
      media_url: input.media_url,
      media_storage_path: input.media_storage_path,
      media_filename: input.media_filename,
      media_mime: input.media_mime,
    });

    return enviarComChave({
      ctx,
      endpoint: ENDPOINT_TAG,
      argumentos: input,
      executar: async () => {
        // Freio anti-ban do número: o MCP é sempre token, e o teto de chamadas
        // (`lib/mcp/rate-limit.ts`) não sabe de warm-up nem de teto diário do
        // número. Dentro do efeito: replay, conflito e "em curso" não o gastam.
        const ritmo = await depsDoRitmo(createAdminClient());
        const segurado = await segurarEnvioPorToken(ritmo, {
          organizationId: ctx.organizationId,
          conversationId: parsed.conversation_id,
          requestId: ctx.requestId,
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

        return {
          message_id: message.id,
          status: message.status,
          external_id: message.external_id,
          sent_at: message.sent_at,
        };
      },
    });
  },
};

const ENDPOINT_TAG_MATERIAL = "mcp:crm_send_material";

const materialInputShape = {
  conversation_id: z.string().uuid(),
  material_id: z.string().uuid().describe("id de um material ATIVO cadastrado pela empresa"),
  body: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("legenda que acompanha o documento; sem ela o material sai sem legenda"),
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Chave para deduplicação (24h TTL). Recomendado run_id+step."),
};

/**
 * `crm_send_material` — o material cadastrado da empresa como DOCUMENTO.
 *
 * É a capacidade de WIRE (API/MCP), irmã de `crm_send_whatsapp_message`. Dentro
 * do turno do agente quem envia material é a NATIVA `send_message` com
 * `material_id` — esta tool existe para quem integra por fora, e por isso entra
 * em `FERRAMENTAS_DO_HARNESS` (ver `ferramentas-do-harness.ts`): o motor não a
 * monta no atendimento (duas ferramentas de envio no mesmo turno são uma
 * escolha a mais para o modelo errar), mas a capacidade continua servida pelo
 * catálogo e executável por token.
 */
export const crmSendMaterial: McpToolDefinition<typeof materialInputShape> = {
  name: "crm_send_material",
  description:
    "Envia um material da empresa (catálogo em PDF, tabela de preços, ficha) que já está " +
    "cadastrado, como documento no WhatsApp, com `body` de legenda. O arquivo é copiado do " +
    "material para a conversa e enviado pelo caminho de mídia do sistema. Não lê nem resume o " +
    "conteúdo: o material é enviado, não consultado.",
  inputSchema: materialInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const pool = getRequestPool();

    // A preparação CONFERE o teto de 3 envios em 24 h e COPIA o arquivo para a
    // pasta da conversa (escrita no Storage): é efeito, e por isso mora dentro da
    // chave, junto com o freio e o envio. Quem conta no teto é a mensagem enviada
    // (`metadata.material_id`), não a cópia.
    return enviarComChave({
      ctx,
      endpoint: ENDPOINT_TAG_MATERIAL,
      argumentos: input,
      executar: async () => {
        // `agentId: null` — esta chamada é da ORGANIZAÇÃO (token), não de um
        // agente em turno: a lista `crm_materiais_do_agente` não se aplica a ela.
        const preparado = await prepararMaterialDaEmpresa(
          pool,
          copiarMaterialNoStorage({
            warn: (msg, fields) => console.warn(`[mcp.send_material] ${msg}`, fields ?? {}),
          }),
          {
            tenantId: ctx.organizationId,
            agentId: null,
            conversationId: input.conversation_id,
            materialId: input.material_id,
            canal: await canalDaConversa(pool, {
              tenantId: ctx.organizationId,
              conversationId: input.conversation_id,
            }),
            // A chamada por token É um pedido explícito de quem integra: o freio
            // de "não reenviar por iniciativa da IA" não se aplica. O teto de 3
            // em 24 h continua valendo, e é ele que impede um laço do integrador.
            clientePediu: true,
          },
        );
        if (!preparado.ok) throw new Error(preparado.code);

        const ritmo = await depsDoRitmo(createAdminClient());
        const segurado = await segurarEnvioPorToken(ritmo, {
          organizationId: ctx.organizationId,
          conversationId: input.conversation_id,
          requestId: ctx.requestId,
        });

        // O MESMO caminho de envio do Inbox, das campanhas e do turno.
        const message = await sendMessageHandler(
          ctx.supabase,
          {
            organization_id: ctx.organizationId,
            actor: ctx.actor,
            requestId: ctx.requestId,
          },
          {
            conversation_id: input.conversation_id,
            type: preparado.anexo.type,
            media_storage_path: preparado.anexo.storagePath,
            media_mime: preparado.anexo.mime,
            ...(preparado.anexo.filename ? { media_filename: preparado.anexo.filename } : {}),
            ...(input.body ? { body: input.body } : {}),
            // O id no metadata é o que faz o freio de reenvio contar esta saída.
            metadata: { material_id: preparado.material.id },
          },
        );
        await registrarEnvioPorToken(ritmo, ctx.organizationId, segurado, message.status);

        return {
          message_id: message.id,
          status: message.status,
          external_id: message.external_id,
          sent_at: message.sent_at,
          material_id: preparado.material.id,
          material_nome: preparado.material.nome,
        };
      },
    });
  },
};
