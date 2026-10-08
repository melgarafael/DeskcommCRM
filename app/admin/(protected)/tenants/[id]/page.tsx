import { z } from "zod";

import {
  CardDeCobranca,
  type AssinaturaDoCard,
  type PlanoDoCard,
} from "@/components/admin/tenants/CardDeCobranca";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

import { TenantOverviewClient } from "./_client";

interface TenantDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function TenantDetailPage({ params }: TenantDetailPageProps) {
  const { id } = await params;
  const cobranca = await lerCobrancaDoTenant(id);
  return (
    <div className="space-y-6">
      <TenantOverviewClient id={id} cobrancaLigada={cobranca !== null} />
      {cobranca && <CardDeCobranca orgId={id} {...cobranca} />}
    </div>
  );
}

/**
 * O card Cobrança (spec da cobrança §9). `null` = a chave está desligada: a
 * página fica como sempre foi. Leitura que falha LANÇA: o card não mostra
 * "isenta" de uma empresa cuja assinatura ninguém leu. O platform admin é
 * conferido pelo layout desta rota.
 */
async function lerCobrancaDoTenant(orgId: string) {
  // Id que não é uuid daria 22P02 no PostgREST e esta página LANÇARIA (500);
  // sem card, o TenantOverviewClient já mostra "não foi possível carregar".
  if (!z.string().uuid().safeParse(orgId).success) return null;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) return null;
  const [planos, assinatura, org] = await Promise.all([
    admin.from("cobranca_planos").select("id, nome, arquivado_em").order("nome"),
    admin
      .from("cobranca_assinaturas")
      .select("plano_id, estado, trial_ate, prazo_extra_ate, provedor")
      .eq("organization_id", orgId)
      .maybeSingle(),
    admin.from("organizations").select("status, suspended_kind, settings").eq("id", orgId).maybeSingle(),
  ]);
  if (planos.error || assinatura.error || org.error) {
    throw new Error(`cobrança do tenant: leitura falhou (${planos.error?.code ?? assinatura.error?.code ?? org.error?.code})`);
  }
  const rotulo = (org.data?.settings as { plan?: unknown } | null)?.plan;
  return {
    planos: (planos.data ?? []) as PlanoDoCard[],
    assinatura: (assinatura.data ?? null) as AssinaturaDoCard | null,
    suspensaPorCobranca: org.data?.status === "suspended" && org.data?.suspended_kind === "cobranca",
    rotuloAntigo: typeof rotulo === "string" && rotulo !== "" ? rotulo : null,
  };
}
