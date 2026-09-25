/**
 * Localização compartilhada: o webhook deste canal NÃO traz as coordenadas.
 *
 * Medido no payload real (24/09/2026): o cliente mandou o pino do WhatsApp e o
 * evento chegou só com `text: "📍 Location"` e `attachments: []`. As
 * coordenadas existem — a API de mensagens da conversa devolve a MESMA
 * mensagem com `metadata.location = { latitude, longitude }` —, mas só lá.
 *
 * Então, quando o texto é o marcador de localização, a ingestão pergunta à API
 * pela mensagem (o `id` dela lá é o wamid, o nosso `external_id`) e grava as
 * coordenadas. Uma chamada a mais só para esse tipo de mensagem.
 *
 * ─── Nunca derruba a ingestão ───────────────────────────────────────────────
 *
 * Rede fora, chave recusada, mensagem que ainda não apareceu na listagem: a
 * mensagem entra como entrava antes, com o marcador. Perder o pino é ruim;
 * perder a mensagem (ou fazer o provedor reentregar para sempre) é pior.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { lerLocalizacao, type Localizacao } from "@/lib/messaging/localizacao";

import { resolveZernioCreds, type ZernioCredentials } from "./credentials";
import type { ZernioInboundMessage } from "./webhook";

/** O texto que o provedor põe no lugar do pino. */
const MARCADOR = /^📍\s*location$/i;

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
 * A mensagem com as coordenadas, quando ela é um pino; a mesma mensagem, sem
 * mudança, em qualquer outro caso — inclusive quando a busca falha.
 */
export async function completarLocalizacao(
  admin: SupabaseClient,
  organizationId: string,
  msg: ZernioInboundMessage,
): Promise<ZernioInboundMessage> {
  if (msg.kind !== "message" || msg.attachments.length > 0) return msg;
  if (!ehMarcadorDeLocalizacao(msg.text) || !msg.accountId) return msg;
  try {
    const creds = await resolveZernioCreds(admin, { organizationId, accountId: msg.accountId });
    if (!creds) return msg;
    const location = await buscarLocalizacaoZernio(creds, msg.conversationId, msg.externalId);
    if (!location) {
      logger.warn("zernio: pino sem coordenadas na API — mensagem entra com o marcador", {
        organization_id: organizationId,
      });
      return msg;
    }
    return { ...msg, location };
  } catch (err) {
    logger.warn("zernio: busca das coordenadas do pino falhou — mensagem entra com o marcador", {
      organization_id: organizationId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return msg;
  }
}
