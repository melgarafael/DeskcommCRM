"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useMoveLeadToPipeline } from "@/hooks/kanban/useUpdateLead";
import { useDestinosDeFunil } from "@/hooks/kanban/useDestinosDeFunil";

interface MoveToOtherPipelineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
}

/**
 * "Levar para outro funil" — a TELA que faltava para
 * `POST /api/v1/leads/[id]/clone` (a rota já existe, testada, e fecha a
 * origem sozinha com o motivo canônico; aqui só se escolhe o destino).
 *
 * Sem seletor de etapa: a rota já escolhe a primeira etapa aberta do funil
 * destino quando nenhuma é informada — um segundo campo aqui duplicaria uma
 * decisão que o servidor já toma bem, pela doutrina DIRC ("calcular" antes de
 * "duplicar").
 */
export function MoveToOtherPipelineDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
}: MoveToOtherPipelineDialogProps) {
  const t = useT();
  const [targetPipelineId, setTargetPipelineId] = useState("");
  const mutation = useMoveLeadToPipeline(pipelineId);
  const destinos = useDestinosDeFunil(leadId, open);

  const disabled = !targetPipelineId || mutation.isPending;

  const handleSubmit = async () => {
    if (disabled) return;
    try {
      await mutation.mutateAsync({ leadId, targetPipelineId });
      setTargetPipelineId("");
      onOpenChange(false);
    } catch {
      // error already toasted
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTargetPipelineId("");
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Levar para outro funil")}</DialogTitle>
          <DialogDescription>
            {t(
              'O negócio é recriado no funil escolhido e este encerra como perdido, com o motivo "Levado para outro funil" — o histórico dos dois lados fica registrado na linha do tempo.',
            )}
          </DialogDescription>
        </DialogHeader>

        {/*
          Instalação nova nasce com UM funil só: sem esta frase o diálogo abre
          com uma lista vazia e um botão que nunca habilita, sem dizer por quê.
        */}
        {destinos.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("Este é o único funil. Crie outro funil para poder levar o negócio até ele.")}
          </p>
        ) : (
          <Select value={targetPipelineId} onValueChange={setTargetPipelineId}>
            <SelectTrigger aria-label={t("Funil de destino")}>
              <SelectValue placeholder={t("Escolha o funil de destino")} />
            </SelectTrigger>
            <SelectContent>
              {(destinos.data ?? []).map((pipeline) => (
                <SelectItem key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t("Cancelar")}
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {mutation.isPending ? t("Salvando...") : t("Confirmar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
