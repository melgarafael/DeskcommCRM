import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { RequestsTable } from "./RequestsTable";

export const dynamic = "force-dynamic";

export default async function LgpdRequestsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);

  if (!activeOrg) redirect("/app");

  // Permission: role >= admin OR platform_admin (lgpd:execute)
  const isAllowed =
    (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  if (!isAllowed) redirect("/app");

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Solicitações LGPD")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Anonimizações e solicitações de dados de titulares. Apenas admins.")}
        </p>
      </header>
      <RequestsTable />
    </div>
  );
}
