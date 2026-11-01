/**
 * A revogação AGENDADA das credenciais por contato — o lado HTTP do que os
 * gatilhos da migration 9081 só marcam (`revogar_apos`).
 *
 * Quem agenda: o encerramento da conversa (`fn_mcp_agenda_revogacao_no_encerramento`,
 * com a retenção do servidor) e a anonimização do contato
 * (`fn_mcp_contato_anonimizado_revoga_acessos`, imediata). Trigger não faz
 * HTTP; quem chama o `revocation_endpoint` (RFC 7009) do terceiro é esta rodada,
 * no cron `mcp-oauth-revogacao`. Contato anonimizado: a linha é APAGADA depois
 * de revogar (LGPD). Os demais: tokens em `NULL` e `revogado_em` marcado.
 *
 * A mesma rodada poda os pedidos de autorização vencidos há mais de um dia —
 * eles guardam `code_verifier` cifrado e não servem para mais nada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

import { revogarCredencialPorId } from "./credencial";
import type { OpcoesDeRede } from "./oauth";
import { lerServidor } from "./registro";

export const LOTE_DE_REVOGACAO = 50;

export interface ResultadoDaRodada {
  revogadas: number;
  apagadas: number;
  pedidosPodados: number;
}

export async function revogarVencidas(
  supabase: SupabaseClient,
  opcoes?: OpcoesDeRede & { lote?: number },
): Promise<ResultadoDaRodada> {
  const agora = new Date().toISOString();
  const { data, error } = await supabase
    .from("contato_mcp_credenciais")
    .select("id, organization_id, servidor_id, contact_id, contacts(is_anonymized)")
    .is("revogado_em", null)
    .lte("revogar_apos", agora)
    .order("revogar_apos", { ascending: true })
    .limit(opcoes?.lote ?? LOTE_DE_REVOGACAO);
  if (error) throw new Error(error.message);

  let revogadas = 0;
  let apagadas = 0;
  for (const linha of (data ?? []) as Array<Record<string, unknown>>) {
    const organizationId = String(linha.organization_id);
    const servidor = await lerServidor(supabase, organizationId, String(linha.servidor_id));
    const anonimizado = (linha.contacts as { is_anonymized?: boolean } | null)?.is_anonymized === true;
    if (!servidor) {
      await supabase.from("contato_mcp_credenciais").delete().eq("organization_id", organizationId).eq("id", String(linha.id));
      apagadas += 1;
      continue;
    }
    const r = await revogarCredencialPorId(supabase, servidor, String(linha.id), {
      ...opcoes,
      ...(anonimizado ? { apagar: true } : {}),
    });
    if (!r) continue;
    if (anonimizado) apagadas += 1;
    else revogadas += 1;
    void audit({
      action: "contact.mcp_acesso_revogado",
      organizationId,
      resourceType: "contact",
      resourceId: String(linha.contact_id),
      metadata: {
        servidor_id: servidor.id,
        motivo: anonimizado ? "lgpd_anonimizacao" : "encerramento_da_conversa",
        revogada_no_terceiro: r.revogadaNoTerceiro,
      },
    });
  }

  const umDiaAtras = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const poda = await supabase
    .from("mcp_oauth_pedidos")
    .delete({ count: "exact" })
    .lt("expira_em", umDiaAtras);
  if (poda.error) {
    logger.warn("poda dos pedidos de autorizacao MCP falhou", { error: poda.error.message });
  }
  return { revogadas, apagadas, pedidosPodados: poda.count ?? 0 };
}
