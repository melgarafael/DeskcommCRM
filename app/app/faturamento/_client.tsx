"use client";

import * as React from "react";
import Link from "next/link";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { NexusDataTable } from "@/components/nexus-ui/data/NexusDataTable";
import { NexusEmptyState } from "@/components/nexus-ui/feedback/NexusEmptyState";
import { NexusPageHeader } from "@/components/nexus-ui/layout/NexusPageHeader";
import { Archive } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { comoMoeda, numeroDoPedido } from "@/lib/format/moeda";
import { paraCSV } from "@/lib/comercial/relatorios";
import type { LinhaFaturamento } from "@/app/api/v1/faturamento/route";

export function FaturamentoClient({
  nomesVendedores,
}: {
  nomesVendedores: Record<string, string>;
}) {
  const tagIdioma = useTagDeIdioma();
  const t = useT();
  const [de, setDe] = React.useState("");
  const [ate, setAte] = React.useState("");
  const [linhas, setLinhas] = React.useState<LinhaFaturamento[]>([]);
  const [carregando, setCarregando] = React.useState(true);

  async function carregar(d: string, a: string) {
    setCarregando(true);
    try {
      const qs = new URLSearchParams();
      if (d) qs.set("de", d);
      if (a) qs.set("ate", a);
      const corpo = await apiClient.get<{ data: LinhaFaturamento[] }>(
        `/api/v1/faturamento${qs.toString() ? `?${qs}` : ""}`,
      );
      setLinhas(corpo.data ?? []);
    } catch (e) {
      showApiError(e);
    } finally {
      setCarregando(false);
    }
  }

  React.useEffect(() => {
    let vivo = true;
    apiClient
      .get<{ data: LinhaFaturamento[] }>("/api/v1/faturamento")
      .then((corpo) => {
        if (!vivo) return;
        setLinhas(corpo.data ?? []);
        setCarregando(false);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        showApiError(e);
        setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, []);

  const total = linhas.reduce((acc, l) => acc + l.total_cents, 0);
  const semNf = linhas.filter((l) => l.nf_numero == null).length;

  function exportar() {
    const blob = new Blob(
      [
        "﻿" +
          paraCSV(
            ["Emissão", "Pedido", "NF", "Cliente", "Vendedor", "Total (R$)"],
            linhas.map((l) => [
              new Date(l.data_emissao).toLocaleDateString(tagIdioma),
              numeroDoPedido(l.numero),
              l.nf_numero != null ? `${l.nf_serie ?? ""} ${l.nf_numero}`.trim() : "",
              l.cliente_nome,
              l.vendedor_user_id
                ? (nomesVendedores[l.vendedor_user_id] ?? l.vendedor_user_id.slice(0, 8))
                : "",
              (l.total_cents / 100).toLocaleString(tagIdioma, { minimumFractionDigits: 2 }),
            ]),
          ),
      ],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "faturamento.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <NexusPageHeader
        title={t("Faturamento")}
        subtitle={t("Pedidos faturados com a NF vinculada — sem nota é cobrança pendente.")}
        actions={
          linhas.length > 0 ? (
            <Button size="sm" variant="outline" onClick={exportar}>
              Excel
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">{t("De")}</span>
          <input
            type="date"
            value={de}
            onChange={(e) => {
              setDe(e.target.value);
              void carregar(e.target.value, ate);
            }}
            className="h-9 rounded-lg border bg-background px-3"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">{t("Até")}</span>
          <input
            type="date"
            value={ate}
            onChange={(e) => {
              setAte(e.target.value);
              void carregar(de, e.target.value);
            }}
            className="h-9 rounded-lg border bg-background px-3"
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">{t("Faturado no período")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{comoMoeda(total, "BRL")}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">{t("Faturados sem NF vinculada")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{semNf}</p>
        </Card>
      </div>

      <NexusDataTable<LinhaFaturamento>
        state={carregando ? "loading" : linhas.length === 0 ? "empty" : "ready"}
        empty={
          <NexusEmptyState
            icon={Archive}
            headline={t("Nenhum faturamento no período.")}
            subcopy={t("Ajuste o período ou fature pedidos para vê-los aqui.")}
          />
        }
        items={linhas}
        keyOf={(l) => l.order_id}
        renderCard={(l) => (
          <div className="space-y-1 text-sm">
            <div className="flex items-center justify-between gap-2">
              <Link
                href={`/app/pedidos/${l.order_id}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {numeroDoPedido(l.numero)}
              </Link>
              <span className="font-medium tabular-nums">{comoMoeda(l.total_cents, "BRL")}</span>
            </div>
            <p className="truncate text-muted-foreground">{l.cliente_nome}</p>
            <p className="text-muted-foreground tabular-nums">
              {new Date(l.data_emissao).toLocaleDateString(tagIdioma)} · NF{" "}
              {l.nf_numero != null ? `${l.nf_serie ?? ""} ${l.nf_numero}` : "—"}
            </p>
          </div>
        )}
        table={
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>{t("Emissão")}</TableHead>
                <TableHead>{t("Pedido")}</TableHead>
                <TableHead>{t("NF")}</TableHead>
                <TableHead>{t("Cliente")}</TableHead>
                <TableHead>{t("Vendedor")}</TableHead>
                <TableHead className="text-right">{t("Total")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {linhas.map((l) => (
                <TableRow key={l.order_id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(l.data_emissao).toLocaleDateString(tagIdioma)}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/app/pedidos/${l.order_id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {numeroDoPedido(l.numero)}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {l.nf_numero != null ? (
                      `${l.nf_serie ?? ""} ${l.nf_numero}`
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{l.cliente_nome}</TableCell>
                  <TableCell>
                    {l.vendedor_user_id
                      ? (nomesVendedores[l.vendedor_user_id] ?? l.vendedor_user_id.slice(0, 8))
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {comoMoeda(l.total_cents, "BRL")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        }
      />
    </div>
  );
}
