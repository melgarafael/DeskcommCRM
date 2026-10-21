"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { stageColorSchema, stageDecoration } from "@/lib/ui-themes/pipeline-presentation";

export function StageColor({
  pipelineId,
  stageId,
  name,
  color,
}: {
  pipelineId: string;
  stageId: string;
  name: string;
  color: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(color ?? "#808080");
  const save = useMutation({
    mutationFn: (value: string | null) =>
      apiClient.patch(`/api/v1/pipelines/${pipelineId}/stages/${stageId}`, {
        color: stageColorSchema.parse(value),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) });
      setOpen(false);
    },
    onError: showApiError,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (save.isPending) return;
        setOpen(value);
        if (value) setDraft(color ?? "#808080");
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`${t("Cor da etapa")}: ${name}`}
          className="h-9 w-9 shrink-0 rounded-md border border-border p-2"
          title={t("Cor da etapa")}
        >
          <span
            className="block h-full w-full rounded-full bg-text-muted/40"
            style={{ backgroundColor: stageDecoration(color) }}
          />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t("Cor da etapa")} · {name}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("A cor identifica esta etapa. Não altera ganho, perda ou o estado dos negócios.")}
        </p>
        <label className="flex items-center justify-between gap-3">
          {t("Escolher cor")}
          <input
            type="color"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={save.isPending}
          />
        </label>
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("Não foi possível salvar. Sua escolha foi preservada para tentar novamente.")}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => setOpen(false)}
          >
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            {t("Restaurar padrão")}
          </Button>
          <Button type="button" disabled={save.isPending} onClick={() => save.mutate(draft)}>
            {t(save.isPending ? "Salvando…" : "Salvar cor")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
