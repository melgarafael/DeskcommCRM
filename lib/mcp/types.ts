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
   * Limpa os args ANTES da auditoria (os dois ingressos: runtime e `/api/mcp`).
   *
   * Existe porque `auditMcpToolCall` grava os args em `api_audit_log.metadata` e
   * só redige um punhado de chaves conhecidas (token, senha…). Uma tool cujos
   * args carregam PII por DESENHO — os valores de filtro de uma consulta a banco
   * externo, por exemplo — precisa tirá-los por conta própria: o valor filtrado
   * é o dado do cliente, e log é lugar de metadado, não de conteúdo.
   */
  redigirParaAuditoria?: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    input: z.infer<z.ZodObject<TInput>>,
    ctx: McpContext,
  ) => Promise<unknown>;
}
