"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { supportWriteError } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { lerCampanhas, lerConexaoGoogleParaApi } from "@/lib/plataformas-de-anuncio/google/api-google-ads";
import { googleAdsEstaConfigurado } from "@/lib/plataformas-de-anuncio/google/config";
import { lerContaDeRelatorio, listarContasDeRelatorio } from "@/lib/plataformas-de-anuncio/google/contas-de-relatorio";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ResumoMidiaGoogle } from "./_components/MidiaGoogleAds";

const customerIdValido = z.string().regex(/^\d{10}$/);

export async function listarContasMidiaGoogle() {
  const acesso = await requireRole("manager", { allowPlatformAdmin: true });
  if (!acesso.ok) return { ok: false as const, detalhe: "Entre com uma conta com permissão para ver os anúncios da organização." };
  return listarContasDeRelatorio(createAdminClient(), acesso.org.orgId);
}

export async function removerContaMidiaGoogle(customerId: string) {
  const acesso = await requireRole("admin", { allowPlatformAdmin: true });
  if (!acesso.ok || !podeAdministrarEmpresa(acesso.user, acesso.org)) {
    return { ok: false as const, detalhe: "Apenas administradores podem remover uma conta de relatório." };
  }
  const restricao = supportWriteError(acesso.user.support);
  if (restricao) return { ok: false as const, detalhe: restricao };
  if (!customerIdValido.safeParse(customerId).success) return { ok: false as const, detalhe: "Conta de anúncios inválida." };
  // O mesmo anunciante pode estar nas conversões. Só a autorização dedicada ao painel é retirada.
  const { data, error } = await createAdminClient().from("google_ads_reporting_accounts").delete()
    .eq("organization_id", acesso.org.orgId).eq("customer_id", customerId).select("customer_id").maybeSingle();
  if (error || !data) return { ok: false as const, detalhe: "Não foi possível remover a conta de relatório." };
  await audit({
    action: "ad_platform_connection.updated", actorUserId: acesso.user.id, organizationId: acesso.org.orgId,
    resourceType: "google_ads_reporting_accounts", resourceId: null,
    metadata: { platform: "google_ads", operacao: "remover_conta_de_relatorio", customer_id: customerId },
  });
  revalidatePath("/app/ads/google");
  return { ok: true as const };
}

export async function carregarMidiaGoogle(periodo: { de: string; ate: string }, customerId?: string): Promise<ResumoMidiaGoogle> {
  const acesso = await requireRole("manager", { allowPlatformAdmin: true });
  if (!acesso.ok) return { ok: false, detalhe: "Entre com uma conta com permissão para ver os anúncios da organização." };
  const janela = z.object({ de: z.iso.date(), ate: z.iso.date() }).safeParse(periodo);
  if (!janela.success || janela.data.de > janela.data.ate ||
    Date.parse(janela.data.ate) - Date.parse(janela.data.de) >= 90 * 86_400_000) {
    return { ok: false, detalhe: "Selecione um período de até 90 dias." };
  }
  const podeConfigurar = podeAdministrarEmpresa(acesso.user, acesso.org);
  if (customerId !== undefined && !customerIdValido.safeParse(customerId).success) {
    return { ok: false, detalhe: "Conta de anúncios inválida." };
  }
  const admin = createAdminClient();
  const conexao = customerId === undefined
    ? await lerConexaoGoogleParaApi(admin, acesso.org.orgId)
    : await lerContaDeRelatorio(admin, acesso.org.orgId, customerId);
  if (!conexao.ok) return { ok: false, detalhe: conexao.detalhe, abrirConfiguracoes: conexao.falha === "sem_conexao" ? podeConfigurar : undefined };
  // A conexão para enviar conversões pelo Data Manager pode funcionar sem as credenciais de relatórios.
  if (!googleAdsEstaConfigurado("relatorio")) return {
    ok: false,
    detalhe: "Peça ao administrador que configure as credenciais OAuth do Google Ads para consultar campanhas.",
  };
  const resposta = await lerCampanhas(conexao.dados, janela.data);
  if (!resposta.ok) return { ok: false, detalhe: resposta.detalhe, abrirConfiguracoes: resposta.falha === "reconectar" || resposta.falha === "sem_permissao" ? podeConfigurar : undefined };
  return { ok: true, contaId: conexao.dados.customerId, campanhas: resposta.dados };
}
