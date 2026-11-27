/**
 * MODO DE ENVIO INSTITUCIONAL — metadado carimbado exclusivamente no servidor.
 *
 * Mensagens institucionais usam `sent_via = "system"` como as demais mensagens de
 * integração, mas carregam `metadata[CHAVE_DO_MODO_DE_ENVIO] = "institutional"`
 * gravado pelo servidor APÓS remover qualquer homônimo vindo do payload do
 * cliente — o mesmo princípio do `integration_actor_name` em
 * `lib/messaging/nome-da-integracao.ts`.
 *
 * O objetivo é entregar avisos operacionais, comunicados ou lembretes em uma
 * conversa ativa e inequívoca sem produzir efeitos colaterais no atendimento:
 * não silencia nem retoma IA, não zera não lidas, não altera `last_outbound_at`,
 * `awaiting_since`, `last_message_at`, prévia, `contacts.last_activity_at` e
 * não altera dono ou carteira.
 */

export const CHAVE_DO_MODO_DE_ENVIO = "dispatch_mode" as const;

export const MODOS_DE_ENVIO = ["operational", "institutional"] as const;

export type ModoDeEnvio = (typeof MODOS_DE_ENVIO)[number];

export const MODO_DE_ENVIO_OPERACIONAL = "operational" as const;
export const MODO_DE_ENVIO_INSTITUCIONAL = "institutional" as const;

/**
 * Estados terminais que encerram o ciclo de atendimento e vedam envio
 * institucional (inclui `resolved` além de `closed` e `archived`, igual aos
 * guardas de fronteira de atendimento em `lib/atendimento/fronteira.ts`).
 */
export const STATUS_ENCERRADOS_PARA_INSTITUCIONAL: ReadonlySet<string> = new Set([
  "closed",
  "resolved",
  "archived",
]);

/** A conversa está fechada, resolvida, arquivada ou sem estado conhecido? (Fail-closed.) */
export function conversaEncerradaParaEnvioInstitucional(
  status: string | null | undefined,
): boolean {
  if (!status || typeof status !== "string") return true;
  return STATUS_ENCERRADOS_PARA_INSTITUCIONAL.has(status);
}

/**
 * Esta mensagem foi gravada pelo servidor como envio institucional?
 *
 * Leitura tolerante sobre `metadata` desconhecido (linhas antigas, cache ou
 * payload parcial retornam `false`).
 */
export function ehMensagemInstitucional(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return (
    (metadata as Record<string, unknown>)[CHAVE_DO_MODO_DE_ENVIO] === MODO_DE_ENVIO_INSTITUCIONAL
  );
}

/**
 * Erro levantado no recheck de corte (`checkBoundary`) quando uma conversa
 * ativa foi encerrada/resolvida/arquivada entre a leitura inicial e o disparo
 * ao canal. Capturado no `catch` do envio para tirar a linha de `queued`.
 */
export class ConversaEncerradaNoCorteError extends Error {
  constructor(public readonly statusAtual: string | null) {
    super("Conversa encerrada antes do envio institucional");
    this.name = "ConversaEncerradaNoCorteError";
  }
}
