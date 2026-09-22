import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ApiTokensClient } from "./_components/ApiTokensClient";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export default async function ApiTokensPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text">API Tokens</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Tokens server-to-server. Plaintext exibido", idioma)}{" "}
          <strong>{traduzir("uma única vez", idioma)}</strong>{" "}
          {traduzir("na criação.", idioma)}
        </p>
      </header>
      <ApiTokensClient />
    </div>
  );
}
