import { redirect } from "next/navigation";
import { primeiroInstanteDoDia } from "@/lib/agenda/google/tempo";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerPainelGoogle } from "@/lib/plataformas-de-anuncio/google/ler-painel";
import type { LinhaPainelGoogle } from "@/lib/plataformas-de-anuncio/google/painel";
import { dataIsoNoFuso, somarDiasNoFuso } from "@/lib/propostas/data-no-fuso";
import { createClient } from "@/lib/supabase/server";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { carregarMidiaGoogle, listarContasMidiaGoogle, removerContaMidiaGoogle } from "./actions";
import { MidiaGoogleAds } from "./_components/MidiaGoogleAds";
import { PainelGoogleAds } from "./_components/PainelGoogleAds";
import { VisoesGoogleAds } from "./_components/VisoesGoogleAds";

export const metadata = { title: "Google Ads" };
export const dynamic = "force-dynamic";

const errosDoGoogle: Record<string, string> = {
  cancelado: "Você cancelou a autorização no Google.",
  estado_invalido: "A autorização expirou. Inicie a conexão novamente.",
  sem_codigo: "O Google não devolveu o código esperado. Tente de novo.",
  google_ads_nao_configurado: "Peça ao administrador que configure as credenciais OAuth do Google Ads para consultar campanhas.",
  sem_refresh_token: "O Google não devolveu a autorização de longa duração esperada. Tente conectar de novo.",
  sem_permissao: "O Google recusou o acesso a esta conta. Confira o Customer ID, a conta de gerente (MCC) e se a conta autorizada tem acesso a ela.",
  projeto_sem_acesso: "Solicite acesso de produção à Google Ads API no projeto Google Cloud usado na autorização.",
  conta_indisponivel: "O Google não conseguiu consultar essa conta. Confira os IDs e o acesso do login escolhido.",
  cifra_indisponivel: "A instalação está sem a chave mestra de criptografia.",
  erro_ao_gravar: "Não foi possível salvar a conta de relatório. Tente novamente.",
};

export default async function GoogleAdsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[org.role] < ROLE_RANK.manager) redirect("/403");
  const agora = new Date();
  const fuso = fusoUtilizavel(org.timezone);
  const hoje = dataIsoNoFuso(agora, fuso);
  const inicio = primeiroInstanteDoDia(somarDiasNoFuso(agora, -89, fuso), fuso);
  const fim = primeiroInstanteDoDia(somarDiasNoFuso(agora, 1, fuso), fuso);
  if (!inicio || !fim) throw new Error("Não foi possível determinar o período no fuso da organização.");
  let linhas: LinhaPainelGoogle[] | undefined;
  try {
    linhas = await lerPainelGoogle(await createClient(), org.orgId, inicio.toISOString(), fim.toISOString(), fuso, org.currency);
  } catch {
    // Uma leitura parcial não pode se transformar em zero negócios ou custo por ganho.
    linhas = undefined;
  }
  const atribuicao = linhas ? { linhas, fuso } : undefined;
  const crm = linhas ? <PainelGoogleAds linhas={linhas} hoje={hoje} />
    : <p role="alert">{t("Não foi possível carregar os negócios do CRM. Atualize a página para tentar novamente.")}</p>;
  const lista = await listarContasMidiaGoogle().catch(() => ({
    ok: false as const, detalhe: "Não foi possível carregar as contas de relatório.",
  }));
  const params = await searchParams;
  const midiaAberta = params.aba === "midia";
  const contaDoRetorno = midiaAberta && lista.ok ? lista.contas.find((c) => c.customerId === params.conta) : undefined;
  const erro = midiaAberta && typeof params.erro === "string" && (
    Object.hasOwn(errosDoGoogle, params.erro)
      ? t(errosDoGoogle[params.erro]!)
      : t("Não foi possível autorizar a leitura. Inicie a conexão novamente.")
  );
  const midia = <>
    {erro && <p role="alert" className="mb-3 text-sm text-text">{erro}</p>}
    {!erro && params.ok === "1" && contaDoRetorno?.propria &&
      <p role="status" className="mb-3 text-sm text-text">{t("Conta de leitura conectada.")}</p>}
    {lista.ok ? <MidiaGoogleAds hoje={hoje} atribuicao={atribuicao} contas={lista.contas} contaInicial={contaDoRetorno?.customerId}
      carregar={carregarMidiaGoogle} podeGerenciar={podeAdministrarEmpresa(user, org)} remover={removerContaMidiaGoogle} />
      : <p role="alert">{t(lista.detalhe)}</p>}
  </>;
  return <VisoesGoogleAds crm={crm} midia={midia} inicial={midiaAberta ? "midia" : "crm"} />;
}
