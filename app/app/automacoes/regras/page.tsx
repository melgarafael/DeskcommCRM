import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { RulesTab } from "@/app/app/webhooks/_components/RulesTab";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Regras" };

/**
 * Automações › Regras — as regras QUANDO/SE/ENTÃO. Moravam numa aba da tela de
 * Webhooks; a lista é o mesmo componente (`RulesTab`) e o designer de cada regra
 * vive em `./[id]`. Mesma régua da tela antiga: só gerente ou administrador.
 */
export default async function RegrasPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const canManage = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  if (!canManage) redirect("/app/inbox");
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Regras", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Quando algo acontece, se a condição bate, então o sistema age sozinho.",
            idioma,
          )}
        </p>
      </header>
      <RulesTab />
    </div>
  );
}
