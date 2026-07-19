"use client";
import * as React from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Robot, Plus, Trash, PencilSimple } from "@/lib/ui/icons";
import {
  useAutomationRules,
  useUpdateAutomationRule,
  useDeleteAutomationRule,
  type AutomationRuleRow,
} from "@/hooks/webhooks/useAutomationRules";
import { TRIGGER_LABELS, type TriggerEvent } from "./labels";
import { RuleEditor } from "./RuleEditor";

const RULES_QUERY_KEY = ["automation-rules"];

function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger as TriggerEvent] ?? trigger;
}

export function RulesTab() {
  const { data, isLoading } = useAutomationRules();
  const update = useUpdateAutomationRule();
  const del = useDeleteAutomationRule();
  const qc = useQueryClient();

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AutomationRuleRow | null>(null);
  const [deleting, setDeleting] = React.useState<AutomationRuleRow | null>(null);

  const rules = data?.data ?? [];

  const toggleActive = (rule: AutomationRuleRow, checked: boolean) => {
    qc.setQueryData<{ data: AutomationRuleRow[] }>(RULES_QUERY_KEY, (old) =>
      old ? { data: old.data.map((r) => (r.id === rule.id ? { ...r, is_active: checked } : r)) } : old,
    );
    update.mutate(
      { id: rule.id, is_active: checked },
      {
        onSuccess: () => toast.success(checked ? "Automação ligada." : "Automação pausada."),
        onError: () => qc.invalidateQueries({ queryKey: RULES_QUERY_KEY }),
      },
    );
  };

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (rule: AutomationRuleRow) => {
    setEditing(rule);
    setEditorOpen(true);
  };

  if (isLoading) {
    return (
      <div className="grid gap-3 pt-4 sm:grid-cols-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (rules.length === 0) {
    return (
      <div className="flex justify-center pt-10">
        <Card className="max-w-md">
          <CardHeader className="items-center text-center">
            <Robot className="mb-2 h-10 w-10 text-accent" />
            <CardTitle>Crie sua primeira automação</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              Ex.: quando entrar um contato novo, enviar uma mensagem de boas-vindas.
            </p>
            <Button onClick={openCreate}>
              <Plus /> Nova automação
            </Button>
          </CardContent>
        </Card>
        <RuleEditor open={editorOpen} onOpenChange={setEditorOpen} rule={editing} />
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus /> Nova automação
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rules.map((r) => (
          <Card key={r.id}>
            <CardHeader className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="truncate">{r.name}</CardTitle>
                <Badge variant={r.is_active ? "success" : "neutral"}>
                  {r.is_active ? "Ativa" : "Pausada"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{triggerLabel(r.trigger_event)}</p>
              <p className="text-xs text-muted-foreground">
                {r.actions.length} {r.actions.length === 1 ? "ação" : "ações"}
              </p>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-2">
              <Switch
                checked={r.is_active}
                disabled={update.isPending}
                onCheckedChange={(checked) => toggleActive(r, checked)}
                aria-label={`${r.is_active ? "Pausar" : "Ligar"} ${r.name}`}
              />
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => openEdit(r)}
                  aria-label="Editar automação"
                >
                  <PencilSimple />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setDeleting(r)}
                  aria-label="Excluir automação"
                >
                  <Trash />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <RuleEditor open={editorOpen} onOpenChange={setEditorOpen} rule={editing} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir esta automação?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.name} para de rodar imediatamente. Essa ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleting) return;
                await del.mutateAsync(deleting.id);
                toast.success("Automação excluída.");
                setDeleting(null);
              }}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
