import type { McpContext } from "./types";
/** Opt-in na credencial autenticada, nunca nos argumentos do modelo. */
export function projetarDerivadoNoHistorico(
  message: {
    media_derived_text?: string | null;
    media_derived_status?: string | null;
    media_url?: string | null;
    media_storage_path?: string | null;
    metadata?: Record<string, unknown> | null;
  },
  ctx: Pick<McpContext, "actor" | "tokenScopes">,
): { media_derived_text?: string | null; media_derived_status?: string | null } {
  const token =
    ctx.actor.type === "api_token" || (ctx.actor.type === "ai_agent" && !!ctx.actor.api_token_id);
  if (!token || !ctx.tokenScopes?.includes("messages:derived:read")) return {};
  if (
    !message.media_storage_path &&
    !message.media_url &&
    message.metadata?.media_status === "expired"
  )
    return { media_derived_text: null, media_derived_status: null };
  return {
    media_derived_status: message.media_derived_status ?? null,
    media_derived_text:
      message.media_derived_status === "ready" ? (message.media_derived_text ?? null) : null,
  };
}
