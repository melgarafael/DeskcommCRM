/**
 * MCP write tool — crm_publish_whatsapp_status (#3397).
 *
 * Publica uma IMAGEM no Status de UM número do CRM, a pedido de um sistema
 * externo, depois da aprovação do dono. Nada de envio novo: o caminho é a sessão
 * que o CRM já gerencia (QR, saúde, reconexão).
 *
 * ─── O que este arquivo NÃO faz ─────────────────────────────────────────────
 *
 * Não fala com provedor nenhum. A publicação atravessa
 * `publicarStatusDoWhatsapp` (`lib/channels/publicacao-de-status.ts`), que
 * pergunta a CAPABILITY do canal (`statusUpdates`), confere `canalDesativado` e
 * chama o `publishStatus` do adapter. Antes disto, a ferramenta pegava o
 * cliente do provedor direto — era a única saída do produto fora do seam, e o
 * preço era só funcionar no transporte que ela nomeava.
 *
 * O que sobra aqui, e é de quem ENTRA pela porta de token: o freio anti-ban do
 * número (mesmo `ritmo-do-envio-por-token` do envio de mensagem) e as duas
 * travas de público — sem lista, o Status iria para todos os contatos do
 * número, então "todos" precisa ser dito.
 */
import { z } from "zod";

import { publicarStatusDoWhatsapp } from "@/lib/channels/publicacao-de-status";
import {
  depsDoRitmo,
  registrarEnvioPorToken,
  segurarEnvioPorToken,
  type EnvioSegurado,
} from "@/lib/messaging/ritmo-do-envio-por-token";
import { createAdminClient } from "@/lib/supabase/admin";
import type { McpToolDefinition } from "../types";

// ~6 MB de base64 ≈ 4,5 MB de imagem: sobra para um JPEG 9:16 e barra upload absurdo.
const MAX_BASE64 = 6_000_000;

const inputShape = {
  channel_session_id: z.string().uuid().describe("Sessão de canal (número) cujo Status será publicado."),
  image_base64: z.string().min(100).max(MAX_BASE64).describe("Imagem em base64, sem o prefixo `data:`."),
  image_mime: z.enum(["image/jpeg", "image/png"]).optional().default("image/jpeg"),
  caption: z.string().max(1000).optional().describe("Legenda curta que acompanha a imagem."),
  contacts: z
    .array(z.string().min(8).max(20))
    .max(500)
    .optional()
    .describe("Telefones que verão o Status (com DDI; a máscara é ignorada). Quem pediu para sair, foi anonimizado ou é contato pessoal fica de fora, e `excluded_opt_out` diz quantos."),
  all_contacts: z
    .boolean()
    .optional()
    .describe("true = todos os contatos do número. A conexão precisa guardar histórico. Só use com autorização explícita do dono."),
  idempotency_key: z.string().min(1).max(200).optional().describe("Deduplicação (24h): a mesma chave devolve a publicação anterior."),
};

export const crmPublishWhatsappStatus: McpToolDefinition<typeof inputShape> = {
  name: "crm_publish_whatsapp_status",
  description:
    "Publica uma IMAGEM no Status do WhatsApp do número `channel_session_id`. " +
    "Informe `contacts` (telefones que verão) ou `all_contacts: true` (todos os contatos) — um dos dois é obrigatório. " +
    "Use só depois de o dono aprovar a peça. Forneça `idempotency_key` para não publicar em dobro num retry (TTL 24h).",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  // Lista do que FICA, e não do que sai: campo novo não entra na auditoria sem
  // alguém decidir. Telefone e legenda são dado de terceiro, e `api_audit_log` é
  // append-only: o que entra lá não sai por pedido de LGPD.
  redigirParaAuditoria: (args) => ({
    channel_session_id: args.channel_session_id,
    audience: args.all_contacts === true ? "todos" : "contatos",
    contacts_count: Array.isArray(args.contacts) ? args.contacts.length : 0,
    caption_present: typeof args.caption === "string" && args.caption.trim().length > 0,
  }),
  handler: async (input, ctx) => {
    // Freio anti-ban do número: o MCP é sempre token, e o teto de chamadas do
    // token não sabe de warm-up nem de teto diário do número.
    const ritmo = await depsDoRitmo(createAdminClient());
    let segurado: EnvioSegurado = null;

    const publicacao = await publicarStatusDoWhatsapp({
      db: ctx.supabase,
      organizationId: ctx.organizationId,
      canalId: input.channel_session_id,
      imagem: { mime: input.image_mime, base64: input.image_base64 },
      legenda: input.caption,
      contatos: input.contacts,
      todos: input.all_contacts,
      idempotencyKey: input.idempotency_key,
      freio: {
        segurar: async () => {
          segurado = await segurarEnvioPorToken(ritmo, {
            organizationId: ctx.organizationId,
            channelSessionId: input.channel_session_id,
            requestId: ctx.requestId,
          });
        },
        registrar: () => registrarEnvioPorToken(ritmo, ctx.organizationId, segurado, "sent"),
      },
    });

    return {
      published: true,
      status_id: publicacao.statusId,
      audience: publicacao.publico,
      excluded_opt_out: publicacao.excluidos,
      deduplicated: publicacao.deduplicado,
    };
  },
};
