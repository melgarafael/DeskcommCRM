/**
 * O que o audit grava quando quem agiu é um MÓDULO conectado (spec 33, F2).
 *
 * O ator `module` carrega o id do TOKEN do módulo, não de uma pessoa: ele vai para `actor_api_token_id`
 * (coluna com FK para `api_tokens`) e o slug `<publisher>/<name>` vai para `metadata.module`. A coluna
 * `actor_user_id` fica nula — quem monta a entrada de audit já passa `null` para qualquer ator que não
 * seja `"user"`, e este arquivo não oferece caminho para o contrário.
 */
import type { Actor } from "@/lib/api/handlers/types";

export interface AuditDoModulo {
  actor_api_token_id: string;
  module: string;
}

/** `null` para qualquer ator que não seja módulo. */
export function auditDoModulo(actor: Actor): AuditDoModulo | null {
  if (actor.type !== "module") return null;
  return { actor_api_token_id: actor.id, module: actor.slug };
}

/** Para espalhar (`...metadataDoModulo(actor)`) na metadata de quem monta o audit. */
export function metadataDoModulo(actor: Actor): { actor_api_token_id?: string; module?: string } {
  return auditDoModulo(actor) ?? {};
}
