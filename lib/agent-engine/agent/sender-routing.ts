import type pg from "pg";
import { senderRoutesSchema, telefoneDoRemetente } from "@/lib/ai/agents/sender-routes";
import { telefoneDoChatDaMensagem } from "@/lib/channels/telefone-da-mensagem";
import type { LoadedRouter } from "./router-config";

/**
 * O telefone do chat que o canal gravou na entrada, ou `null`.
 *
 * Quem lê o id da mensagem recebida é `lib/channels/` — é ele que diz de qual
 * chat a mensagem veio. `contacts.phone_number` não serve: é campo da ficha,
 * editável por quem atende e preenchível por proposta de dado, e a regra por
 * remetente escolhe agente com ferramentas que o atendimento público não tem.
 *
 * Chat sem telefone (`@lid`) devolve `null` e cai no agente público — falha
 * fechada.
 */
export function telefoneDoCanal(externalId: string | null | undefined): string | null {
  return telefoneDoRemetente(telefoneDoChatDaMensagem(externalId));
}

/** Identidade gravada pelo canal na entrada, nunca a ficha nem o texto/prompt. */
export async function agentePorRemetente(
  db: Pick<pg.Pool, "query">,
  input: {
    tenantId: string;
    conversationId: string;
    channelSessionId: string;
  },
  router: LoadedRouter,
): Promise<{ agentId: string | null; reserved: Set<string> }> {
  const parsed = senderRoutesSchema.safeParse(router.senderRoutes ?? []);
  if (!parsed.success) throw new Error("sender_routes_invalid");
  const routes = parsed.data;
  const reserved = new Set(routes.map((r) => r.agent_id));
  if (!routes.length) return { agentId: null, reserved };
  if (!router.fallbackAgentId || reserved.has(router.fallbackAgentId))
    throw new Error("sender_routes_require_public_fallback");
  const { rows } = await db.query<{ external_id: string | null }>(
    `select m.external_id from messages m
     join conversations cv on cv.organization_id=m.organization_id and cv.id=m.conversation_id
     join contacts ct on ct.organization_id=cv.organization_id and ct.id=cv.contact_id
     where m.organization_id=$1 and m.conversation_id=$2 and m.channel_session_id=$3
       and cv.channel_session_id=$3 and cv.channel='whatsapp' and not cv.is_group
       and not ct.is_anonymized
       and m.direction='inbound' and m.sent_via='external_device' and m.external_id is not null
     order by m.sent_at desc, m.created_at desc, m.id desc limit 1`,
    [input.tenantId, input.conversationId, input.channelSessionId],
  );
  const phone = telefoneDoCanal(rows[0]?.external_id);
  return { agentId: phone ? (routes.find((r) => r.phone === phone)?.agent_id ?? null) : null, reserved };
}
