/**
 * A NOVA BUSCA DAS COORDENADAS DE UM PINO que entrou só com o marcador.
 *
 * Medido em 29/09/2026: a API do canal não respondeu a tempo ("The operation was
 * aborted due to timeout", duas vezes), e o pino de um pedido confirmado ficou
 * como "📍 Location" — sem mapa na conversa e sem link para o entregador. Uma
 * busca feita minutos depois trouxe as coordenadas; este consumidor faz isso
 * sozinho e grava o pino como a ingestão o teria gravado (tipo `location`, corpo
 * com o link e, com a chave de Mapas, o endereço aproximado).
 *
 * O ritmo:
 * - espera 1 minuto antes da primeira tentativa — o dreno pode rodar dentro da
 *   própria requisição do webhook, e bater de novo na API que acabou de falhar
 *   só atrasaria a resposta ao provedor;
 * - depois, a cada 2 minutos, até 15 minutos da ingestão; então desiste
 *   (`skipped`, nunca `error`: não é incidente — o agente já pede ao cliente que
 *   reenvie quando o pino não tem link). O `retry` do dreno não conta tentativa,
 *   então o limite é pelo relógio do evento.
 *
 * Nunca rebaixa: só grava se a mensagem ainda não for `location`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { enderecoAproximadoDoPino } from "@/lib/mapas/credencial";
import { corpoDaLocalizacao } from "@/lib/messaging/localizacao";
import { createAdminClient } from "@/lib/supabase/admin";

import { resolveZernioCreds } from "./credentials";
import { buscarLocalizacaoZernio, EVENTO_NOVA_BUSCA_DO_PINO } from "./localizacao";

const CONSUMER_KEY = "zernio.pino_reintento";
export const ESPERA_INICIAL_MS = 60_000;
export const INTERVALO_MS = 2 * 60_000;
export const DESISTE_APOS_MS = 15 * 60_000;

const resultado = (status: HandlerResult["status"], detail?: string, retryAt?: number): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  ...(detail ? { detail } : {}),
  ...(retryAt !== undefined ? { retry_at: new Date(retryAt).toISOString() } : {}),
});

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export async function tratarNovaBuscaDoPino(
  row: EventRow,
  deps: { admin?: SupabaseClient; agora?: () => number } = {},
): Promise<HandlerResult> {
  const agora = deps.agora?.() ?? Date.now();
  // Sem a hora do evento não há relógio para o limite: uma tentativa só, sem reagendar.
  const criadoEm = row.created_at ? Date.parse(row.created_at) : agora - DESISTE_APOS_MS;
  if (agora - criadoEm < ESPERA_INICIAL_MS) return resultado("retry", "espera_inicial", criadoEm + ESPERA_INICIAL_MS);

  const p = (row.payload ?? {}) as Record<string, unknown>;
  const messageId = texto(p.message_id);
  const accountId = texto(p.account_id);
  const conversa = texto(p.provider_conversation_id);
  const externalId = texto(p.external_id);
  if (!messageId || !accountId || !conversa || !externalId) return resultado("skipped", "payload_incompleto");

  const admin = deps.admin ?? createAdminClient();
  // ⚠️ Service role: a organização vem do evento, nunca do payload.
  const { data: m, error } = await admin
    .from("messages")
    .select("id, type, metadata")
    .eq("organization_id", row.organization_id)
    .eq("id", messageId)
    .maybeSingle();
  if (error) return resultado("retry", `leitura da mensagem falhou: ${error.message}`, agora + INTERVALO_MS);
  const msg = m as { id: string; type: string; metadata: Record<string, unknown> | null } | null;
  if (!msg) return resultado("skipped", "mensagem_inexistente");
  if (msg.type === "location") return resultado("skipped", "ja_tem_coordenadas");

  const desistir = agora - criadoEm >= DESISTE_APOS_MS;
  let location;
  try {
    const creds = await resolveZernioCreds(admin, { organizationId: row.organization_id, accountId });
    if (!creds) return resultado("skipped", "sem_credenciais");
    location = await buscarLocalizacaoZernio(creds, conversa, externalId);
  } catch (err) {
    if (desistir) return resultado("skipped", "desistiu_api_fora");
    return resultado("retry", err instanceof Error ? err.message.slice(0, 120) : "falha", agora + INTERVALO_MS);
  }
  if (!location) {
    // Sem coordenadas na API: ou ainda não listada, ou não era pino (alguém digitou 📍).
    return desistir ? resultado("skipped", "sem_coordenadas") : resultado("retry", "sem_coordenadas_ainda", agora + INTERVALO_MS);
  }

  const aproximado = await enderecoAproximadoDoPino(admin, row.organization_id, location);
  const completa = aproximado ? { ...location, aproximado } : location;
  const { error: ue } = await admin
    .from("messages")
    .update({ type: "location", body: corpoDaLocalizacao(completa), metadata: { ...(msg.metadata ?? {}), location: completa } })
    .eq("organization_id", row.organization_id)
    .eq("id", msg.id)
    .neq("type", "location");
  if (ue) return resultado("retry", `gravação falhou: ${ue.message}`, agora + INTERVALO_MS);
  logger.info("zernio: pino recuperado na nova busca", { organization_id: row.organization_id, message_id: msg.id });
  return resultado("ok", "pino_recuperado");
}

export const pinoReintentoHandler: EventHandler = {
  key: CONSUMER_KEY,
  // Pode chamar o Google (chave de Mapas): numa empresa suspensa, o pino fica como marcador.
  naOrgParada: "pula",
  events: [EVENTO_NOVA_BUSCA_DO_PINO],
  handle: (row) => tratarNovaBuscaDoPino(row),
};
