/**
 * O negócio ABERTO do contato num funil — o DEGRAU que a automação (#958, #992)
 * e a captação por webhook (#3101) compartilham.
 *
 * ## Por que ele mora aqui, e não dentro de quem chama
 *
 * "O card aberto do contato neste funil" é a pergunta que decide DUAS coisas
 * que precisam concordar: a ação `create_or_move_lead` de um gatilho de contato
 * move esse card em vez de abrir outro (#958), e a captação por webhook passa a
 * atualizá-lo em vez de abrir um terceiro card com o mesmo contato (#3101).
 * Duas implementações da mesma pergunta divergem na primeira mudança de uma
 * delas — foi assim que o contato chegou a três cards abertos no mesmo funil —,
 * então a consulta é uma só.
 *
 * ## O que ele NÃO é
 *
 * Só o MESMO funil. O negócio do contato em outro funil não é movido de etapa
 * (mover entre funis é recusado, ver `transfere-para-o-funil`); quem trata esse
 * caso é `negocioAbertoEmOutroFunil`, na ação.
 *
 * O mais recente primeiro, para o desempate ser estável quando o contato tem
 * mais de um card aberto ali (estado que esta função existe justamente para não
 * multiplicar). Leitura que falha devolve `null` — quem chama decide o que
 * fazer com a ausência, e o caminho de hoje é criar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O que a linha do negócio traz de volta.
 *
 * `custom_fields` e `title` descem junto porque a captação COMPARA com o que o
 * envio trouxe antes de escrever (#3101): escrever o objeto inteiro desfaria a
 * edição manual de quem atende, que é a mesma razão do portão da opção irmã
 * (#2316).
 */
export interface NegocioAbertoNoFunil {
  id: string;
  contact_id: string | null;
  title: string | null;
  custom_fields: Record<string, unknown>;
  stage_id: string | null;
  /**
   * O `external_id` que JÁ identifica este card, ou `null` para um card sem
   * identidade de integração (#3366).
   *
   * A captação por webhook lê isto para decidir se o card é ADOTÁVEL: dois ids
   * para o mesmo contato são dois cards por desenho (#2316 — o id é o que
   * identifica o card), então um card que já responde por um id não é reescrito
   * por outro. Quem chama e não precisa do campo simplesmente o ignora.
   */
  external_id: string | null;
  /** A fonte de webhook dona do card, ou `null` (card da conversa, manual...). */
  webhook_source_id: string | null;
}

export async function negocioAbertoDoContato(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  pipelineId: string,
): Promise<NegocioAbertoNoFunil | null> {
  const { data } = await admin
    .from("crm_leads")
    .select("id, contact_id, title, custom_fields, stage_id, external_id, webhook_source_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("pipeline_id", pipelineId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as NegocioAbertoNoFunil | null) ?? null;
}
