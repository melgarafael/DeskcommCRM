/**
 * Localização compartilhada pelo cliente — o pino do WhatsApp neste canal.
 *
 * ─── De onde vêm as coordenadas ─────────────────────────────────────────────
 *
 * Do PRÓPRIO webhook, em `metadata.location` (lido por `parseZernioInbound`).
 * Nem sempre foi assim: medido no payload real em 24/09/2026, o pino chegava só
 * com `text: "📍 Location"` e `attachments: []`, e as coordenadas existiam
 * apenas na API de mensagens da conversa. A ingestão, então, perguntava à API
 * DENTRO da requisição do webhook — até 2 × 4 s mais 0,8 s de espera.
 *
 * ─── Por que a API saiu do caminho da requisição (27/10/2026) ──────────────
 *
 * O provedor dá por FALHADA a entrega que não responde em 5 s, e reentrega. No
 * log de entregas dele (30 dias), 29 das 129 entregas de pino tinham vencido
 * por tempo — e os 50 pinos do período já traziam `metadata.location`, ou seja,
 * a consulta não acrescentava nada e era a parte mais lenta do pino.
 *
 * Hoje: com `metadata.location`, nenhuma chamada ao provedor; só o endereço
 * aproximado do Google (teto próprio de 2,5 s), que o agente usa para confirmar
 * a cidade. Sem `metadata.location`, a mensagem entra com o marcador e a busca
 * pela API vai para `./pino-reintento.handler.ts`, que roda em segundos pelo
 * dreno do worker, sem segurar a resposta ao provedor.
 *
 * ─── Nunca derruba a ingestão ───────────────────────────────────────────────
 *
 * Rede fora, chave recusada, mensagem que ainda não apareceu na listagem: a
 * mensagem entra como entrava antes, com o marcador. Perder o pino é ruim;
 * perder a mensagem (ou fazer o provedor reentregar para sempre) é pior.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { enderecoAproximadoDoPino } from "@/lib/mapas/credencial";
import { lerLocalizacao, type Localizacao } from "@/lib/messaging/localizacao";

import type { ZernioCredentials } from "./credentials";
import type { ZernioInboundMessage } from "./webhook";

/**
 * O texto que o provedor põe no lugar do pino: `📍 Location` para a localização
 * atual, e `📍 <nome do lugar>` quando o cliente escolhe um lugar com nome no
 * mapa — medido em 24/09/2026: "📍 Praça da Matriz" chegou sem coordenadas no
 * webhook e COM elas (mais nome e endereço) na API. Enquanto só a primeira forma
 * era reconhecida, o lugar com nome entrava como texto e o link do mapa sumia.
 *
 * Por isso basta o alfinete no começo. Alguém que DIGITA "📍 minha casa" custa
 * uma consulta à API, que não traz `metadata.location` — e a mensagem segue como
 * texto: quem decide que é pino é a API, não este padrão.
 */
const MARCADOR = /^📍/u;

/** Quantas mensagens recentes olhar: o pino acabou de chegar, está no topo. */
const RECENTES = 20;
const TEMPO_LIMITE_MS = 4_000;
/** O webhook pode chegar antes de a mensagem aparecer na listagem. */
const TENTATIVAS = 2;
const ESPERA_ENTRE_TENTATIVAS_MS = 800;

export function ehMarcadorDeLocalizacao(texto: string | null): boolean {
  return texto !== null && MARCADOR.test(texto.trim());
}

type Bruto = Record<string, unknown>;

function obj(v: unknown): Bruto | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
}

async function umaTentativa(
  creds: ZernioCredentials,
  conversationId: string,
  externalId: string,
): Promise<Localizacao | null | "nao_encontrada"> {
  const url =
    `${creds.baseUrl}/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages` +
    `?accountId=${encodeURIComponent(creds.accountId)}&limit=${RECENTES}&sortOrder=desc`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
    signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });
  if (!res.ok) throw new Error(`zernio_${res.status}`);
  const json = obj(await res.json().catch(() => null));
  const lista = Array.isArray(json?.messages) ? json.messages : [];
  const alvo = lista
    .map(obj)
    .find((m) => m !== null && (m.id === externalId || m.platformMessageId === externalId));
  if (!alvo) return "nao_encontrada";
  return lerLocalizacao(obj(alvo.metadata)?.location);
}

/** As coordenadas da mensagem, pela API. `null` quando não deu para obter. */
export async function buscarLocalizacaoZernio(
  creds: ZernioCredentials,
  conversationId: string,
  externalId: string,
  esperar: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Localizacao | null> {
  for (let i = 1; i <= TENTATIVAS; i++) {
    const r = await umaTentativa(creds, conversationId, externalId);
    if (r !== "nao_encontrada") return r;
    if (i < TENTATIVAS) await esperar(ESPERA_ENTRE_TENTATIVAS_MS);
  }
  return null;
}

/**
 * A mensagem com o endereço aproximado, quando ela é um pino que o webhook já
 * trouxe com coordenadas; a mesma mensagem, sem mudança, em qualquer outro caso.
 *
 * NÃO pergunta ao provedor: sem `metadata.location` no evento, quem busca é a
 * nova busca do pino (`pinoFicouSemCoordenadas` → `pedirNovaBuscaDoPino`), fora
 * da requisição. Ver o cabeçalho.
 */
export async function completarLocalizacao(
  admin: SupabaseClient,
  organizationId: string,
  msg: ZernioInboundMessage,
): Promise<ZernioInboundMessage> {
  if (msg.kind !== "message" || msg.attachments.length > 0) return msg;
  const location = msg.location;
  if (!location || location.aproximado) return msg;
  try {
    // Com a chave de Mapas da organização, as coordenadas ganham rua, cidade e
    // região aproximadas — o agente deixa de perguntar a cidade de quem mandou o
    // pino. Sem chave, nenhuma rede a mais; e a falha nunca derruba o pino.
    const aproximado = await enderecoAproximadoDoPino(admin, organizationId, location);
    return aproximado ? { ...msg, location: { ...location, aproximado } } : msg;
  } catch (err) {
    logger.warn("zernio: endereço aproximado do pino falhou — o pino entra só com as coordenadas", {
      organization_id: organizationId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return msg;
  }
}

/**
 * O pino ficou só com o marcador: era pino (o texto é o alfinete), veio pelo
 * WhatsApp e o evento não trouxe `metadata.location`. A busca pela API sai
 * daqui para a nova busca do pino, fora da requisição do webhook.
 *
 * Medido em 29/09/2026, quando a busca ainda era feita dentro da requisição:
 * "The operation was aborted due to timeout" duas vezes seguidas, e o pino de
 * um pedido confirmado ficou sem mapa — o entregador sem a localização. A busca
 * feita minutos depois trouxe as coordenadas.
 */
export function pinoFicouSemCoordenadas(msg: ZernioInboundMessage): boolean {
  return (
    msg.kind === "message" &&
    msg.direction === "inbound" &&
    msg.attachments.length === 0 &&
    !msg.location &&
    Boolean(msg.accountId) &&
    ehMarcadorDeLocalizacao(msg.text)
  );
}

/** O evento que pede uma nova busca das coordenadas, consumido por `pino-reintento.handler.ts`. */
export const EVENTO_NOVA_BUSCA_DO_PINO = "message.location_retry_requested";

/**
 * Pede uma nova busca das coordenadas, depois da ingestão. Best-effort, como a
 * persistência de mídia: a mensagem já está gravada, e derrubar a ingestão aqui
 * devolveria 500 ao provedor, que reenviaria tudo.
 */
export async function pedirNovaBuscaDoPino(
  admin: SupabaseClient,
  organizationId: string,
  messageId: string,
  msg: ZernioInboundMessage,
): Promise<void> {
  const { error } = await admin.rpc(
    "emit_event" as never,
    {
      p_event_type: EVENTO_NOVA_BUSCA_DO_PINO,
      p_entity_kind: "message",
      p_entity_id: messageId,
      p_payload: {
        message_id: messageId,
        account_id: msg.accountId,
        provider_conversation_id: msg.conversationId,
        external_id: msg.externalId,
      },
      p_metadata: { source: "zernio_webhook" },
      p_organization_id: organizationId,
    } as never,
  );
  if (error) {
    logger.warn("zernio: não consegui pedir a nova busca do pino", { organization_id: organizationId, detail: error.message });
  }
}
