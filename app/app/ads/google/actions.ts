"use server";

import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { lerCampanhas, lerConexaoGoogleParaApi } from "@/lib/plataformas-de-anuncio/google/api-google-ads";
import { googleAdsEstaConfigurado } from "@/lib/plataformas-de-anuncio/google/config";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ResumoMidiaGoogle } from "./_components/MidiaGoogleAds";

export async function carregarMidiaGoogle(periodo: { de: string; ate: string }): Promise<ResumoMidiaGoogle> {
  const acesso = await requireRole("manager", { allowPlatformAdmin: true });
  if (!acesso.ok) return { ok: false, detalhe: "Entre com uma conta com permissão para ver os anúncios da organização." };
  const janela = z.object({ de: z.iso.date(), ate: z.iso.date() }).safeParse(periodo);
  if (!janela.success || janela.data.de > janela.data.ate ||
    Date.parse(janela.data.ate) - Date.parse(janela.data.de) >= 90 * 86_400_000) {
    return { ok: false, detalhe: "Selecione um período de até 90 dias." };
  }
  const podeConfigurar = podeAdministrarEmpresa(acesso.user, acesso.org);
  const conexao = await lerConexaoGoogleParaApi(createAdminClient(), acesso.org.orgId);
  if (!conexao.ok) return { ok: false, detalhe: conexao.detalhe, abrirConfiguracoes: conexao.falha === "sem_conexao" ? podeConfigurar : undefined };
  // A conexão para enviar conversões pelo Data Manager pode funcionar sem as credenciais de relatórios.
  if (!googleAdsEstaConfigurado("google_ads")) return {
    ok: false,
    detalhe: "As credenciais da instalação para consultar campanhas estão incompletas. Peça ao administrador que confira as credenciais OAuth e o GOOGLE_ADS_DEVELOPER_TOKEN.",
  };
  const resposta = await lerCampanhas(conexao.dados, janela.data);
  if (!resposta.ok) return { ok: false, detalhe: resposta.detalhe, abrirConfiguracoes: resposta.falha === "reconectar" || resposta.falha === "sem_permissao" ? podeConfigurar : undefined };
  return { ok: true, contaId: conexao.dados.customerId, campanhas: resposta.dados };
}
