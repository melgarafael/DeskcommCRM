/**
 * Audit log dedicado para tool calls MCP.
 *
 * Spec 11 §6: cada tool call gera 1 entrada em `api_audit_log` com
 * `action='mcp.tool_called'`, `actor_type='ai_agent'` (quando aplicavel),
 * `actor_api_token_id=<token>`, `resource_type='mcp_tool'`, `resource_id=<tool_name>`.
 *
 * Fire-and-forget: falha de write nunca bloqueia retorno da tool.
 */
import { audit } from "@/lib/audit";
import type { McpContext } from "./types";

interface AuditMcpToolCallInput {
  ctx: McpContext;
  toolName: string;
  args: Record<string, unknown>;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  resultSummary?: string;
}

const ARGS_REDACT_KEYS = new Set([
  "authorization",
  "api_key",
  "token",
  "password",
  "cpf",
]);

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (ARGS_REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = "[redacted]";
    } else if (typeof v === "string" && v.length > 500) {
      out[k] = `${v.slice(0, 500)}...[truncated]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * O resultado de uma tool é um ERRO "soft" — devolvido como valor, não lançado?
 *
 * Várias tools (ex.: `crm_query_external_data`) sinalizam falha de NEGÓCIO no
 * próprio retorno (`{ erro: "filtro_sem_valor", mensagem }`) em vez de lançar.
 * O `success` da auditoria era `true` para QUALQUER retorno, então uma consulta
 * que não foi feita aparecia como bem-sucedida nas métricas. Aqui a gente lê o
 * resultado e devolve o código do erro (ou `null` quando é sucesso).
 *
 * Convenções observadas no repo:
 *   - `{ erro: "codigo", mensagem }`           → erro
 *   - `{ ok: false, error: { code, message } }` → erro
 *   - `{ error: "..." }`                        → erro
 */
export function erroDeResultadoDaTool(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;

  if (typeof r.erro === "string" && r.erro.trim() !== "") return r.erro.trim();

  if (r.ok === false) {
    const e = r.error;
    if (typeof e === "string" && e.trim() !== "") return e.trim();
    if (e !== null && typeof e === "object") {
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string" && code.trim() !== "") return code.trim();
    }
    return "ok_false";
  }

  if (typeof r.error === "string" && r.error.trim() !== "") return r.error.trim();

  return null;
}

export async function auditMcpToolCall(input: AuditMcpToolCallInput): Promise<void> {
  const { ctx, toolName, args, durationMs, success, errorMessage, resultSummary } = input;

  const metadata: Record<string, unknown> = {
    actor_type: ctx.actor.type,
    actor_id: ctx.actor.id,
    tool_name: toolName,
    args: redactArgs(args),
    duration_ms: durationMs,
    success,
  };

  if (resultSummary) metadata.result_summary = resultSummary.slice(0, 280);
  if (errorMessage) metadata.error = errorMessage.slice(0, 500);
  if (ctx.actor.type === "ai_agent" && ctx.actor.api_token_id) {
    metadata.actor_api_token_id = ctx.actor.api_token_id;
  }

  await audit({
    action: "mcp.tool_called",
    // Quem age via MCP é um TOKEN, nunca uma linha de auth.users: para um token
    // comum, ctx.actor.id é o id do próprio token (lib/mcp/auth.ts), e mandá-lo
    // como actorUserId estourava a FK api_audit_log_actor_user_id_fkey. O ator
    // já fica registrado em actorApiTokenId e em metadata.actor_id.
    actorUserId: null,
    actorApiTokenId: ctx.apiTokenId,
    organizationId: ctx.organizationId,
    resourceType: "mcp_tool",
    // `resource_id` é uuid no banco; o nome da tool ia aqui como texto e o
    // insert morria com "invalid input syntax for type uuid: crm_create_lead".
    // O nome já viaja em metadata.tool_name, que é jsonb.
    resourceId: null,
    requestId: ctx.requestId,
    metadata,
  });
}
