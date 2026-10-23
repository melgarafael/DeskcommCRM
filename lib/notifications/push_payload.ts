import { z } from "zod";

import { ROTULO_DO_TIPO } from "@/lib/messaging/previa-da-mensagem";

import { NOTIFY_KINDS } from "./kinds";

export const PUSH_PAYLOAD_MAX = 140;

/**
 * O contrato com o funil (`./web_push.ts`), que decide o que aparece com a
 * tela bloqueada (`./tela-bloqueada.ts`):
 *
 * - `title` é QUEM (nome do contato, título do negócio) ou uma frase fixa —
 *   nunca o conteúdo;
 * - `body` é o conteúdo;
 * - `corpoSemPrevia` é o corpo que pode aparecer no modo "só quem mandou".
 *   Ausente = corpo vazio nesse modo. Nunca sai do servidor.
 */
export const pushPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  tag: z.string().optional(),
  href: z.string().optional(),
  icon: z.string().optional(),
  corpoSemPrevia: z.string().optional(),
});

export type PushPayload = z.infer<typeof pushPayloadSchema>;

export function montarPayloadDeInbound(input: {
  brand: string;
  conversationId: string | null;
  preview: string;
  contactName?: string | null;
  icon?: string | null;
  corpoSemPrevia?: string;
}): PushPayload {
  const title = input.contactName?.trim() || "Nova mensagem";
  void input.brand;
  const body = truncar(input.preview);
  const prefixo = NOTIFY_KINDS.message_inbound.tagPrefix;
  const tag = input.conversationId ? `${prefixo}:${input.conversationId}` : prefixo;
  const href = input.conversationId ? `/app/inbox?id=${input.conversationId}` : "/app/inbox";
  const icon = input.icon?.trim() || undefined;
  return { title, body, tag, href, icon, corpoSemPrevia: input.corpoSemPrevia };
}

const NOVA_MENSAGEM = "Nova mensagem";

/**
 * O corpo do aviso de uma mensagem recebida, com e sem a prévia. Texto mostra
 * o começo; os outros tipos dizem o tipo com a palavra do balão
 * (`ROTULO_DO_TIPO`) — a legenda de mídia fica de fora, como sempre ficou.
 */
export function corpoDoAvisoDeMensagem(
  tipo: string,
  previa: string | null | undefined,
): { body: string; corpoSemPrevia: string } {
  if (tipo === "text") return { body: truncar(previa?.trim() || NOVA_MENSAGEM), corpoSemPrevia: NOVA_MENSAGEM };
  const rotulo = Object.hasOwn(ROTULO_DO_TIPO, tipo) ? ROTULO_DO_TIPO[tipo]! : NOVA_MENSAGEM;
  return { body: rotulo, corpoSemPrevia: rotulo };
}

export function truncar(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= PUSH_PAYLOAD_MAX) return t;
  return `${t.slice(0, PUSH_PAYLOAD_MAX - 1)}…`;
}
