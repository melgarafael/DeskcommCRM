import type { SupabaseClient } from "@supabase/supabase-js";

import type { FlowGraph } from "./graph-schema";

/**
 * O RASCUNHO QUE A TELA DESENHA — e por que ele não pode ser só a coluna.
 *
 * ═══ O defeito, medido numa instalação real ═════════════════════════════════
 *
 * Um fluxo com 23 nós PUBLICADO e ATIVO abria VAZIO no construtor. A versão
 * ativa estava lá, o motor a estava usando, e a tela desenhava nada — porque o
 * canvas lê `draft_graph`, e `draft_graph` era NULL.
 *
 * Isso acontece sempre que a versão nasce por fora do construtor: publicação
 * por script, restauração de backup, importação de outra instalação. O ponteiro
 * ganha `active_version_id` e nunca ganha rascunho.
 *
 * ⚠️ E o estrago não para em "a tela está vazia". `savedGraph` também nascia
 * vazio, então bastava arrastar um nó e salvar para o rascunho virar quase-nada
 * — e o "Publicar" seguinte trocaria o fluxo que está NO AR por esse quase-nada.
 * A tela oferecia publicar por cima de um fluxo que ela não conseguia mostrar.
 *
 * ═══ A regra ═══════════════════════════════════════════════════════════════
 *
 * Rascunho ausente COM versão publicada = a tela abre o que está no ar. É o
 * único significado que não perde trabalho: quem nunca editou tem como
 * rascunho exatamente aquilo que está valendo.
 *
 * Rascunho ausente SEM versão publicada = fluxo novo de verdade, e aí o canvas
 * em branco é a resposta certa.
 */
export async function rascunhoDoFluxo(
  supabase: SupabaseClient,
  pointer: {
    organization_id?: string;
    draft_graph: unknown;
    active_version_id: string | null;
  },
  organizationId: string,
): Promise<FlowGraph | null> {
  if (pointer.draft_graph) return pointer.draft_graph as FlowGraph;
  if (!pointer.active_version_id) return null;

  const { data } = await supabase
    .from("followup_flow_versions")
    .select("graph")
    .eq("id", pointer.active_version_id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  // Falha de leitura devolve null, que é o canvas em branco — o mesmo que
  // acontecia antes. Não é ideal, mas é o desfecho já conhecido: nunca pior.
  return ((data as { graph?: FlowGraph } | null)?.graph as FlowGraph | undefined) ?? null;
}
