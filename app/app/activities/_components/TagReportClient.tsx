"use client";

import Link from "next/link";
import { useState } from "react";

import { EmptyState } from "@/components/empty";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";
import { useTagReport } from "@/hooks/reports/useTagReport";
import { esperaLegivel, type LinhaDeEtiqueta } from "@/lib/reports/etiquetas";
import { Tag } from "@/lib/ui/icons";

/**
 * A PERGUNTA: qual assunto ocupou a operação neste período.
 *
 * Mesmo desenho de estados da aba Atividades (carregando, erro, vazio) — duas
 * abas com dois vocabulários de "sem dado" seriam a mesma tela contada em duas
 * línguas. Nada aqui recalcula: volume, desfecho, espera e `fatia` vêm todos da
 * rota (#1888), que já declarou o denominador.
 *
 * Sem CSV na primeira versão: o corpo da #1891 diz "não medido", então é
 * decisão de produto pendente, não código faltando.
 */
const PERIODOS = [7, 30, 90] as const;

export function TagReportClient() {
  const t = useT();
  const [dias, setDias] = useState<number>(7);
  const { data, isLoading, isError } = useTagReport(dias);

  const relatorio = data?.data;

  const seletor = (
    <Select value={String(dias)} onValueChange={(v) => setDias(Number(v))}>
      <SelectTrigger className="w-44" aria-label={t("Período")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PERIODOS.map((p) => (
          <SelectItem key={p} value={String(p)}>
            {t("Últimos")} {p} {t("dias")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        {seletor}
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      </div>
    );
  }

  if (isError || !relatorio) {
    return (
      <div className="flex flex-col gap-6">
        {seletor}
        <p className="text-sm text-destructive">{t("Erro ao carregar o relatório.")}</p>
      </div>
    );
  }

  const { linhas, total_etiquetagens, sem_dados, motivo, truncado } = relatorio;

  if (sem_dados) {
    // Duas ausências, ditas pela rota: sem etiqueta em uso é vocabulário que
    // ninguém escreveu; sem conversa etiquetada é período que não teve fio.
    // Só o motivo escolhe a frase — adivinhar pelo tamanho da lista mentiria
    // num dos dois casos.
    return (
      <div className="flex flex-col gap-6">
        {seletor}
        <EmptyState
          icon={Tag}
          headline={
            motivo === "nenhuma_etiqueta_em_uso"
              ? t("Nenhuma etiqueta em uso")
              : t("Nenhuma conversa com etiqueta neste período")
          }
          subcopy={t(
            "Aplique etiquetas às conversas ou aumente o período — é por etiqueta que se vê qual assunto ocupa a operação.",
          )}
          primary={{ label: t("Ver conversas"), href: "/app/inbox" }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        {seletor}
        <p className="text-sm text-muted-foreground" data-testid="total-de-etiquetagens">
          {total_etiquetagens}{" "}
          {total_etiquetagens === 1 ? t("etiquetagem") : t("etiquetagens")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("O que mais ocupou a operação")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table data-testid="tabela-por-etiqueta">
            <TableHeader>
              <TableRow>
                <TableHead>{t("Etiqueta")}</TableHead>
                <TableHead className="text-right">{t("Conversas")}</TableHead>
                <TableHead className="text-right">{t("Abertas")}</TableHead>
                <TableHead className="text-right">{t("Resolvidas")}</TableHead>
                <TableHead className="text-right">{t("Espera média")}</TableHead>
                <TableHead className="w-44">{t("Fatia")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {linhas.map((linha: LinhaDeEtiqueta) => (
                <TableRow key={linha.etiqueta} data-testid="linha-de-etiqueta">
                  <TableCell>
                    {/* O "e daí" da linha: lista que não leva ao trabalho é
                        decoração. Um marcador por vez (#1886 é o filtro de
                        várias), então o link carrega UMA etiqueta.
                        `filter=all` porque sem ele o Inbox abre na Fila, que
                        esconde as resolvidas e as que têm dono — e a linha
                        conta as duas. */}
                    <Link
                      href={`/app/inbox?filter=all&tag=${encodeURIComponent(linha.etiqueta)}`}
                      data-testid="link-de-etiqueta"
                      className="text-accent underline underline-offset-2"
                    >
                      {linha.etiqueta}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{linha.conversas}</TableCell>
                  <TableCell className="text-right tabular-nums">{linha.abertas}</TableCell>
                  <TableCell className="text-right tabular-nums">{linha.resolvidas}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {esperaLegivel(linha.espera_media_segundos)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${linha.fatia}%` }}
                        />
                      </div>
                      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                        {linha.fatia}%
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {truncado && (
            <p className="mt-3 text-xs text-muted-foreground" data-testid="aviso-de-corte">
              {/* A tabela é AGREGADA: o corte não encurta uma lista, ele
                  deixa de fora as conversas mais antigas da conta (a rota
                  lê por service_started_at desc até o teto de páginas). */}
              {t("O período passou do limite de leitura: os números contam só as conversas mais recentes.")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
