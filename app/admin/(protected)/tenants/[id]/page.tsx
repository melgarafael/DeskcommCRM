import { z } from "zod";

import { CartaoDaIaDoMolde, type IaDoMolde } from "@/components/admin/tenants/CartaoDaIaDoMolde";
import {
  CardDeCobranca,
  type AssinaturaDoCard,
  type PlanoDoCard,
} from "@/components/admin/tenants/CardDeCobranca";
import { provedorDaInstalacao } from "@/lib/cobranca/configuracao";
import { exigeDocumento, sugestaoDoCadastro } from "@/lib/cobranca/documento";
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { loadAuthUser } from "@/lib/auth/server";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

import { TenantOverviewClient } from "./_client";

interface TenantDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function TenantDetailPage({ params }: TenantDetailPageProps) {
  const { id } = await params;
  const [cobranca, iaDoMolde] = await Promise.all([lerCobrancaDoTenant(id), lerIaDoMolde(id)]);
  return (
    <div className="space-y-6">
      <TenantOverviewClient id={id} cobrancaLigada={cobranca !== null} />
      {iaDoMolde && <CartaoDaIaDoMolde ia={iaDoMolde} />}
      {cobranca && <CardDeCobranca orgId={id} {...cobranca} />}
    </div>
  );
}

/**
 * A empresa nasceu com a IA do molde da instalação (migration 9096)? A fonte é
 * a linha `ai.molde_de_ia_aplicado` que o gatilho gravou na auditoria DELA.
 * `null` = não nasceu (ou a leitura falhou): sem cartão, a página fica como era
 * — o cartão é informação, e não vale um 500.
 */
async function lerIaDoMolde(orgId: string): Promise<IaDoMolde | null> {
  if (!z.string().uuid().safeParse(orgId).success) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_audit_log")
    .select("created_at, metadata")
    .eq("organization_id", orgId)
    .eq("action", "ai.molde_de_ia_aplicado")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const meta = (data.metadata ?? {}) as {
    molde_org_id?: unknown;
    funcoes_copiadas?: unknown;
    padrao?: { default_model?: unknown } | null;
  };
  let nomeDoMolde: string | null = null;
  if (typeof meta.molde_org_id === "string") {
    const { data: moldeOrg } = await admin
      .from("organizations")
      .select("display_name")
      .eq("id", meta.molde_org_id)
      .maybeSingle();
    nomeDoMolde = (moldeOrg as { display_name?: string | null } | null)?.display_name?.trim() || null;
  }
  const usuario = await loadAuthUser();
  return {
    nomeDoMolde,
    funcoes: typeof meta.funcoes_copiadas === "number" ? meta.funcoes_copiadas : 0,
    padrao: typeof meta.padrao?.default_model === "string" ? meta.padrao.default_model : null,
    // Formatado AQUI, com fuso fixo: no cliente, o HTML servido e a hidratação
    // divergiriam. Mesmo motivo e mesma escolha de `/admin/sistema`.
    quando: new Date(data.created_at as string).toLocaleString(tagDeIdioma(usuario?.idioma ?? normalizarIdioma(null)), {
      timeZone: "America/Sao_Paulo",
      dateStyle: "short",
      timeStyle: "short",
    }),
  };
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
  const [planos, assinatura, org, daInstalacao] = await Promise.all([
    admin.from("cobranca_planos").select("id, nome, arquivado_em").order("nome"),
    admin
      .from("cobranca_assinaturas")
      .select("plano_id, estado, trial_ate, prazo_extra_ate, provedor, plano_agendado_id, proximo_vencimento, provedor_cliente_id")
      .eq("organization_id", orgId)
      .maybeSingle(),
    admin.from("organizations").select("status, suspended_kind, settings, cnpj").eq("id", orgId).maybeSingle(),
    provedorDaInstalacao(),
  ]);
  if (planos.error || assinatura.error || org.error) {
    throw new Error(`cobrança do tenant: leitura falhou (${planos.error?.code ?? assinatura.error?.code ?? org.error?.code})`);
  }
  const rotulo = (org.data?.settings as { plan?: unknown } | null)?.plan;
  // O id do cliente no provedor decide só se o documento é pedido; não vai ao componente de cliente.
  const { provedor_cliente_id: clienteNoProvedor, ...semIdDoProvedor } = assinatura.data ?? { provedor_cliente_id: null };
  return {
    planos: (planos.data ?? []) as PlanoDoCard[],
    assinatura: (assinatura.data ? semIdDoProvedor : null) as AssinaturaDoCard | null,
    pedeDocumento: exigeDocumento(
      ((assinatura.data?.provedor ?? daInstalacao) as ProvedorDeCobranca | null),
      clienteNoProvedor !== null,
    ),
    documentoDoCadastro: sugestaoDoCadastro(org.data?.cnpj ?? null),
    suspensaPorCobranca: org.data?.status === "suspended" && org.data?.suspended_kind === "cobranca",
    rotuloAntigo: typeof rotulo === "string" && rotulo !== "" ? rotulo : null,
  };
}
