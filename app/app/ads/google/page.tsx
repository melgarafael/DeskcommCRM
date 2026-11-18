import { redirect } from "next/navigation";
import { primeiroInstanteDoDia } from "@/lib/agenda/google/tempo";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerPainelGoogle } from "@/lib/plataformas-de-anuncio/google/ler-painel";
import type { LinhaPainelGoogle } from "@/lib/plataformas-de-anuncio/google/painel";
import { dataIsoNoFuso, somarDiasNoFuso } from "@/lib/propostas/data-no-fuso";
import { createClient } from "@/lib/supabase/server";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { carregarMidiaGoogle } from "./actions";
import { MidiaGoogleAds } from "./_components/MidiaGoogleAds";
import { PainelGoogleAds } from "./_components/PainelGoogleAds";
import { VisoesGoogleAds } from "./_components/VisoesGoogleAds";

export const metadata = { title: "Google Ads" };
export const dynamic = "force-dynamic";

export default async function GoogleAdsPage() {
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
  return <VisoesGoogleAds crm={crm} midia={<MidiaGoogleAds hoje={hoje} carregar={carregarMidiaGoogle} atribuicao={atribuicao} />} />;
}
