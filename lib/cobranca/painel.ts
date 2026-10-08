import type { SupabaseClient } from "@supabase/supabase-js";

import { lerUsoDaOrganizacao, type UsoDaOrganizacao } from "@/lib/cobranca/uso";
import type { EstadoDaAssinatura } from "@/lib/cobranca/vocabulario";

export interface DadosDoPainel {
  assinatura: { estado: EstadoDaAssinatura; trial_ate: string | null; prazo_extra_ate: string | null } | null;
  plano: {
    nome: string;
    preco_cents: number;
    intervalo: string;
    max_assentos: number | null;
    max_canais: number | null;
    teto_ia_usd_cents: number | null;
  } | null;
  uso: UsoDaOrganizacao;
  /** Na moeda de `fn_gasto_de_ia_do_mes` (centavos de dólar), a régua única de gasto. */
  gastoIaUsdCents: number;
}

/**
 * O que o painel da empresa mostra (spec da cobrança §9). `orgId` vem da
 * sessão (resolveActiveOrg), nunca do corpo. LANÇA em qualquer leitura que
 * falha: o painel não afirma uso nem estado que não leu.
 */
export async function lerPainelDaAssinatura(db: SupabaseClient, orgId: string): Promise<DadosDoPainel> {
  const { data: a, error } = await db
    .from("cobranca_assinaturas")
    .select("plano_id, estado, trial_ate, prazo_extra_ate")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`painel da assinatura: leitura falhou (${error.code})`);

  const [plano, uso, gasto] = await Promise.all([
    a
      ? db
          .from("cobranca_planos")
          .select("nome, preco_cents, intervalo, max_assentos, max_canais, teto_ia_usd_cents")
          .eq("id", a.plano_id)
          .single()
      : Promise.resolve({ data: null, error: null }),
    lerUsoDaOrganizacao(db, orgId),
    db.rpc("fn_gasto_de_ia_do_mes", { p_org: orgId }),
  ]);
  if (plano.error || !uso || gasto.error) throw new Error("painel da assinatura: leitura falhou");

  return {
    assinatura: a ? { estado: a.estado as EstadoDaAssinatura, trial_ate: a.trial_ate, prazo_extra_ate: a.prazo_extra_ate } : null,
    plano: (plano.data ?? null) as DadosDoPainel["plano"],
    uso,
    gastoIaUsdCents: Number(gasto.data ?? 0),
  };
}
