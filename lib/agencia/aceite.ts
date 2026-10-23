/**
 * Ler e fechar um convite (docs/agencia/SPEC-equipe.md › Convite, passos 4 e 5).
 * Servidor só: usa o client de serviço, sempre pelo HASH do token.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { hashDoToken, situacaoDoConvite, tokenTemFormatoValido, type SituacaoDoConvite } from "./convite";

export interface ConviteAberto {
  conviteId: string;
  membroId: string;
  nome: string;
  email: string;
  situacao: SituacaoDoConvite;
}

export async function lerConvite(token: string, agora = new Date()): Promise<ConviteAberto | null> {
  if (!tokenTemFormatoValido(token)) return null;
  const { data } = await createAdminClient()
    .from("agencia_convites")
    .select("id, membro_id, expira_em, aceito_em, revogado_em, agencia_membros(nome, email, situacao)")
    .eq("token_hash", hashDoToken(token))
    .maybeSingle();
  const c = data as {
    id: string;
    membro_id: string;
    expira_em: string;
    aceito_em: string | null;
    revogado_em: string | null;
    agencia_membros: { nome: string; email: string; situacao: string } | Array<{ nome: string; email: string; situacao: string }> | null;
  } | null;
  if (!c) return null;
  const m = Array.isArray(c.agencia_membros) ? c.agencia_membros[0] : c.agencia_membros;
  if (!m) return null;
  // Membro desativado depois do convite: o convite morre junto.
  const situacao = m.situacao === "desativado" ? "revogado" : situacaoDoConvite(c, agora);
  return { conviteId: c.id, membroId: c.membro_id, nome: m.nome, email: m.email, situacao };
}

/**
 * O ATO de virar membro: liga a conta ao membro, ativa e fecha o convite.
 * O `update` do convite é condicional (`aceito_em is null`): dois cliques
 * simultâneos não aceitam duas vezes.
 */
export async function fecharConvite(convite: ConviteAberto, userId: string): Promise<boolean> {
  const db = createAdminClient();
  const agora = new Date().toISOString();
  const { data: fechado } = await db
    .from("agencia_convites")
    .update({ aceito_em: agora })
    .eq("id", convite.conviteId)
    .is("aceito_em", null)
    .is("revogado_em", null)
    .select("id");
  if (!fechado || (fechado as unknown[]).length === 0) return false;
  const { error } = await db
    .from("agencia_membros")
    .update({ user_id: userId, situacao: "ativo", ativado_em: agora, desativado_em: null })
    .eq("id", convite.membroId);
  return !error;
}
