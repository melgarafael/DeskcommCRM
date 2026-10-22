/**
 * Quais fluxos publicados da organização entregam conversa a alguém — os que
 * têm o bloco "Distribuir atendimento" na versão em vigor.
 *
 * A tela de Distribuição precisa disso para não deixar dois distribuidores em
 * silêncio: com a empresa em Rodízio ou Menor carga, a conversa ganha dono na
 * chegada e o bloco do fluxo sai por "Distribuído" sem decidir nada. E, no modo
 * "Pelos fluxos de Automações", sem nenhum fluxo assim ninguém recebe nada.
 *
 * Nunca lança: a tela que mostra o aviso não pode cair porque a leitura falhou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export interface FluxoQueDistribui {
  id: string;
  nome: string;
  /** O fluxo está ligado (status `active`) — publicado mas desativado não distribui. */
  ativo: boolean;
}

function temBlocoDeDistribuicao(grafo: unknown): boolean {
  const nos = (grafo as { nodes?: Array<{ type?: unknown }> } | null)?.nodes;
  return Array.isArray(nos) && nos.some((n) => n?.type === "distribute");
}

export async function fluxosQueDistribuem(supabase: SupabaseClient, organizationId: string): Promise<FluxoQueDistribui[]> {
  try {
    const { data: ponteiros, error } = await supabase
      .from("followup_flow_pointers")
      .select("id, name, status, active_version_id")
      .eq("organization_id", organizationId)
      .not("active_version_id", "is", null);
    if (error) throw new Error(error.message);
    const lista = (ponteiros ?? []) as Array<{ id: string; name: string; status: string; active_version_id: string }>;
    if (lista.length === 0) return [];

    const { data: versoes, error: erroVersoes } = await supabase
      .from("followup_flow_versions")
      .select("id, graph")
      .eq("organization_id", organizationId)
      .in(
        "id",
        lista.map((p) => p.active_version_id),
      );
    if (erroVersoes) throw new Error(erroVersoes.message);
    const comDistribuicao = new Set(
      ((versoes ?? []) as Array<{ id: string; graph: unknown }>).filter((v) => temBlocoDeDistribuicao(v.graph)).map((v) => v.id),
    );

    return lista
      .filter((p) => comDistribuicao.has(p.active_version_id))
      .map((p) => ({ id: p.id, nome: p.name, ativo: p.status === "active" }));
  } catch (err) {
    logger.warn("[routing] não consegui listar os fluxos que distribuem", {
      organization_id: organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
