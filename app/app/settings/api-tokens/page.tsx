import Link from "next/link";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { McpConnectionInfo } from "./_components/McpConnectionInfo";
import { ApiTokensClient } from "./_components/ApiTokensClient";

export const dynamic = "force-dynamic";

export default async function ApiTokensPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);

  if (!activeOrg) {
    return (
      <div className="flex h-full flex-col gap-6 p-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Conexão MCP</h1>
          <p className="text-sm text-muted-foreground">
            O endpoint já está disponível, mas sua conta ainda não tem uma organização ativa.
          </p>
        </header>
        <McpConnectionInfo />
        <p className="text-sm text-muted-foreground">
          Configure sua organização ou aceite um convite antes de solicitar um token MCP.
        </p>
        <Link className="w-fit text-sm text-primary underline underline-offset-4" href="/get-started">
          Configurar minha organização
        </Link>
      </div>
    );
  }

  const canManageTokens = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {canManageTokens ? "API Tokens" : "Conexão MCP"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {canManageTokens
            ? "Tokens server-to-server e conexões MCP. Plaintext exibido uma única vez na criação."
            : "Consulte o endpoint MCP da sua organização. A criação e a revogação de tokens continuam restritas a administradores."}
        </p>
      </header>
      <McpConnectionInfo />
      {canManageTokens ? (
        <ApiTokensClient />
      ) : (
        <p className="text-sm text-muted-foreground">
          Peça a um administrador um token com <code>mcp:read</code> ou <code>mcp:write</code> para
          conectar um agente.
        </p>
      )}
    </div>
  );
}
