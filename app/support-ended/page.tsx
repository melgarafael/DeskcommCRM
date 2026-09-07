import { traduzir } from "@/lib/i18n/dicionario";
import { redirect } from "next/navigation";
import { loadAuthUser } from "@/lib/auth/server";
import { ImpersonateBanner } from "@/components/app/ImpersonateBanner";
export default async function SupportEndedPage() {
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  const t = (text: string) => traduzir(text, user.idioma);
  if (!user.support) redirect("/app/inbox");
  return <main className="min-h-screen bg-background">
    <ImpersonateBanner ended impersonating={{tenantId: user.support.organization_id,
      tenantName: user.support.name, expiresAt: user.support.expires_at}} />
    <div className="mx-auto max-w-xl p-8"><h1 className="text-xl font-semibold">{t("Encerre o acompanhamento para continuar")}</h1>
    <p className="mt-3 text-muted-foreground">{t("O prazo ou as permissões desta sessão mudaram. Saia do acompanhamento para voltar à sua organização.")}</p></div>
  </main>;
}
