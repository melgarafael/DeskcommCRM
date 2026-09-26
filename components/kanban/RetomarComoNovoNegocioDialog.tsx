"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";

interface RetomarComoNovoNegocioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  /** A etapa em que o operador soltou o card — onde a nova tentativa nasce. */
  stageId: string;
  pipelineId: string;
}

/**
 * "Retomar como novo negócio" — a TELA que o 409 `reabertura_cria_novo`
 * aponta (issue #1538).
 *
 * Num funil `settings.reabertura = "novo_negocio"` o arrasto de um card
 * encerrado não reabre o registro; este diálogo chama
 * `POST /api/v1/leads/{id}/retomar`, que cria a nova tentativa com o mesmo
 * contato (campos e tags copiados conforme `settings.reabertura_campos`), com
 * `source = "retomada"` e `retomado_de_lead_id` apontando para o original —
 * que NÃO é tocado: status, motivo e linha do tempo dele ficam intactos.
 *
 * O board é invalidado pelo próprio `useMoveCard` no `onSettled` do arrasto;
 * aqui só de novo depois do 201, porque a criação acontece DEPOIS daquela
 * rodada de invalidação.
 */
export function RetomarComoNovoNegocioDialog({
  open,
  onOpenChange,
  leadId,
  stageId,
  pipelineId,
}: RetomarComoNovoNegocioDialogProps) {
  const t = useT();
  const qc = useQueryClient();
  const [criando, setCriando] = useState(false);

  const handleSubmit = async () => {
    if (criando) return;
    setCriando(true);
    try {
      await apiClient.post(`/api/v1/leads/${leadId}/retomar`, { stage_id: stageId });
      await qc.invalidateQueries({ queryKey: ["board", pipelineId] });
      onOpenChange(false);
    } catch (erro) {
      if (erro instanceof ApiError) showApiError(erro);
      else throw erro;
    } finally {
      setCriando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Retomar como novo negócio")}</DialogTitle>
          <DialogDescription>
            {t(
              "Este funil não reabre negócios encerrados. Retomar cria um negócio novo com o mesmo contato, copiando campos e tags, e guarda a ligação com este — o negócio original fica intacto, com o motivo dele.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={criando}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={criando}>
            {criando ? t("Retomando…") : t("Retomar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
