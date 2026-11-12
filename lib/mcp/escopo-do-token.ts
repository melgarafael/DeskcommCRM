/**
 * ESCOPO EXTRA QUE SÓ UM TOKEN DE INTEGRAÇÃO PAGA.
 *
 * `requiresScope` (`lib/mcp/types.ts`) só conhece `mcp:read`/`mcp:write`, e o
 * runtime do agente nativo monta `ctx` SEM `tokenScopes` (`lib/ai/runtime/agent.ts`)
 * — é assim que as tools distinguem "um token de fora chamando" de "o agente da
 * casa operando o turno". Esta função usa exatamente essa diferença:
 *
 *   • `ctx.tokenScopes === undefined` → runtime interno; a checagem não se aplica
 *     (o poder do agente já é limitado por `requiresRole` e pelo catálogo ligado
 *     na tela);
 *   • `ctx.tokenScopes` presente → token externo (`/api/mcp` sempre preenche,
 *     `lib/mcp/server.ts`); sem o escopo, a chamada fecha em 403 nomeado.
 *
 * O precedente é `lib/mcp/media-derived-read.ts`, que faz a mesma distinção para
 * `messages:derived:read`. Não se usa `actor.type` porque token com escopo
 * `actor:ai_agent` vira `ai_agent` (`deriveActor`) e passaria batido.
 */
import type { McpContext } from "./types";
import { McpAuthError } from "./auth";

export function exigeEscopoDoTokenDeIntegracao(
  ctx: Pick<McpContext, "tokenScopes">,
  escopo: string,
): void {
  if (ctx.tokenScopes === undefined) return;
  if (ctx.tokenScopes.includes(escopo)) return;
  throw new McpAuthError(
    -32002,
    403,
    `Token missing required scope '${escopo}'.`,
    "forbidden_role",
  );
}
