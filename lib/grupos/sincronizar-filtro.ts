import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * Ressincroniza o filtro de grupos de UMA sessão do canal com `channel_session_groups`
 * (pelo menos um grupo ligado = recebe grupos). Chamado onde o app (re)inicia a sessão:
 * conectar/reativar (`lib/channels/connect-*.ts`) e reconectar (rota `reconnect`). Sem isso, uma
 * sessão recriada nasce ignorando grupos e o banco segue dizendo "ligado".
 *
 * `aplicarFiltro` é a porta do transporte (lê antes e só escreve quando o valor difere —
 * sem reinício de sessão quando já está certo). Quem chama a monta; este módulo não nomeia
 * provedor.
 *
 * NUNCA lança: a conexão do número vale mais que o filtro, e o próximo "ligar" também
 * reconfere. Leitura do banco falhando = não mexe em nada (não dá para decidir às cegas).
 * `admin` é service role: a consulta filtra `organization_id` (vindo da sessão autenticada).
 */
export async function sincronizarRecebimentoDeGrupos(
  admin: SupabaseClient,
  aplicarFiltro: ((sessionRef: string, receber: boolean) => Promise<boolean>) | undefined,
  e: { organizationId: string; channelSessionId: string; sessionRef: string },
): Promise<"sincronizado" | "nao_confirmado" | "sem_transporte" | "sem_leitura"> {
  if (typeof aplicarFiltro !== "function") return "sem_transporte";
  let receber: boolean;
  try {
    const { count, error } = await admin
      .from("channel_session_groups")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", e.organizationId)
      .eq("channel_session_id", e.channelSessionId)
      .eq("enabled", true);
    if (error || typeof count !== "number") return "sem_leitura";
    receber = count > 0;
  } catch {
    return "sem_leitura";
  }
  try {
    if (await aplicarFiltro(e.sessionRef, receber)) return "sincronizado";
  } catch (err) {
    logger.warn("grupos: falha ao ressincronizar o filtro de grupos na (re)conexão", {
      organizationId: e.organizationId,
      channelSessionId: e.channelSessionId,
      causa: err instanceof Error ? err.message : String(err),
    });
    return "nao_confirmado";
  }
  logger.warn("grupos: o canal não confirmou o filtro de grupos na (re)conexão", {
    organizationId: e.organizationId,
    channelSessionId: e.channelSessionId,
    receber,
  });
  return "nao_confirmado";
}
