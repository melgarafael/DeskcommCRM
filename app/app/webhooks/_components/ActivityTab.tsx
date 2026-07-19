"use client";
import * as React from "react";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, X, SkipForward, ArrowsClockwise, PaperPlaneTilt } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import {
  useAutomationRuns,
  useResendAutomationRun,
  type AutomationRuleRunRow,
  type AutomationRuleRunActionResult,
} from "@/hooks/webhooks/useAutomationRules";
import { ACTION_LABELS, type ActionType } from "./labels";

function actionLabel(type: string): string {
  return ACTION_LABELS[type as ActionType] ?? type;
}

function relativeCreatedAt(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: ptBR });
}

function statusBadgeVariant(status: AutomationRuleRunRow["status"]): "success" | "error" | "warning" {
  if (status === "success") return "success";
  if (status === "failed") return "error";
  return "warning";
}

function statusBadgeLabel(status: AutomationRuleRunRow["status"]): string {
  if (status === "success") return "Sucesso";
  if (status === "failed") return "Falhou";
  return "Parcial";
}

function ActionLine({ action, run }: { action: AutomationRuleRunActionResult; run: AutomationRuleRunRow }) {
  const resend = useResendAutomationRun();

  const icon =
    action.status === "success" ? (
      <Check className="h-4 w-4 shrink-0 text-success" />
    ) : action.status === "failed" ? (
      <X className="h-4 w-4 shrink-0 text-error" />
    ) : (
      <SkipForward className="h-4 w-4 shrink-0 text-muted-foreground" />
    );

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        {icon}
        <span>{actionLabel(action.type)}</span>
      </div>
      {action.status === "failed" ? (
        <div className="ml-6 flex items-center justify-between gap-2 rounded-sm bg-muted px-2 py-1.5">
          <p className="text-xs text-muted-foreground">
            {action.error ?? "Essa ação não funcionou."}
          </p>
          {action.type === "call_webhook" ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={resend.isPending}
              onClick={() =>
                resend.mutate(run.id, {
                  onSuccess: () => toast.success("Reenviado."),
                })
              }
            >
              <PaperPlaneTilt /> Reenviar
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ActivityTab() {
  const { data, isLoading, refetch, isRefetching } = useAutomationRuns();
  const runs = data?.data ?? [];

  return (
    <div className="space-y-4 pt-4">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="secondary"
          onClick={() => refetch()}
          disabled={isRefetching}
        >
          <ArrowsClockwise className={cn(isRefetching && "animate-spin")} /> Atualizar
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : runs.length === 0 ? (
        <div className="flex justify-center pt-10">
          <Card className="max-w-md">
            <CardContent className="pt-6 text-center text-sm text-muted-foreground">
              Nenhuma automação rodou ainda. Assim que uma regra ligada disparar, o histórico
              aparece aqui.
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <Card key={run.id}>
              <CardHeader className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="truncate text-sm">
                    {run.automation_rules?.name ?? "Automação removida"}
                  </CardTitle>
                  <Badge variant={statusBadgeVariant(run.status)}>{statusBadgeLabel(run.status)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{relativeCreatedAt(run.created_at)}</p>
              </CardHeader>
              <CardContent className="space-y-2">
                {run.actions_result.map((action, idx) => (
                  <ActionLine key={idx} action={action} run={run} />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
