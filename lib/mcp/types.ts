import type { MeetingBookingContext } from "@/lib/agenda/meet-delivery";
/**
 * Tipos compartilhados do MCP server interno (Spec 11).
 *
 * Cada tool MCP é uma `McpToolDefinition` que declara name + description +
 * inputSchema (Zod) + handler. Handlers recebem `McpContext` resolvido pelo
 * server core (org, role, actor, supabase admin client).
 */
import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import type { Role } from "@/lib/auth/types";

export interface McpContext {
  /** Somente o runtime in-process fornece o job original, nunca o cliente MCP. */
  meetingBooking?: MeetingBookingContext;
  /** Chave `Idempotency-Key` da requisição MCP externa, quando enviada. */
  idempotencyKey?: string;
  /** Job estável do runtime in-process; nunca vem dos argumentos da tool. */
  sourceJobId?: string;
  /**
   * O CONTATO que este turno atende — contexto de CONFIANÇA do handler.
   *
   * Mesmo status de `sourceJobId`: nasce do lado de quem monta o turno e NUNCA
   * vem dos argumentos da tool — o modelo não escreve este campo nem tem como
   * alcançá-lo. `lib/ai/runtime/tools.ts` o injeta na chamada do handler, que é
   * o único ponto que tem `input.contatoDoTurno`, para valer para todo chamador
   * de `pickToolsFromMcp`.
   *
   * Ausente nos ingressos de fora do turno (rota HTTP, MCP externo) — e a
   * ausência é o que mantém o comportamento deles intacto. O Operador NÃO está
   * entre eles: `operator-turn.ts` monta o turno com `contactId: job.contact_id`,
   * então ele também recebe o contato da conversa e também fica escopado. Uso hoje: o
   * escopo de LEITURA de contato de `lib/mcp/tools/contacts.ts` (#2158) e das
   * demais leituras do atendimento — `conversations.ts` (lista, conversa,
   * histórico) e `comercio.ts` (pedidos) (#2178). A conversa é com alguém, e a
   * ficha, a busca, a conversa, o histórico e os pedidos de outro cliente não
   * saem do turno.
   */
  contatoDoTurno?: string;
  organizationId: string;
  role: Role;
  actor: Actor;
  apiTokenId: string;
  requestId: string;
  /** Service-role admin client. Tools devem filtrar `organization_id` em toda query. */
  supabase: SupabaseClient;
}

export type McpToolCategory = "read" | "write" | "handoff";

export interface McpToolDefinition<TInput extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: TInput;
  category: McpToolCategory;
  /** Role mínima para invocar. Read default agent; Write default manager. */
  requiresRole: Role;
  /**
   * Scope obrigatório no `api_tokens.scopes` (ex: `mcp:read`, `mcp:write`).
   * Ausência → -32002 forbidden.
   */
  requiresScope: "mcp:read" | "mcp:write";
  /**
   * Atende token de empresa SUSPENSA (`McpAuthResult.orgSuspensa`). Só a
   * privacidade (LGPD nunca é bloqueada — decisão do dono, 30/09); a cerca
   * `tests/unit/org-suspensa-so-nas-rotas-permitidas.test.ts` vigia onde aparece.
   */
  permiteOrgSuspensa?: true;
  /**
   * Limpa os args ANTES da auditoria (os dois ingressos: runtime e `/api/mcp`).
   *
   * Existe porque `auditMcpToolCall` grava os args em `api_audit_log.metadata` e
   * só redige um punhado de chaves conhecidas (token, senha…). Uma tool cujos
   * args carregam PII por DESENHO — os valores de filtro de uma consulta a banco
   * externo, por exemplo — precisa tirá-los por conta própria: o valor filtrado
   * é o dado do cliente, e log é lugar de metadado, não de conteúdo.
   */
  redigirParaAuditoria?: (args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * O que a tool DECLARA quando a resposta é um vazio que NÃO é sucesso.
   *
   * Uma busca que não acha nada TERMINOU bem: não houve erro, houve ausência —
   * e as duas coisas ficavam idênticas para a auditoria, que só via a chamada
   * completar e gravava `success: true`. O painel de capacidades lia `falhas: 0`
   * ("nenhuma falha") enquanto o agente nunca achava um produto: a mentira não
   * estava no número, estava no número não existir (issue #484).
   *
   * Devolver o motivo aqui é o que separa "não achei" de "falhei": quem lê este
   * campo é a auditoria em `lib/ai/runtime/tools.ts`, e o motivo desce para
   * `api_audit_log.metadata.motivo`, de onde a próxima contagem de "não achei"
   * por loja e por termo vai poder ler.
   *
   * AUSENTE = todo vazio continua sucesso, exatamente como antes. É por tool de
   * propósito: agenda sem compromissos numa janela é uma RESPOSTA ("não tem nada
   * nesse período"), não uma falha — marcar todo vazio de toda tool
   * transformaria comportamento normal em alarme.
   */
  motivoDoVazio?: (resultado: unknown) => string | null;
  handler: (
    input: z.infer<z.ZodObject<TInput>>,
    ctx: McpContext,
  ) => Promise<unknown>;
}
