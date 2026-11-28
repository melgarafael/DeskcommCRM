/**
 * O total de uma proposta enviada vira o valor do negócio, a menos que o negócio
 * já tenha venda registrada (#5254).
 *
 * Com venda (`crm_leads.valor_pelas_vendas = true`, migration 9450), `value_cents`
 * é a soma das vendas, gravada pelo gatilho em `vendas_registradas`, que não
 * dispara num UPDATE de `crm_leads`. Gravar o total da proposta por cima deixava
 * o card com um número e o painel de vendas com outro até a próxima mudança numa
 * venda. É a mesma regra que o PATCH do lead aplica (`app/api/v1/leads/_handler.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Grava `totalCents` como valor do negócio quando ele não é calculado pelas vendas.
 * Devolve se alguma linha mudou: quem chama só registra `proposal_value_changed`
 * quando o valor de fato mudou.
 */
export async function gravarValorDaPropostaNoNegocio(
  admin: SupabaseClient,
  alvo: { organizationId: string; leadId: string; totalCents: number },
): Promise<boolean> {
  const { data } = await admin
    .from("crm_leads")
    .update({ value_cents: alvo.totalCents })
    .eq("organization_id", alvo.organizationId)
    .eq("id", alvo.leadId)
    .eq("valor_pelas_vendas", false)
    .select("id");
  return (data?.length ?? 0) > 0;
}
