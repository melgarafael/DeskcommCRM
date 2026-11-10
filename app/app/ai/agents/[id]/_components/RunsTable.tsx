"use client";
/**
 * RunsTable — tabela de execuções com Realtime (S-13.12).
 *
 * Mostra a página mais recente (limit 25). Click numa row → drawer com trace.
 */
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { useAgentRuns, type AgentRunRow } from "@/hooks/ai/useAgentRuns";
import { useT } from "@/hooks/i18n/useT";
import { RunDetailDrawer } from "./RunDetailDrawer";

interface Props {
  agentId: string;
  active: boolean;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  running: "secondary",
  completed: "default",
  failed: "destructive",
  aborted: "destructive",
  timeout: "destructive",
};

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtCost(cents: number | null): string {
  if (cents == null) return "—";
  return `US$ ${(cents / 100).toFixed(4)}`;
}

export function RunsTable({ agentId, active }: Props) {
  const t = useT();
  const { data, isLoading, error, refetch, isFetching } = useAgentRuns(agentId, {
    enabled: active,
    realtime: active,
  });
  const [selected, setSelected] = React.useState<AgentRunRow | null>(null);
  const [open, setOpen] = React.useState(false);

  const rows = data?.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {isLoading ? t("Carregando…") : `${rows.length} ${t("execuções recentes")}`}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? t("Atualizando…") : t("Atualizar")}
        </Button>
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {t("Erro ao carregar execuções.")}
        </p>
      ) : null}

      <div className="rounded-md border border-border/60">
        <Table className="max-md:block">
          <TableHeader className="max-md:hidden">
            <TableRow>
              <TableHead className="w-[170px]">{t("Início")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead>{t("Tipo")}</TableHead>
              <TableHead>{t("Tokens (in/out)")}</TableHead>
              <TableHead>{t("Custo")}</TableHead>
              <TableHead>{t("Latência")}</TableHead>
              <TableHead>{t("Steps")}</TableHead>
              <TableHead className="text-right">{t("Ações")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="max-md:block">
            {rows.length === 0 && !isLoading ? (
              <TableRow className="max-md:block">
                <TableCell colSpan={8} className="text-center text-sm text-muted-foreground max-md:block">
                  {t("Nenhuma execução ainda.")}
                </TableCell>
              </TableRow>
            ) : null}

            {rows.map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-1 max-md:px-3 max-md:py-2"
                onClick={() => {
                  setSelected(r);
                  setOpen(true);
                }}
              >
                <TableCell className="font-mono text-xs max-md:basis-full max-md:p-0">
                  {new Date(r.started_at).toLocaleString()}
                </TableCell>
                <TableCell className="max-md:p-0">
                  <Badge variant={STATUS_VARIANT[r.status] ?? "outline"} className="text-xs">
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs max-md:hidden">
                  {r.is_dry_run ? (
                    <Badge variant="outline" className="text-xs">
                      {t("teste")}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">{t("produção")}</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs max-md:hidden">
                  {(r.tokens_in ?? 0).toLocaleString()} /{" "}
                  {(r.tokens_out ?? 0).toLocaleString()}
                </TableCell>
                <TableCell className="font-mono text-xs max-md:p-0 max-md:before:mr-1 max-md:before:font-sans max-md:before:text-muted-foreground max-md:before:content-[attr(data-rotulo)]" data-rotulo={t("Custo")}>
                  {fmtCost(r.cost_cents)}
                </TableCell>
                <TableCell className="font-mono text-xs max-md:p-0 max-md:before:mr-1 max-md:before:font-sans max-md:before:text-muted-foreground max-md:before:content-[attr(data-rotulo)]" data-rotulo={t("Latência")}>
                  {fmtLatency(r.latency_ms)}
                </TableCell>
                <TableCell className="font-mono text-xs max-md:hidden">{r.steps_count ?? 0}</TableCell>
                <TableCell className="text-right max-md:ml-auto max-md:p-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(r);
                      setOpen(true);
                    }}
                  >
                    {t("Detalhes")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <RunDetailDrawer run={selected} open={open} onOpenChange={setOpen} />
    </div>
  );
}
