import type { SupabaseClient } from "@supabase/supabase-js";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";

/** A empresa ligou a apresentação do catálogo? Nunca lança: erro = desligada. */
export async function apresentacaoDoCatalogoLigada(
  admin: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  return (await capacidadesDaOrganizacao(admin, organizationId)).includes("apresentacao_do_catalogo");
}

/**
 * Oferecer `present_catalog_items` neste turno? Só com a capacidade ligada E ao
 * menos uma apresentação ativa: ferramenta que só pode recusar gasta passo do
 * modelo. A capacidade vem primeiro para a empresa desligada não pagar a consulta.
 *
 * Erro de banco fecha a porta e o turno segue pelas outras ferramentas: o recurso
 * opcional não pode derrubar o atendimento.
 */
export async function apresentacaoOferecidaNoTurno(
  admin: SupabaseClient,
  db: Queryable,
  organizationId: string,
  log: { warn: (mensagem: string, contexto?: Record<string, unknown>) => void },
): Promise<boolean> {
  if (!(await apresentacaoDoCatalogoLigada(admin, organizationId))) return false;
  try {
    const { rows } = await db.query<{ ativa: boolean }>(
      `select exists(
         select 1 from catalog_product_presentations
          where organization_id = $1 and enabled
       ) as ativa`,
      [organizationId],
    );
    return rows[0]?.ativa === true;
  } catch (erro) {
    log.warn("apresentação do catálogo: consulta falhou, ferramenta não oferecida", {
      erro: erro instanceof Error ? erro.message.slice(0, 120) : String(erro),
    });
    return false;
  }
}
