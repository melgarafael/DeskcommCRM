import type { SupabaseClient } from "@supabase/supabase-js";

import { lerUsoDaOrganizacao, type UsoDaOrganizacao } from "@/lib/cobranca/uso";
import type { EstadoDaAssinatura, Modo } from "@/lib/cobranca/vocabulario";

export interface AssinaturaDoPainel {
  estado: EstadoDaAssinatura;
  trial_ate: string | null;
  prazo_extra_ate: string | null;
  proximo_vencimento: string | null;
  vencida_desde: string | null;
  cancela_no_fim: boolean;
  modo: Modo | null;
  provedor: string | null;
  link_de_pagamento: string | null;
  assinaturas_vivas: number;
  plano_agendado: { id: string; nome: string } | null;
}

export interface PlanoParaTroca {
  id: string;
  nome: string;
  preco_cents: number;
  intervalo: string;
}

export interface DadosDoPainel {
  assinatura: AssinaturaDoPainel | null;
  plano: {
    id: string;
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
  /** Planos ativos e oferecidos às empresas, do MESMO intervalo, fora o atual (a troca não muda o intervalo). */
  planosParaTroca: PlanoParaTroca[];
  /** IANA da empresa (`organizations.timezone`): as datas do painel e do recado saem nele. */
  fuso: string | null;
}

interface PlanoLido extends PlanoParaTroca {
  max_assentos: number | null;
  max_canais: number | null;
  teto_ia_usd_cents: number | null;
  arquivado_em: string | null;
  /** false = plano negociado: só o dono atribui (Task 4A), a empresa não o vê na troca. */
  oferecido_ao_cliente: boolean;
}

/**
 * O que o painel da empresa mostra (spec da cobrança §9). `orgId` vem da
 * sessão, nunca do corpo. LANÇA em qualquer leitura que falha: o painel não
 * afirma uso nem estado que não leu. `cobranca_planos` é da instalação (sem
 * `organization_id`): a lista toda é pequena e alimenta a troca de plano.
 */
export async function lerPainelDaAssinatura(db: SupabaseClient, orgId: string): Promise<DadosDoPainel> {
  const { data: a, error } = await db
    .from("cobranca_assinaturas")
    .select(
      "plano_id, plano_agendado_id, estado, trial_ate, prazo_extra_ate, proximo_vencimento, vencida_desde, cancela_no_fim, modo, provedor, link_de_pagamento, assinaturas_vivas",
    )
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`painel da assinatura: leitura falhou (${error.code})`);

  const [planos, uso, gasto, org] = await Promise.all([
    db
      .from("cobranca_planos")
      .select("id, nome, preco_cents, intervalo, max_assentos, max_canais, teto_ia_usd_cents, arquivado_em, oferecido_ao_cliente"),
    lerUsoDaOrganizacao(db, orgId),
    db.rpc("fn_gasto_de_ia_do_mes", { p_org: orgId }),
    db.from("organizations").select("timezone").eq("id", orgId).maybeSingle(),
  ]);
  if (planos.error || !uso || gasto.error || org.error) throw new Error("painel da assinatura: leitura falhou");

  const todos = (planos.data ?? []) as PlanoLido[];
  const plano = a ? (todos.find((p) => p.id === a.plano_id) ?? null) : null;
  const agendado = a?.plano_agendado_id ? (todos.find((p) => p.id === a.plano_agendado_id) ?? null) : null;
  return {
    assinatura: a
      ? {
          estado: a.estado as EstadoDaAssinatura,
          trial_ate: a.trial_ate,
          prazo_extra_ate: a.prazo_extra_ate,
          proximo_vencimento: a.proximo_vencimento,
          vencida_desde: a.vencida_desde,
          cancela_no_fim: a.cancela_no_fim,
          modo: a.modo as Modo | null,
          provedor: a.provedor,
          link_de_pagamento: a.link_de_pagamento,
          assinaturas_vivas: a.assinaturas_vivas,
          plano_agendado: agendado ? { id: agendado.id, nome: agendado.nome } : null,
        }
      : null,
    plano: plano
      ? {
          id: plano.id, nome: plano.nome, preco_cents: plano.preco_cents, intervalo: plano.intervalo,
          max_assentos: plano.max_assentos, max_canais: plano.max_canais, teto_ia_usd_cents: plano.teto_ia_usd_cents,
        }
      : null,
    uso,
    gastoIaUsdCents: Number(gasto.data ?? 0),
    fuso: (org.data as { timezone: string | null } | null)?.timezone ?? null,
    planosParaTroca: plano
      ? todos
          .filter((p) => p.arquivado_em === null && p.oferecido_ao_cliente && p.intervalo === plano.intervalo && p.id !== plano.id)
          .map((p) => ({ id: p.id, nome: p.nome, preco_cents: p.preco_cents, intervalo: p.intervalo }))
      : [],
  };
}
