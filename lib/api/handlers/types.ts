/**
 * Shared types for `app/api/v1/<resource>/_handler.ts` core functions.
 *
 * Handlers são chamados tanto pelos Route Handlers REST quanto pelo MCP server
 * (S-13.03). O `Actor` discriminado permite que o mesmo handler atenda usuário
 * humano (cookie session) ou agente de IA (Bearer token com actor_type='ai_agent').
 */

export type Actor =
  | { type: "user"; id: string; role?: string }
  | { type: "ai_agent"; id: string; role: string; api_token_id?: string }
  | { type: "webhook_source"; id: string };

export interface HandlerCtx {
  organization_id: string;
  actor: Actor;
  requestId: string;
}
