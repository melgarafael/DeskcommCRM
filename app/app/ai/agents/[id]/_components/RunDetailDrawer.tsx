"use client";
/**
 * RunDetailDrawer — Sheet com trace completo de um run (S-13.12).
 *
 * Reusa RunTrace. Quando o run tem conversation_id, mostra link "Ver conversa"
 * (best-effort — pode 404 se a conversa foi anonimizada/redacted).
 */
import * as React from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useT } from "@/hooks/i18n/useT";

import { RunTrace } from "./RunTrace";
import type { AgentRunRow } from "@/hooks/ai/useAgentRuns";

interface Props {
  run: AgentRunRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function fmtCost(cents: number | null): string {
  if (cents == null) return "—";
  return `US$ ${(cents / 100).toFixed(4)}`;
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  running: "secondary",
  completed: "default",
  failed: "destructive",
  aborted: "destructive",
  timeout: "destructive",
};

export function RunDetailDrawer({ run, open, onOpenChange }: Props) {
  const t = useT();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="space-y-1 text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            <span>{t("Execução")}</span>
            {run ? (
              <Badge variant={STATUS_VARIANT[run.status] ?? "outline"} className="text-xs">
                {run.status}
              </Badge>
            ) : null}
            {run?.is_dry_run ? (
              <Badge variant="outline" className="text-xs">
                dry-run
              </Badge>
            ) : null}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {run?.id ?? ""}
          </SheetDescription>
        </SheetHeader>

        {run ? (
          <div className="flex flex-col gap-4 text-sm">
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <Cell label={t("Iniciado")}>{new Date(run.started_at).toLocaleString()}</Cell>
              <Cell label={t("Concluído")}>
                {run.completed_at ? new Date(run.completed_at).toLocaleString() : "—"}
              </Cell>
              <Cell label={t("Tokens (in/out)")}>
                {(run.tokens_in ?? 0).toLocaleString()} / {(run.tokens_out ?? 0).toLocaleString()}
              </Cell>
              <Cell label={t("Custo")}>{fmtCost(run.cost_cents)}</Cell>
              <Cell label={t("Latência")}>{fmtLatency(run.latency_ms)}</Cell>
              <Cell label={t("Steps")}>{run.steps_count ?? 0}</Cell>
            </dl>

            {run.error_code || run.error_message ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">
                <p className="font-medium text-destructive">
                  {run.error_code ?? t("error")}
                </p>
                {run.error_message ? (
                  <p className="mt-1 whitespace-pre-wrap">{run.error_message}</p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {run.conversation_id ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/app/inbox?conversation=${run.conversation_id}`}>
                    {t("Ver conversa")}
                  </Link>
                </Button>
              ) : null}
              {run.inbound_message_id ? (
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/app/inbox?message=${run.inbound_message_id}`}>
                    {t("Ver inbound")}
                  </Link>
                </Button>
              ) : null}
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("Trace")}
              </p>
              <RunTrace toolCalls={run.tool_calls} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("Selecione uma execução.")}</p>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 px-2 py-1">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-mono">{children}</dd>
    </div>
  );
}
