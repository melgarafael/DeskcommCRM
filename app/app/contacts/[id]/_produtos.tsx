"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { comoMoeda } from "@/lib/format/moeda";
import type { ItemDoPedido } from "@/lib/schemas/pedidos";
import { NexusEmptyState } from "@/components/nexus-ui/feedback/NexusEmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Storefront } from "@/lib/ui/icons";

interface ProdutoAgregado {
  nome: string;
  codigo: string;
  qtd: number;
  total: number;
  ultimaCompra: string;
}

/**
 * Aba PRODUTOS do 360°: o que o cliente compra, agregado dos itens dos
 * pedidos recentes (não-cancelados). Cap de 5 pedidos detalhados — agregado
 * de recompra, não auditoria item a item.
 */
export function ProdutosDoContato({ contactId }: { contactId: string }) {
  const t = useT();
  const pedidos = useQuery({
    queryKey: ["contato", contactId, "pedidos"],
    queryFn: () =>
      apiClient
        .get<{ data: { id: string; status: string }[] }>(
          `/api/v1/commercial-orders?contact_id=${contactId}`,
        )
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
  });

  const alvos = (pedidos.data ?? [])
    .filter((p) => p.status !== "cancelado")
    .slice(0, 5)
    .map((p) => p.id);

  const itens = useQuery({
    queryKey: ["contato", contactId, "produtos", alvos.join(",")],
    enabled: alvos.length > 0,
    queryFn: async () => {
      const todos: (ItemDoPedido & { dia: string })[] = [];
      for (const id of alvos) {
        const corpo = await apiClient.get<{
          data: { itens: ItemDoPedido[]; created_at: string };
        }>(`/api/v1/commercial-orders/${id}`);
        for (const item of corpo.data.itens ?? []) {
          todos.push({ ...item, dia: corpo.data.created_at.slice(0, 10) });
        }
      }
      return todos;
    },
  });

  if (pedidos.isLoading || itens.isLoading) return <Skeleton className="h-40 w-full" />;
  if (pedidos.isError || itens.isError) {
    return (
      <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted-foreground">
        {t("Não foi possível ler os produtos agora.")}
      </p>
    );
  }

  const agregados = new Map<string, ProdutoAgregado>();
  for (const item of itens.data ?? []) {
    const atual = agregados.get(item.produto_nome) ?? {
      nome: item.produto_nome,
      codigo: item.produto_codigo,
      qtd: 0,
      total: 0,
      ultimaCompra: item.dia,
    };
    atual.qtd += item.quantidade;
    atual.total += item.subtotal_cents;
    if (item.dia > atual.ultimaCompra) atual.ultimaCompra = item.dia;
    agregados.set(item.produto_nome, atual);
  }
  const lista = [...agregados.values()].sort((a, b) => b.total - a.total);

  if (lista.length === 0) {
    return (
      <NexusEmptyState
        icon={Storefront}
        headline={t("Nenhum produto detalhado")}
        subcopy={t("Os itens aparecem aqui a partir dos pedidos do cliente.")}
        primary={{ label: t("Ver pedidos"), href: "/app/pedidos" }}
      />
    );
  }

  return (
    <ul className="divide-y rounded-lg border border-border bg-surface">
      {lista.map((p) => (
        <li key={p.nome} className="flex items-center gap-4 p-3 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-text">{p.nome}</p>
            <p className="text-xs text-muted-foreground">
              {p.qtd} {t("un. no total · última compra")} {p.ultimaCompra}
            </p>
          </div>
          <p className="font-medium text-text tabular-nums">{comoMoeda(p.total, "BRL")}</p>
        </li>
      ))}
    </ul>
  );
}
