"use client";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { mcpConnectionInstructions, mcpEndpointFromOrigin } from "@/lib/mcp/connection";

export function McpConnectionInfo() {
  const endpoint =
    typeof window === "undefined" ? "/api/mcp" : mcpEndpointFromOrigin(window.location.origin);

  return (
    <section className="rounded-md border bg-muted/20 p-4" aria-labelledby="mcp-connection-title">
      <div className="space-y-1">
        <h2 id="mcp-connection-title" className="font-medium">
          Conectar um agente ao CRM via MCP
        </h2>
        <p className="text-sm text-muted-foreground">
          Use um token com <code>mcp:read</code> para leitura ou <code>mcp:write</code> para ações.
          O token nunca é exibido novamente depois da criação.
        </p>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 break-all rounded-md border bg-background px-3 py-2 text-sm">
          {endpoint}
        </code>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void copyToClipboard(mcpConnectionInstructions(endpoint)).then((ok) => {
              if (ok) toast.success("Instruções MCP copiadas.");
              else toast.error("Não foi possível copiar as instruções.");
            });
          }}
        >
          Copiar instruções
        </Button>
      </div>
    </section>
  );
}
