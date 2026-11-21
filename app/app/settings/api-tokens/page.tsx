import { redirect } from "next/navigation";

import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ApiTokensClient } from "./_components/ApiTokensClient";
import { traduzir } from "@/lib/i18n/dicionario";
import { enderecosOAuth } from "@/lib/mcp/oauth/config";

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
      <CabecalhoDaSubTela titulo={traduzir("API Tokens", idioma)} idioma={idioma}>
        <p className="text-sm text-muted-foreground">
          {traduzir("Tokens server-to-server. Plaintext exibido", idioma)}{" "}
          <strong>{traduzir("uma única vez", idioma)}</strong>{" "}
          {traduzir("na criação.", idioma)}
        </p>
      </CabecalhoDaSubTela>
      {/*
        A PORTA do OAuth do MCP (migration 9390). Quem usa ChatGPT não tem onde
        colar um token: o aplicativo só oferece OAuth. Esta nota diz o endereço
        e que a conexão aparece na lista abaixo como "(OAuth)" — revogar ali a
        desliga na próxima renovação.
      */}
      <section
        className="rounded-md border px-4 py-3 text-sm"
        data-testid="mcp-oauth-instrucao"
      >
        <p className="font-medium">{traduzir("Conectar o ChatGPT ou outro aplicativo de MCP", idioma)}</p>
        <p className="text-muted-foreground">
          {traduzir("No aplicativo, adicione um servidor MCP com o endereço", idioma)}{" "}
          <code className="rounded-md bg-muted px-1">{enderecosOAuth().recurso}</code>{" "}
          {traduzir("e escolha a autenticação OAuth. Você entra com a sua conta do CRM e decide se ele só lê ou também altera dados. A conexão aparece nesta lista com \"(OAuth)\" no nome; revogar a desliga. A data em Expira é a do acesso em uso, renovado sozinho a cada hora.", idioma)}
        </p>
      </section>
      <ApiTokensClient />
    </div>
  );
}
