"use client";

import * as React from "react";
import Link from "next/link";

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
import { FilterActions, FilterBar } from "@/components/filters/FilterBar";
import { PageHeader } from "@/components/layout/PageHeader";
import { paraCSV, reais, type LinhaABC, type LinhaAgregada } from "@/lib/comercial/relatorios";
import { comoMoeda } from "@/lib/format/moeda";

interface Textos {
  titulo: string;
  subtitulo: string;
  periodo: string;
  porVendedor: string;
  porCliente: string;
  porProduto: string;
  curvaAbc: string;
  classe: string;
  qtd: string;
  total: string;
  ticket: string;
  exportar: string;
  vazio: string;
}

function baixar(nome: string, conteudo: string) {
  const blob = new Blob(["\uFEFF" + conteudo], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  a.click();
  URL.revokeObjectURL(url);
}

function Tabela({
  linhas,
  textos,
  nomeArquivo,
  comClasse,
}: {
  linhas: (LinhaAgregada | LinhaABC)[];
  textos: Textos;
  nomeArquivo: string;
  comClasse?: boolean;
}) {
  if (linhas.length === 0) {
    return <p className="text-sm text-muted-foreground">{textos.vazio}</p>;
  }
  const csv = () =>
    baixar(
      nomeArquivo,
      paraCSV(
        ["Nome", textos.qtd, textos.total + " (R$)", textos.ticket + " (R$)" + (comClasse ? `,${textos.classe}` : "")],
        linhas.map((l) => [
          l.rotulo,
          l.qtd,
          reais(l.total_cents),
          reais(l.ticket_medio_cents),
          ...(comClasse ? [(l as LinhaABC).classe] : []),
        ]),
      ),
    );
  return (
    <div className="space-y-2">
        <div className="overflow-x-auto rounded-3xl border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Nome</TableHead>
              <TableHead className="text-right">{textos.qtd}</TableHead>
              <TableHead className="text-right">{textos.total}</TableHead>
              <TableHead className="text-right">{textos.ticket}</TableHead>
              {comClasse && <TableHead>{textos.classe}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {linhas.map((l) => (
              <TableRow key={l.chave}>
                <TableCell>{l.rotulo}</TableCell>
                <TableCell className="text-right tabular-nums">{l.qtd}</TableCell>
                <TableCell className="text-right tabular-nums">{comoMoeda(l.total_cents, "BRL")}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {comoMoeda(l.ticket_medio_cents, "BRL")}
                </TableCell>
                {comClasse && <TableCell className="font-bold">{(l as LinhaABC).classe}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Button size="sm" variant="outline" onClick={csv}>
        {textos.exportar}
      </Button>
    </div>
  );
}

export function RelatoriosClient({
  dias,
  porVendedor,
  abcClientes,
  abcProdutos,
  textos,
}: {
  dias: number;
  porVendedor: LinhaAgregada[];
  abcClientes: LinhaABC[];
  abcProdutos: LinhaABC[];
  textos: Textos;
}) {
  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
      <PageHeader title={textos.titulo} subtitle={textos.subtitulo} />

      <FilterBar>
        <FilterActions>
          <span className="text-sm font-medium">{textos.periodo}</span>
          <div className="flex gap-1.5" role="group" aria-label={textos.periodo}>
            {[7, 30, 90].map((d) => (
              <Button key={d} variant={d === dias ? "default" : "outline"} size="sm" asChild>
                <Link href={`/app/relatorios?dias=${d}`}>{d}</Link>
              </Button>
            ))}
          </div>
        </FilterActions>
      </FilterBar>

      <Card className="p-4">
        <h2 className="mb-3 text-base font-medium text-text">{textos.porVendedor}</h2>
        <Tabela linhas={porVendedor} textos={textos} nomeArquivo={`vendas-vendedor-${dias}d.csv`} />
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-base font-medium text-text">
          {textos.porCliente} · {textos.curvaAbc}
        </h2>
        <Tabela linhas={abcClientes} textos={textos} nomeArquivo={`abc-clientes-${dias}d.csv`} comClasse />
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-base font-medium text-text">
          {textos.porProduto} · {textos.curvaAbc}
        </h2>
        <Tabela linhas={abcProdutos} textos={textos} nomeArquivo={`abc-produtos-${dias}d.csv`} comClasse />
      </Card>
    </div>
  );
}
