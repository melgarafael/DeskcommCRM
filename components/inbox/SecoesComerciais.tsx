"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { apiClient } from "@/lib/api/client";
import { comoMoeda, numeroDoPedido } from "@/lib/format/moeda";
import type { ItemDoPedido } from "@/lib/schemas/pedidos";

interface PedidoLista {
  id: string;
  numero: number;
  status: string;
  total_cents: number;
  created_at: string;
}

interface TituloLista {
  saldo_cents: number;
  situacao: string;
}

/**
 * Seções comerciais do painel do inbox: últimas compras, produtos e títulos.
 *
 * Bloco próprio com os TRÊS estados (carregando/erro/vazio), mesma doutrina do
 * CRMSidePanel: falha de leitura nunca vira "não tem". Não toca no fetch do
 * crm-summary — cada seção falha sozinha sem derrubar as outras.
 */
export function SecoesComerciais({ contactId }: { contactId: string }) {
  const t = useT();
  const [pedidos, setPedidos] = useState<PedidoLista[] | null>(null);
  const [produtos, setProdutos] = useState<{ nome: string; qtd: number; total: number }[] | null>(
    null,
  );
  const [titulos, setTitulos] = useState<{ aberto: number; vencido: number; qtd: number } | null>(
    null,
  );
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    let vivo = true;
    // Reset síncrono de propósito: sem ele, trocar de conversa exibe os
    // dados comerciais do contato ANTERIOR até a nova leitura chegar — o
    // mesmo flash que o CRMSidePanel evita com o terceiro estado.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPedidos(null);
    setProdutos(null);
    setTitulos(null);
    setErro(false);
    (async () => {
      try {
        const [lista, recebiveis] = await Promise.all([
          apiClient
            .get<{ data: PedidoLista[] }>(`/api/v1/commercial-orders?contact_id=${contactId}`)
            .then((r) => (Array.isArray(r.data) ? r.data : [])),
          apiClient
            .get<{ data: TituloLista[] }>(
              `/api/v1/financeiro/recebiveis?contact_id=${contactId}&limit=200`,
            )
            .then((r) => r.data ?? []),
        ]);
        if (!vivo) return;
        const validos = lista.filter((p) => p.status !== "cancelado");
        setPedidos(validos.slice(0, 3));

        // Produtos: itens dos 2 pedidos válidos mais recentes, top 5 por valor.
        const agregados = new Map<string, { nome: string; qtd: number; total: number }>();
        for (const ped of validos.slice(0, 2)) {
          const det = await apiClient.get<{
            data: { itens: ItemDoPedido[] };
          }>(`/api/v1/commercial-orders/${ped.id}`);
          for (const item of det.data.itens ?? []) {
            const atual = agregados.get(item.produto_nome) ?? {
              nome: item.produto_nome,
              qtd: 0,
              total: 0,
            };
            atual.qtd += item.quantidade;
            atual.total += item.subtotal_cents;
            agregados.set(item.produto_nome, atual);
          }
        }
        if (!vivo) return;
        setProdutos([...agregados.values()].sort((a, b) => b.total - a.total).slice(0, 5));

        setTitulos({
          aberto: recebiveis
            .filter((x) => x.situacao !== "pago" && x.situacao !== "cancelado")
            .reduce((s, x) => s + x.saldo_cents, 0),
          vencido: recebiveis
            .filter((x) => x.situacao === "vencido")
            .reduce((s, x) => s + x.saldo_cents, 0),
          qtd: recebiveis.filter((x) => x.situacao !== "pago" && x.situacao !== "cancelado").length,
        });
      } catch {
        if (vivo) setErro(true);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [contactId, tentativa]);

  const carregando = !erro && pedidos === null && produtos === null && titulos === null;

  function tentarDeNovo() {
    return (
      <div className="mt-2 space-y-1">
        <p className="text-xs text-error-fg">{t("Não consegui ler estes dados.")}</p>
        <Button size="sm" variant="outline" onClick={() => setTentativa((n) => n + 1)}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  return (
    <>
      <Separator />
      <section>
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("Últimas compras")}
        </h3>
        {carregando ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : erro ? (
          tentarDeNovo()
        ) : pedidos && pedidos.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {pedidos.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 text-xs"
              >
                <Link
                  href={`/app/pedidos/${p.id}`}
                  className="truncate font-medium underline-offset-4 hover:underline"
                >
                  {numeroDoPedido(p.numero)}
                </Link>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {comoMoeda(p.total_cents, "BRL")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">{t("Sem compras.")}</p>
        )}
      </section>

      <Separator />
      <section>
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("Produtos")}
        </h3>
        {carregando ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : erro ? (
          tentarDeNovo()
        ) : produtos && produtos.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {produtos.map((p) => (
              <li key={p.nome} className="rounded-lg border border-border p-2 text-xs">
                <div className="truncate font-medium">{p.nome}</div>
                <div className="text-muted-foreground tabular-nums">
                  {p.qtd} un. · {comoMoeda(p.total, "BRL")}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">{t("Sem produtos detalhados.")}</p>
        )}
      </section>

      <Separator />
      <section>
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("Títulos")}
        </h3>
        {carregando ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : erro ? (
          tentarDeNovo()
        ) : titulos && titulos.qtd > 0 ? (
          <div className="mt-2 rounded-lg border border-border p-2 text-xs">
            <p className="tabular-nums">
              {t("Em aberto")}: <strong>{comoMoeda(titulos.aberto, "BRL")}</strong>
            </p>
            {titulos.vencido > 0 && (
              <p className="text-error-fg tabular-nums">
                {t("Vencido")}: <strong>{comoMoeda(titulos.vencido, "BRL")}</strong>
              </p>
            )}
            <Link href="/app/financeiro" className="mt-1 inline-block underline underline-offset-4">
              {t("Ver financeiro")}
            </Link>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">{t("Sem títulos em aberto.")}</p>
        )}
      </section>
    </>
  );
}
