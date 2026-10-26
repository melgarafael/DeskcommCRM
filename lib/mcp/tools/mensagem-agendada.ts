/**
 * As ferramentas de MENSAGEM AGENDADA — o agente marca um texto para sair na
 * hora combinada, sem reescrever nada no disparo.
 *
 * ⚠️ FACHADA FINA, como as irmãs de agenda: a régua toda (piso de 30 s, teto de
 * um ano, teto de 10 partes, 4096 por parte, quem pode cancelar) mora em
 * `lib/mensagem-agendada/regras.ts`, e o adaptador de banco em
 * `lib/mensagem-agendada/crm.ts` — os MESMOS que a rota REST usa. Aqui não há
 * número nem condição própria; se houvesse, a tela e o modelo discordariam sobre
 * o mesmo pacote na primeira correção.
 *
 * ⚠️ `redigirParaAuditoria` NÃO É OPCIONAL. Os argumentos desta tool carregam o
 * TEXTO que vai para o cliente, e `auditMcpToolCall` grava args em
 * `api_audit_log`, que é append-only e fica fora da cascata de LGPD. O log guarda
 * o que foi agendado (quantas partes, quando), nunca o que foi escrito.
 */
import { z } from "zod";

import {
  agendaMensagemNoCrm,
  cancelaMensagemAgendadaNoCrm,
  listaMensagensAgendadasNoCrm,
} from "@/lib/mensagem-agendada/crm";
import { STATUS_DO_PACOTE } from "@/lib/mensagem-agendada/regras";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";

/**
 * O que o modelo vê de volta. `body` volta CORTO e só para o modelo saber o que
 * já está marcado — o pacote inteiro no contexto empurra para fora o que a
 * pessoa acabou de dizer.
 */
function resumoDoPacote(pacote: {
  id: string;
  scheduled_for: string;
  tz: string;
  status: string;
  cancel_if_contact_replies: boolean;
  cancel_reason: string | null;
  parts: Array<{ position: number; body: string | null; status: string; media_storage_path: string | null }>;
}) {
  return {
    id: pacote.id,
    quando: pacote.scheduled_for,
    fuso: pacote.tz,
    estado: pacote.status,
    cancela_se_o_cliente_responder: pacote.cancel_if_contact_replies,
    ...(pacote.cancel_reason !== null ? { motivo: pacote.cancel_reason } : {}),
    partes: pacote.parts.map((parte) => ({
      ordem: parte.position + 1,
      estado: parte.status,
      texto:
        parte.body === null
          ? null
          : parte.body.length > 140
            ? `${parte.body.slice(0, 140)}…`
            : parte.body,
      ...(parte.media_storage_path !== null ? { anexo: true } : {}),
    })),
  };
}

const agendarShape = {
  conversation_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "A conversa onde a mensagem vai aparecer. Vem de `crm_list_conversations` ou `crm_get_conversation`.",
    ),
  contact_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Alternativa a `conversation_id`: o contato. Use só quando a conversa for óbvia (uma só aberta); " +
        "o sistema escolhe a mais recente e devolve qual foi.",
    ),
  scheduled_for: z
    .string()
    .min(1)
    .describe(
      "O instante do envio, em ISO 8601 COM fuso (ex.: '2026-10-27T09:00:00-03:00'). " +
        "Sem fuso o horário é lido como UTC e sai na hora errada. Mínimo 30 s à frente.",
    ),
  tz: z
    .string()
    .max(64)
    .optional()
    .describe("Fuso IANA para EXIBIR a hora (ex.: 'America/Sao_Paulo'). Quem manda é `scheduled_for`."),
  cancel_if_contact_replies: z
    .boolean()
    .optional()
    .describe(
      "true = se o cliente responder antes da hora, NÃO envie. Use quando a resposta dele torna " +
        "a mensagem inútil (cobrança de algo que ele já resolveu, lembrete de algo que ele já confirmou).",
    ),
  parts: z
    .array(
      z.object({
        text: z
          .string()
          .min(1)
          .max(4096)
          .describe("O texto deste balão. Cada parte vira UMA mensagem, na ordem."),
      }),
    )
    .min(1)
    .max(10)
    .describe(
      "De 1 a 10 balões, enviados na ordem. Prefira UM: várias partes só quando o texto é " +
        "naturalmente dividido (endereço, lista de documentos).",
    ),
};

export const crmScheduleMessage: McpToolDefinition<typeof agendarShape> = {
  name: "crm_schedule_message",
  description:
    "Agenda uma mensagem de texto para ser enviada sozinha numa hora futura, na conversa do cliente. " +
    "O texto sai EXATAMENTE como você escreveu — no disparo ninguém reescreve nada. " +
    "Use quando a pessoa pediu para ser lembrada mais tarde, ou quando o melhor momento de falar é " +
    "depois (fora do horário comercial, amanhã de manhã, depois de um prazo). " +
    "NÃO use para responder agora (isso é `crm_send_whatsapp_message`) nem para um retorno em que a IA " +
    "vai reescrever a mensagem no momento (`crm_schedule_followup`) — aqui o texto é fixo. " +
    "`scheduled_for` precisa de fuso explícito; o mínimo é 30 s à frente. " +
    "Se o cliente responder antes da hora e você marcar `cancel_if_contact_replies`, o envio é cancelado. " +
    "Confirme com a pessoa ANTES de agendar: é mensagem que chega no celular dela sem ninguém revisar depois.",
  inputSchema: agendarShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  redigirParaAuditoria: (args) => {
    const partes = Array.isArray(args.parts) ? args.parts : [];
    return {
      ...args,
      parts: partes.map((parte) => {
        const p = (parte ?? {}) as Record<string, unknown>;
        const texto = typeof p.text === "string" ? p.text : "";
        return { text_length: texto.length };
      }),
    };
  },
  handler: async (input, ctx: McpContext) => {
    const resultado = await agendaMensagemNoCrm(
      {
        admin: ctx.supabase,
        orgId: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
        source: "mcp",
      },
      {
        conversation_id: input.conversation_id ?? null,
        contact_id: input.contact_id ?? null,
        scheduled_for: input.scheduled_for,
        tz: input.tz ?? null,
        cancel_if_contact_replies: input.cancel_if_contact_replies,
        parts: input.parts.map((parte) => ({ body: parte.text })),
      },
    );
    if (!resultado.ok) {
      return { agendado: false, motivo: resultado.codigo, mensagem: resultado.mensagem };
    }
    return { agendado: true, agendamento: resumoDoPacote(resultado.pacote) };
  },
};

const listarShape = {
  conversation_id: z.string().uuid().optional().describe("Filtra por conversa."),
  contact_id: z.string().uuid().optional().describe("Filtra por contato (todas as conversas dele)."),
  status: z
    .enum(STATUS_DO_PACOTE)
    .optional()
    .describe("Filtra pelo estado. Omitido devolve todos, dos mais próximos no tempo."),
  limite: z.number().int().min(1).max(50).optional().describe("Quantos voltam (padrão 20)."),
};

export const crmListScheduledMessages: McpToolDefinition<typeof listarShape> = {
  name: "crm_list_scheduled_messages",
  description:
    "Lista as mensagens já agendadas para este cliente (ou nesta conversa): quando saem, em que estado " +
    "estão e o começo do texto. " +
    "CHAME ANTES de agendar de novo: duas mensagens para a mesma hora chegam como insistência. " +
    "CHAME TAMBÉM quando a pessoa disser que 'aquela mensagem não chegou' — o estado (`scheduled`, " +
    "`sent`, `partial`, `failed`, `cancelled`) é o que responde. " +
    "`partial` significa que só parte dos balões saiu; `failed` que nada saiu.",
  inputSchema: listarShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx: McpContext) => {
    const resultado = await listaMensagensAgendadasNoCrm(
      {
        admin: ctx.supabase,
        orgId: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
        source: "mcp",
      },
      {
        conversation_id: input.conversation_id ?? null,
        contact_id: input.contact_id ?? null,
        status: input.status ?? null,
        limite: input.limite ?? 20,
      },
    );
    if (!resultado.ok) {
      return { agendamentos: [], motivo: resultado.codigo, mensagem: resultado.mensagem };
    }
    return { agendamentos: resultado.pacotes.map(resumoDoPacote) };
  },
};

const cancelarShape = {
  scheduled_message_id: z
    .string()
    .uuid()
    .describe("O agendamento, vindo de `crm_list_scheduled_messages`."),
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe("Por que está desmarcando. A equipe lê isto no histórico do agendamento."),
};

export const crmCancelScheduledMessage: McpToolDefinition<typeof cancelarShape> = {
  name: "crm_cancel_scheduled_message",
  description:
    "Desmarca uma mensagem que ainda NÃO saiu, para ela não chegar ao cliente. " +
    "Use quando a pessoa pedir para não receber mais aquilo, quando o motivo do lembrete deixou de " +
    "existir, ou quando ela mesma já resolveu o assunto. " +
    "Só funciona enquanto o estado é `scheduled`: depois que o envio começou, o que saiu não volta atrás " +
    "(e aí o certo é avisar a equipe, não insistir). " +
    "NÃO use para cancelar retorno da IA — isso é `crm_cancel_followup`.",
  inputSchema: cancelarShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx: McpContext) => {
    const resultado = await cancelaMensagemAgendadaNoCrm(
      {
        admin: ctx.supabase,
        orgId: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
        source: "mcp",
      },
      input.scheduled_message_id,
      input.reason,
    );
    if (!resultado.ok) {
      return { cancelado: false, motivo: resultado.codigo, mensagem: resultado.mensagem };
    }
    return { cancelado: true, agendamento: resumoDoPacote(resultado.pacote) };
  },
};
