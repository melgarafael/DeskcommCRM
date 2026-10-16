import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { SocialInsightsClient } from "./_components/SocialInsightsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Insights das Redes Sociais" };

export default async function SocialInsightsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  // Requer papel mínimo de viewer (para visualização) ou manager (para sincronizar/conectar)
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.viewer) {
    redirect("/403");
  }

  const podeGerenciar = (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Insights das Redes Sociais")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Acompanhe o alcance, impressões, novos seguidores e engajamento das suas páginas do Instagram e Facebook.")}
        </p>
      </header>

      <SocialInsightsClient podeGerenciar={podeGerenciar} />
    </div>
  );
}
