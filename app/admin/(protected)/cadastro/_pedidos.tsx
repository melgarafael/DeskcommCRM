"use client";

import { useState, useTransition } from "react";

import { decideRegistrationRequest } from "@/app/actions/registration/decide";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import type { PedidoPendente } from "@/lib/auth/registration-requests";

const ERROS: Record<string, string> = {
  not_found: "Este pedido já foi decidido.",
  account_unavailable: "A conta deste pedido não existe mais ou ainda não confirmou o e-mail.",
};

/**
 * A fila do modo `com_aprovacao` (migration 0383). Aprovar cria a empresa e
 * torna quem pediu administrador dela; recusar é final para aquela conta.
 * Depois da decisão a action revalida a página, e a linha some da lista.
 */
export function PedidosPendentes({ pedidos }: { pedidos: PedidoPendente[] }) {
  const t = useT();
  const [erro, setErro] = useState<string | null>(null);
  const [emCurso, startTransition] = useTransition();

  function decidir(requestId: string, decision: "approve" | "reject") {
    setErro(null);
    startTransition(async () => {
      const r = await decideRegistrationRequest({ requestId, decision });
      if (!r.ok) setErro(t(ERROS[r.error] ?? "Não deu para salvar. Tente de novo em instantes."));
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Pedidos aguardando aprovação")}</CardTitle>
        <CardDescription>
          {t("Aprovar cria a empresa e torna quem pediu administrador dela.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {pedidos.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("Nenhum pedido aguardando.")}</p>
        )}
        {pedidos.map((pedido) => (
          <div
            key={pedido.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="truncate font-medium">{pedido.organizationName}</p>
              <p className="truncate text-sm text-muted-foreground">{pedido.email ?? "—"}</p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={emCurso}
                onClick={() => decidir(pedido.id, "reject")}
              >
                {t("Recusar")}
              </Button>
              <Button size="sm" disabled={emCurso} onClick={() => decidir(pedido.id, "approve")}>
                {t("Aprovar")}
              </Button>
            </div>
          </div>
        ))}
        {erro && (
          <p className="text-sm text-destructive" role="alert">
            {erro}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
