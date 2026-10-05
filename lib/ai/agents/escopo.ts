/**
 * O ESCOPO DE UMA VERSÃO APONTA PARA COISAS QUE EXISTEM.
 *
 * `pipeline_ids` e `knowledge_source_ids` são arrays de uuid no corpo da versão,
 * e o Zod que os valida é COMPARTILHADO COM O BROWSER — ele confere formato, não
 * existência, porque um schema que roda no cliente não faz consulta cross-row.
 * O cabeçalho de `validation.ts` diz isso desde a 0125 e promete que "a
 * validação de que o funil existe mora no servidor". Ela nunca foi escrita.
 *
 * O que a ausência produz não é um erro: é uma configuração muda. Um id de outra
 * organização (ou de um material apagado) entra no array, a versão é publicada,
 * e o assistente simplesmente não acha nada — sem erro, sem aviso, com a tela
 * mostrando a marcação como se estivesse valendo.
 *
 * Falha FECHADA na ação (recusa a publicação) e ABERTA na informação (diz qual
 * id não existe): o operador tem de conseguir consertar sem adivinhar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface EscopoDaVersao {
  pipeline_ids?: string[];
  knowledge_source_ids?: string[];
  /** `null`/ausente = a chave da instalação; não há o que conferir. */
  credential_id?: string | null;
  channel_session_id?: string | null;
}

export type ResultadoDoEscopo =
  | { ok: true }
  | {
      ok: false;
      campo: "pipeline_ids" | "knowledge_source_ids" | "credential_id" | "channel_session_id";
      ausentes: string[];
    };

/**
 * Confere que todo id do escopo existe NESTA organização.
 *
 * Recebe o client do CHAMADOR de propósito: com o client do usuário a RLS já
 * filtra por organização, e com o admin o filtro programático abaixo faz o mesmo
 * trabalho. Os dois caminhos chegam à mesma resposta.
 */
export async function validarEscopoDaVersao(
  supabase: SupabaseClient,
  organizationId: string,
  escopo: EscopoDaVersao,
): Promise<ResultadoDoEscopo> {
  const funis = escopo.pipeline_ids ?? [];
  if (funis.length > 0) {
    const { data } = await supabase
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", organizationId)
      .in("id", funis);
    const achados = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    const ausentes = funis.filter((id) => !achados.has(id));
    if (ausentes.length > 0) return { ok: false, campo: "pipeline_ids", ausentes };
  }

  const materiais = escopo.knowledge_source_ids ?? [];
  if (materiais.length > 0) {
    // `is_active` entra na conferência: marcar material ARQUIVADO é a mesma
    // configuração muda de marcar um que não existe — o agente não acha nada
    // nele, porque a busca filtra fonte inativa.
    const { data } = await supabase
      .from("ai_knowledge_sources")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .in("id", materiais);
    const achados = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    const ausentes = materiais.filter((id) => !achados.has(id));
    if (ausentes.length > 0) return { ok: false, campo: "knowledge_source_ids", ausentes };
  }

  // Credencial e canal são referências únicas, e a FK do banco só confere que
  // a linha EXISTE — não que é desta organização. "De outra organização" e
  // "não existe" dão a mesma resposta de propósito.
  const referencias = [
    ["credential_id", "ai_provider_credentials", escopo.credential_id],
    ["channel_session_id", "channel_sessions", escopo.channel_session_id],
  ] as const;
  for (const [campo, tabela, id] of referencias) {
    if (!id) continue;
    const { data } = await supabase
      .from(tabela)
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
    if (!data) return { ok: false, campo, ausentes: [id] };
  }

  return { ok: true };
}

/** Frase para quem lê na tela — nunca o id cru sem contexto. */
export function mensagemDoEscopo(r: Extract<ResultadoDoEscopo, { ok: false }>): string {
  switch (r.campo) {
    case "pipeline_ids":
      return `Um dos funis marcados não existe mais nesta organização (${r.ausentes.length}). Recarregue a página e marque de novo.`;
    case "knowledge_source_ids":
      return `Um dos materiais marcados não existe mais, ou foi arquivado (${r.ausentes.length}). Recarregue a página e marque de novo.`;
    case "credential_id":
      return "A credencial escolhida não existe nesta organização. Recarregue a página e escolha de novo.";
    case "channel_session_id":
      return "A conexão escolhida não existe nesta organização. Recarregue a página e escolha de novo.";
  }
}
