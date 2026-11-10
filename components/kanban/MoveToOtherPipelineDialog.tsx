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
import {
  etapasAbertasDoDestino,
  useDestinosDeFunil,
} from "@/hooks/kanban/useDestinosDeFunil";

interface MoveToOtherPipelineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
}

/**
 * "Levar para outro funil" — a TELA de `POST /api/v1/leads/[id]/clone` (a rota
 * já existe, testada, e fecha a origem sozinha com o motivo canônico; aqui só
 * se escolhe o destino).
 *
 * ── A etapa de entrada (issue #3643) ────────────────────────────────────────
 *
 * Este diálogo só pedia o funil, com uma justificativa explícita: "a rota já
 * escolhe a primeira etapa aberta — um segundo campo duplicaria uma decisão que
 * o servidor já toma bem". Ela estava errada no caso MAIS COMUM da troca, que é
 * o negócio ter avançado: SDR → Closer cai em "Novo", cliente levado para
 * pós-venda cai em "Onboarding", e o card precisa ser arrastado de novo, etapa
 * por etapa, gerando `stage_changed` falsos, disparando automações de etapas
 * que o negócio nunca viveu e distorcendo o tempo por etapa nos relatórios.
 *
 * A decisão do servidor NÃO foi duplicada, foi mantida como PADRÃO: nenhuma
 * etapa escolhida = o corpo é o de antes (`{pipeline_id}`), e `escolheEtapaDeDestino`
 * segue escolhendo a primeira aberta. O campo só manda `stage_id` quando a
 * pessoa escolhe uma etapa.
 *
 * Duas garantias de tela, e a de baixo é a que evita 422 silencioso:
 *
 * - trocar de funil LIMPA a etapa: a lista é a do funil, e a etapa anterior é
 *   de outro funil — o servidor recusaria (`stage_pipeline_mismatch`);
 * - funil sem etapa aberta diz isso na tela e desabilita o Confirmar, em vez de
 *   mandar o pedido para receber `pipeline_without_initial_stage` no toast.
 */
export function MoveToOtherPipelineDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
}: MoveToOtherPipelineDialogProps) {
  const t = useT();
  const [targetPipelineId, setTargetPipelineId] = useState("");
  const [targetStageId, setTargetStageId] = useState("");
  const mutation = useMoveLeadToPipeline(pipelineId);
  const destinos = useDestinosDeFunil(leadId, open);

  const destino = (destinos.data ?? []).find((p) => p.id === targetPipelineId);
  const etapas = etapasAbertasDoDestino(destino);
  const funilSemEtapaAberta = !!destino && etapas.length === 0;

  const disabled = !targetPipelineId || funilSemEtapaAberta || mutation.isPending;

  const handleSubmit = async () => {
    if (disabled) return;
    try {
      await mutation.mutateAsync({
        leadId,
        targetPipelineId,
        targetStageId: targetStageId || null,
      });
      setTargetPipelineId("");
      setTargetStageId("");
      onOpenChange(false);
    } catch {
      // error already toasted
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTargetPipelineId("");
          setTargetStageId("");
        }
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
          <Select
            value={targetPipelineId}
            onValueChange={(next) => {
              setTargetPipelineId(next);
              // A etapa é do funil: manter a anterior mandaria um `stage_id` de
              // OUTRO funil, que o servidor recusa com 422.
              setTargetStageId("");
            }}
          >
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

        {funilSemEtapaAberta ? (
          <p className="text-sm text-destructive" role="alert">
            {t(
              "Este funil não tem etapa aberta para receber o negócio. Escolha outro funil.",
            )}
          </p>
        ) : destino ? (
          <div className="space-y-1">
            <Select value={targetStageId} onValueChange={setTargetStageId}>
              <SelectTrigger aria-label={t("Etapa de entrada")}>
                <SelectValue placeholder={t("Primeira etapa aberta (padrão)")} />
              </SelectTrigger>
              <SelectContent>
                {etapas.map((etapa) => (
                  <SelectItem key={etapa.id} value={etapa.id}>
                    {etapa.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("Sem escolha, o negócio entra na primeira etapa aberta do funil.")}
            </p>
          </div>
        ) : null}

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
