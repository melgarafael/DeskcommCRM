/**
 * A revogação AGENDADA das credenciais por contato — o lado HTTP do que os
 * gatilhos da migration 9095 só marcam (`revogar_apos`).
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
 *
 * A rodada tem ORÇAMENTO de tempo menor que o `-m60` do scheduler e prazo
 * curto por chamada ao terceiro: o que não coube fica para a próxima, e cada
 * linha é reclamada antes da rede (`revogarCredencialPorId`), então rodadas
 * sobrepostas não repetem chamada nem auditoria.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

import { revogarCredencialPorId } from "./credencial";
import type { OpcoesDeRede } from "./oauth";
import { lerServidor, type ServidorDoAgenteComSegredo } from "./registro";

export const LOTE_DE_REVOGACAO = 50;
/** Orçamento da rodada: abaixo do `curl -m60` do scheduler. */
export const ORCAMENTO_DA_RODADA_MS = 40_000;
/** Prazo de cada chamada ao `revocation_endpoint` dentro da rodada. */
const TIMEOUT_DA_REVOGACAO_MS = 5_000;

export interface ResultadoDaRodada {
  revogadas: number;
  apagadas: number;
  pedidosPodados: number;
}

export async function revogarVencidas(
  supabase: SupabaseClient,
  opcoes?: OpcoesDeRede & { lote?: number; orcamentoMs?: number },
): Promise<ResultadoDaRodada> {
  const prazo = Date.now() + (opcoes?.orcamentoMs ?? ORCAMENTO_DA_RODADA_MS);
  const rede: OpcoesDeRede = {
    ...(opcoes?.fetch ? { fetch: opcoes.fetch } : {}),
    timeoutMs: opcoes?.timeoutMs ?? TIMEOUT_DA_REVOGACAO_MS,
  };
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
    if (Date.now() >= prazo) break;
    const organizationId = String(linha.organization_id);
    const contatoId = linha.contact_id as string;
    const servidor = await lerServidor(supabase, organizationId, String(linha.servidor_id));
    const anonimizado = (linha.contacts as { is_anonymized?: boolean } | null)?.is_anonymized === true;
    if (!servidor) {
      await supabase.from("contato_mcp_credenciais").delete().eq("organization_id", organizationId).eq("id", String(linha.id));
      apagadas += 1;
      continue;
    }
    const r = await revogarCredencialPorId(supabase, servidor, String(linha.id), {
      ...rede,
      ...(anonimizado ? { apagar: true } : {}),
    });
    if (!r) continue;
    if (anonimizado) apagadas += 1;
    else revogadas += 1;
    void audit({
      action: "contact.mcp_acesso_revogado",
      organizationId,
      resourceType: "contact",
      resourceId: contatoId,
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

/**
 * Revoga no terceiro e APAGA todos os acessos vivos de um servidor, com a
 * configuração que o emitiu (`servidor`, lido antes de qualquer mudança). Os
 * pedidos pendentes saem PRIMEIRO, para nenhum callback novo gravar credencial
 * no meio. Quem chama: a remoção do servidor e a edição que troca a origem dos
 * tokens (endereço, modo ou `client_id`) — token emitido por um authorization
 * server não vai para outro host.
 */
export async function revogarAcessosDoServidor(
  supabase: SupabaseClient,
  servidor: ServidorDoAgenteComSegredo,
  opcoes?: OpcoesDeRede,
): Promise<number> {
  await supabase.from("mcp_oauth_pedidos").delete().eq("organization_id", servidor.organizationId).eq("servidor_id", servidor.id);
  const { data } = await supabase
    .from("contato_mcp_credenciais")
    .select("id")
    .eq("organization_id", servidor.organizationId)
    .eq("servidor_id", servidor.id)
    .is("revogado_em", null);
  let revogadas = 0;
  for (const linha of (data ?? []) as Array<{ id: string }>) {
    if (await revogarCredencialPorId(supabase, servidor, linha.id, { ...opcoes, apagar: true })) revogadas += 1;
  }
  return revogadas;
}

/**
 * Antes de EXCLUIR o contato: revoga no terceiro os acessos vivos dele. A
 * cascata da exclusão apaga as linhas — e com elas o token que a RFC 7009
 * exige —, então a revogação tem de vir antes. Melhor esforço: falha do
 * terceiro não impede a exclusão (a linha sai do mesmo jeito).
 */
export async function revogarAcessosDoContato(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  opcoes?: OpcoesDeRede,
): Promise<number> {
  const { data } = await supabase
    .from("contato_mcp_credenciais")
    .select("id, servidor_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .is("revogado_em", null);
  let revogadas = 0;
  for (const linha of (data ?? []) as Array<{ id: string; servidor_id: string }>) {
    const servidor = await lerServidor(supabase, organizationId, linha.servidor_id);
    if (!servidor) continue;
    const r = await revogarCredencialPorId(supabase, servidor, linha.id, {
      timeoutMs: TIMEOUT_DA_REVOGACAO_MS,
      ...opcoes,
      apagar: true,
    });
    if (!r) continue;
    revogadas += 1;
    void audit({
      action: "contact.mcp_acesso_revogado",
      organizationId,
      resourceType: "contact",
      resourceId: contactId,
      metadata: { servidor_id: servidor.id, motivo: "exclusao_do_contato", revogada_no_terceiro: r.revogadaNoTerceiro },
    });
  }
  return revogadas;
}
