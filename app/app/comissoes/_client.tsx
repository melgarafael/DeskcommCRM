"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { nexusToast } from "@/components/nexus-ui/feedback/nexus-toast";
import { NexusDataTable } from "@/components/nexus-ui/data/NexusDataTable";
import { NexusEmptyState } from "@/components/nexus-ui/feedback/NexusEmptyState";
import { NexusPageHeader } from "@/components/nexus-ui/layout/NexusPageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Wallet } from "@/lib/ui/icons";
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
import type { LinhaComissao } from "@/app/api/v1/commissions/route";

export function ComissoesClient({
  mes: mesInicial,
  nomesVendedores,
  podeDarBaixa,
}: {
  mes: string;
  nomesVendedores: Record<string, string>;
  podeDarBaixa: boolean;
}) {
  const router = useRouter();
  const tagIdioma = useTagDeIdioma();
  const t = useT();
  const [mes, setMes] = React.useState(mesInicial);
  const [vendedor, setVendedor] = React.useState("");
  const [linhas, setLinhas] = React.useState<LinhaComissao[]>([]);
  const [carregando, setCarregando] = React.useState(true);

  const nomeVendedor = (id: string | null): string =>
    !id ? t("Sem vendedor") : (nomesVendedores[id] ?? id.slice(0, 8));

  async function carregar(m: string, v: string) {
    setCarregando(true);
    try {
      const qs = new URLSearchParams({ ano_mes: m });
      if (v) qs.set("vendedor", v);
      const corpo = await apiClient.get<{ data: LinhaComissao[] }>(`/api/v1/commissions?${qs}`);
      setLinhas(corpo.data ?? []);
    } catch (e) {
      showApiError(e);
    } finally {
      setCarregando(false);
    }
  }

  React.useEffect(() => {
    // Carga inicial via promise (setState só no .then): carregar() direto
    // aqui seria setState síncrono no efeito (react-hooks/set-state-in-effect).
    let vivo = true;
    const qs = new URLSearchParams({ ano_mes: mesInicial });
    apiClient.get<{ data: LinhaComissao[] }>(`/api/v1/commissions?${qs}`).then(
      (corpo) => {
        if (!vivo) return;
        setLinhas(corpo.data ?? []);
        setCarregando(false);
      },
      (e: unknown) => {
        if (!vivo) return;
        showApiError(e);
        setCarregando(false);
      },
    );
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function mudarMes(novo: string) {
    setMes(novo);
    router.push(`/app/comissoes?mes=${novo}`);
    void carregar(novo, vendedor);
  }

  function mudarVendedor(novo: string) {
    setVendedor(novo);
    void carregar(mes, novo);
  }

  async function darBaixa(l: LinhaComissao) {
    try {
      await apiClient.post("/api/v1/commissions/baixas", {
        order_id: l.order_id,
        valor_cents: l.comissao_cents,
      });
      nexusToast.success(t("Baixa registrada"));
      await carregar(mes, vendedor);
    } catch (e) {
      showApiError(e);
    }
  }

  async function estornar(l: LinhaComissao) {
    try {
      await apiClient.delete(`/api/v1/commissions/baixas?order_id=${l.order_id}`);
      nexusToast.success(t("Baixa estornada"));
      await carregar(mes, vendedor);
    } catch (e) {
      showApiError(e);
    }
  }

  const totalComissao = linhas.reduce((a, l) => a + l.comissao_cents, 0);
  const totalBaixado = linhas.filter((l) => l.baixado_em).reduce((a, l) => a + l.comissao_cents, 0);

  function exportar() {
    const blob = new Blob(
      [
        "﻿" +
          paraCSV(
            ["Data", "Pedido", "Cliente", "Vendedor", "Total (R$)", "Comissão (R$)", "Situação"],
            linhas.map((l) => [
              new Date(l.data_emissao).toLocaleDateString(tagIdioma),
              numeroDoPedido(l.numero),
              l.cliente_nome,
              nomeVendedor(l.vendedor_user_id),
              (l.total_cents / 100).toLocaleString(tagIdioma, { minimumFractionDigits: 2 }),
              (l.comissao_cents / 100).toLocaleString(tagIdioma, { minimumFractionDigits: 2 }),
              l.baixado_em ? "Baixada" : "A pagar",
            ]),
          ),
      ],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `comissoes-${mes}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <NexusPageHeader
        title={t("Comissões")}
        subtitle={t("Quanto cada vendedor leva nos pedidos do mês — e o que já foi pago.")}
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
          <span className="mb-1 block text-muted-foreground">{t("Mês")}</span>
          <input
            type="month"
            value={mes}
            onChange={(e) => mudarMes(e.target.value)}
            className="h-9 rounded-lg border bg-background px-3"
          />
        </label>
        <div className="block text-sm">
          <span className="mb-1 block text-muted-foreground">{t("Vendedor")}</span>
          <Select
            value={vendedor || "__todos"}
            onValueChange={(v) => mudarVendedor(v === "__todos" ? "" : v)}
          >
            <SelectTrigger className="w-52">
              <SelectValue placeholder={t("Todos")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__todos">{t("Todos")}</SelectItem>
              {Object.entries(nomesVendedores).map(([id, nome]) => (
                <SelectItem key={id} value={id}>
                  {nome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">{t("Comissão do mês")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {comoMoeda(totalComissao, "BRL")}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">{t("Já baixado")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {comoMoeda(totalBaixado, "BRL")}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">{t("A pagar")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {comoMoeda(totalComissao - totalBaixado, "BRL")}
          </p>
        </Card>
      </div>

      <NexusDataTable<LinhaComissao>
        state={carregando ? "loading" : linhas.length === 0 ? "empty" : "ready"}
        empty={
          <NexusEmptyState
            icon={Wallet}
            headline={t("Sem comissões no período.")}
            subcopy={t("Ajuste o mês ou o vendedor.")}
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
              {l.baixado_em ? (
                <Badge variant="success">{t("Baixada")}</Badge>
              ) : (
                <Badge variant="warning">{t("A pagar")}</Badge>
              )}
            </div>
            <p className="truncate text-muted-foreground">
              {l.cliente_nome} · {nomeVendedor(l.vendedor_user_id)}
            </p>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground tabular-nums">
                {new Date(l.data_emissao).toLocaleDateString(tagIdioma)}
              </span>
              <span className="font-medium tabular-nums">{comoMoeda(l.comissao_cents, "BRL")}</span>
            </div>
            {podeDarBaixa && (
              <div className="pt-1">
                {l.baixado_em ? (
                  <Button size="sm" variant="outline" onClick={() => void estornar(l)}>
                    {t("Estornar")}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void darBaixa(l)}>
                    {t("Dar baixa")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        table={
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>{t("Data")}</TableHead>
                <TableHead>{t("Pedido")}</TableHead>
                <TableHead>{t("Cliente")}</TableHead>
                <TableHead>{t("Vendedor")}</TableHead>
                <TableHead className="text-right">{t("Total")}</TableHead>
                <TableHead className="text-right">{t("Comissão")}</TableHead>
                <TableHead>{t("Situação")}</TableHead>
                {podeDarBaixa && <TableHead>{t("Ação")}</TableHead>}
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
                  <TableCell>{l.cliente_nome}</TableCell>
                  <TableCell>{nomeVendedor(l.vendedor_user_id)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {comoMoeda(l.total_cents, "BRL")}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {comoMoeda(l.comissao_cents, "BRL")}
                  </TableCell>
                  <TableCell>
                    {l.baixado_em ? (
                      <Badge variant="success">{t("Baixada")}</Badge>
                    ) : (
                      <Badge variant="warning">{t("A pagar")}</Badge>
                    )}
                  </TableCell>
                  {podeDarBaixa && (
                    <TableCell>
                      {l.baixado_em ? (
                        <Button size="sm" variant="outline" onClick={() => void estornar(l)}>
                          {t("Estornar")}
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => void darBaixa(l)}>
                          {t("Dar baixa")}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        }
      />
    </div>
  );
}
