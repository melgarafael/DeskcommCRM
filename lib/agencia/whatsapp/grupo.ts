/**
 * Criar o grupo do cliente pelo WhatsApp da agência (mapa › D10; SPEC-contratos, K5).
 *
 * Só o canal WAHA cria grupo com a liberdade que isso exige (D18). Qualquer outro
 * motivo de não criar — sem canal configurado, canal da API oficial, WAHA fora do
 * ar — volta como `{ ok: false, motivo }` em português, e quem chama avisa a
 * agência para criar à mão. Nunca lança.
 */
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient } from "@/lib/waha/client";

import { canalDaAgencia } from "./enfileirar";

export async function criarGrupoPelaAgencia(
  nome: string,
  participantes: readonly string[],
): Promise<{ ok: true; chatId: string } | { ok: false; motivo: string }> {
  if (participantes.length === 0) return { ok: false, motivo: "não há WhatsApp de ninguém para pôr no grupo" };
  const canal = await canalDaAgencia();
  if (!canal) return { ok: false, motivo: "o WhatsApp da agência não está configurado" };
  const { data } = await createAdminClient()
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("organization_id", canal.organizationId)
    .eq("id", canal.canalId)
    .maybeSingle();
  const linha = data as Parameters<typeof resolveSessionRef>[0] | null;
  if (!linha) return { ok: false, motivo: "o WhatsApp da agência não foi encontrado" };
  if (linha.provider !== "waha") return { ok: false, motivo: "o WhatsApp da agência não é um canal por QR Code (só ele cria grupo)" };
  const waha = getWahaClient();
  if (!waha) return { ok: false, motivo: "o WAHA não está configurado nesta instalação" };
  try {
    const g = await waha.criarGrupo(resolveSessionRef(linha), nome, participantes);
    return { ok: true, chatId: g.chatId };
  } catch (e) {
    logger.warn("agência: grupo do cliente não foi criado", { detalhe: e instanceof Error ? e.message : String(e) });
    return { ok: false, motivo: "o WhatsApp não aceitou criar o grupo agora" };
  }
}
