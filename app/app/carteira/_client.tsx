"use client";

import * as React from "react";
import Link from "next/link";

import { NexusDataTable } from "@/components/nexus-ui/data/NexusDataTable";
import { NexusEmptyState } from "@/components/nexus-ui/feedback/NexusEmptyState";
import { NexusPageHeader } from "@/components/nexus-ui/layout/NexusPageHeader";
import { UsersThree } from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
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
import { comoMoeda } from "@/lib/format/moeda";
import { paraCSV } from "@/lib/comercial/relatorios";
import type { SituacaoDaCarteira } from "@/lib/comercial/carteira";

export interface LinhaCarteira {
  contact_id: string;
  nome: string;
  fone: string | null;
  situacao: "ativo" | "inativo_recente" | "inativo_antigo" | "prospect";
  ultima_compra: string | null;
  dias_parado: number | null;
  total_historico: number;
}

const ROTULO = {
  ativo: "Ativos",
  inativo_recente: "Inativos recentes",
  inativo_antigo: "Inativos antigos",
  prospect: "Prospects",
} as const;

const VARIANTE = {
  ativo: "success",
  inativo_recente: "warning",
  inativo_antigo: "error",
  prospect: "neutral",
} as const;

export function CarteiraClient({
  linhas,
  resumo,
  total,
}: {
  linhas: LinhaCarteira[];
  resumo: SituacaoDaCarteira;
  total: number;
}) {
  const tagIdioma = useTagDeIdioma();
  const t = useT();
  const [filtro, setFiltro] = React.useState<keyof typeof ROTULO | "">("");
  const [busca, setBusca] = React.useState("");

  const visiveis = linhas.filter(
    (l) =>
      (!filtro || l.situacao === filtro) &&
      (!busca.trim() || l.nome.toLowerCase().includes(busca.trim().toLowerCase())),
  );

  function exportar() {
    const blob = new Blob(
      [
        "﻿" +
          paraCSV(
            [
              "Cliente",
              "Telefone",
              "Situação",
              "Última compra",
              "Dias parado",
              "Total histórico (R$)",
            ],
            visiveis.map((l) => [
              l.nome,
              l.fone ?? "",
              ROTULO[l.situacao],
              l.ultima_compra
                ? new Date(`${l.ultima_compra}T12:00:00Z`).toLocaleDateString(tagIdioma)
                : "",
              l.dias_parado != null ? String(l.dias_parado) : "",
              (l.total_historico / 100).toLocaleString(tagIdioma, { minimumFractionDigits: 2 }),
            ]),
          ),
      ],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "carteira.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const cards = [
    { chave: "ativo" as const, valor: resumo.ativos },
    { chave: "inativo_recente" as const, valor: resumo.inativosRecentes },
    { chave: "inativo_antigo" as const, valor: resumo.inativosAntigos },
    { chave: "prospect" as const, valor: resumo.prospects },
  ];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <NexusPageHeader
        title={t("Carteira")}
        subtitle={`${total} ${t("clientes · ciclo médio de")} ${resumo.cicloDias} ${t("dias. Quem parou, há quanto tempo.")}`}
        actions={
          visiveis.length > 0 ? (
            <Button size="sm" variant="outline" onClick={exportar}>
              Excel
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <button
            key={c.chave}
            type="button"
            onClick={() => setFiltro(filtro === c.chave ? "" : c.chave)}
            className="text-left"
          >
            <Card
              className={`p-4 transition-shadow hover:shadow-md ${filtro === c.chave ? "ring-2 ring-primary" : ""}`}
            >
              <p className="text-sm text-muted-foreground">
                {c.chave === "ativo"
                  ? t("Ativos")
                  : c.chave === "inativo_recente"
                    ? t("Inativos recentes")
                    : c.chave === "inativo_antigo"
                      ? t("Inativos antigos")
                      : t("Prospects")}
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{c.valor}</p>
            </Card>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">{t("Buscar")}</span>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("Nome do cliente…")}
            className="h-9 rounded-lg border bg-background px-3"
          />
        </label>
      </div>

      <NexusDataTable<LinhaCarteira>
        state={visiveis.length === 0 ? "empty" : "ready"}
        empty={
          <NexusEmptyState
            icon={UsersThree}
            headline={t("Nenhum cliente neste recorte.")}
            subcopy={t("Ajuste a busca ou o filtro de situação.")}
            primary={{
              label: t("Limpar filtros"),
              onClick: () => {
                setFiltro("");
                setBusca("");
              },
            }}
          />
        }
        items={visiveis.slice(0, 500)}
        keyOf={(l) => l.contact_id}
        renderCard={(l) => (
          <div className="space-y-1 text-sm">
            <div className="flex items-center justify-between gap-2">
              <Link
                href={`/app/contacts/${l.contact_id}`}
                className="truncate font-medium text-primary underline-offset-4 hover:underline"
              >
                {l.nome}
              </Link>
              <Badge variant={VARIANTE[l.situacao]}>
                {l.situacao === "ativo"
                  ? t("Ativos")
                  : l.situacao === "inativo_recente"
                    ? t("Inativos recentes")
                    : l.situacao === "inativo_antigo"
                      ? t("Inativos antigos")
                      : t("Prospects")}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span className="tabular-nums">
                {l.dias_parado != null ? `${l.dias_parado}d ${t("parado")}` : t("sem compras")}
              </span>
              <span className="font-medium text-text tabular-nums">
                {comoMoeda(l.total_historico, "BRL")}
              </span>
            </div>
          </div>
        )}
        pagination={
          visiveis.length > 500 ? (
            <p className="text-xs text-muted-foreground">
              {t("Mostrando 500 de")} {visiveis.length} {t("— refine a busca.")}
            </p>
          ) : undefined
        }
        table={
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>{t("Cliente")}</TableHead>
                <TableHead>{t("Telefone")}</TableHead>
                <TableHead>{t("Situação")}</TableHead>
                <TableHead>{t("Última compra")}</TableHead>
                <TableHead className="text-right">{t("Dias parado")}</TableHead>
                <TableHead className="text-right">{t("Total histórico")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visiveis.slice(0, 500).map((l) => (
                <TableRow key={l.contact_id}>
                  <TableCell>
                    <Link
                      href={`/app/contacts/${l.contact_id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {l.nome}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{l.fone ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={VARIANTE[l.situacao]}>
                      {l.situacao === "ativo"
                        ? t("Ativos")
                        : l.situacao === "inativo_recente"
                          ? t("Inativos recentes")
                          : l.situacao === "inativo_antigo"
                            ? t("Inativos antigos")
                            : t("Prospects")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {l.ultima_compra
                      ? new Date(`${l.ultima_compra}T12:00:00Z`).toLocaleDateString(tagIdioma)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.dias_parado ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {comoMoeda(l.total_historico, "BRL")}
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
