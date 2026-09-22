"use client";

import * as React from "react";
import Link from "next/link";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import {
  badgeDaOrigem,
  ROTULO_DO_STATUS,
  type PedidoComercial,
  type StatusDoPedido,
} from "@/lib/schemas/pedidos";
import { comoMoeda, numeroDoPedido } from "@/lib/format/moeda";

/**
 * Aba COMPRAS da ficha 360° — o histórico de pedidos do cliente.
 *
 * Lê a mesma API da lista de pedidos, filtrada por contato. O link "ver
 * todos" leva à lista (o filtro por contato mora na URL da API, não na tela).
 */
export function ComprasDoContato({ contactId }: { contactId: string }) {
  const t = useT();
  const [pedidos, setPedidos] = React.useState<PedidoComercial[] | null>(null);

  React.useEffect(() => {
    let vivo = true;
    apiClient
      .get<{ data: PedidoComercial[] }>(`/api/v1/commercial-orders?contact_id=${contactId}`)
      .then((corpo) => {
        // O envelope é `{ data }` — sem desembrulhar, o objeto cai no estado
        // e o `.filter` abaixo explode (medido em produção).
        if (vivo) setPedidos(Array.isArray(corpo.data) ? corpo.data : []);
      })
      .catch((e) => {
        if (!vivo) return;
        showApiError(e);
        setPedidos([]);
      });
    return () => {
      vivo = false;
    };
  }, [contactId]);

  if (pedidos === null) {
    return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  }

  if (pedidos.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        {t("Nenhum pedido deste cliente ainda.")}
      </Card>
    );
  }

  const total = pedidos
    .filter((p) => p.status !== "cancelado")
    .reduce((s, p) => s + p.total_cents, 0);

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">
          {t("Total comprado (sem cancelados)")}
        </p>
        <p className="text-2xl font-semibold">{comoMoeda(total, "BRL")}</p>
      </Card>
      <ul className="divide-y rounded-lg border">
        {pedidos.map((p) => {
          const badge = badgeDaOrigem(p.origem);
          return (
            <li key={p.id} className="flex items-center gap-4 p-3 text-sm transition-colors hover:bg-muted/50">
              <Link
                href={`/app/pedidos/${p.id}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
                aria-label={`${t("Ver pedido")} ${numeroDoPedido(p.numero)}`}
              >
                {numeroDoPedido(p.numero)}
              </Link>
              <span className="text-muted-foreground">
                {new Date(p.created_at).toLocaleDateString()}
              </span>
              <span>{ROTULO_DO_STATUS[p.status as StatusDoPedido] ?? p.status}</span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.classe}`}
              >
                {badge.rotulo}
              </span>
              <span className="ml-auto font-medium">{comoMoeda(p.total_cents, p.moeda)}</span>
            </li>
          );
        })}
      </ul>
      <Link href="/app/pedidos" className="text-sm underline underline-offset-4">
        {t("Ver todos os pedidos")}
      </Link>
    </div>
  );
}
