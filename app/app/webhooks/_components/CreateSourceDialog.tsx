"use client";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  useCreateWebhookSource,
  usePipelines,
  usePipelineStages,
  type WebhookSourceRow,
} from "@/hooks/webhooks/useWebhookSources";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (source: WebhookSourceRow) => void;
}

export function CreateSourceDialog({ open, onOpenChange, onCreated }: Props) {
  const [name, setName] = React.useState("");
  const [pipelineId, setPipelineId] = React.useState<string>("");
  const [stageId, setStageId] = React.useState<string>("");
  const [redirectTo, setRedirectTo] = React.useState("");

  const { data: pipelinesRes, isLoading: pipelinesLoading } = usePipelines();
  const { data: boardRes, isLoading: stagesLoading } = usePipelineStages(pipelineId || null);
  const create = useCreateWebhookSource();

  const pipelines = pipelinesRes?.data ?? [];
  const stages = boardRes?.data?.stages ?? [];

  React.useEffect(() => {
    if (!open) {
      setName("");
      setPipelineId("");
      setStageId("");
      setRedirectTo("");
    }
  }, [open]);

  React.useEffect(() => {
    setStageId("");
  }, [pipelineId]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pipelineId || !stageId) {
      toast.error("Escolha o funil e o estágio de entrada.");
      return;
    }
    try {
      const res = await create.mutateAsync({
        name,
        default_pipeline_id: pipelineId,
        default_stage_id: stageId,
        redirect_to: redirectTo.trim() || undefined,
      });
      toast.success("Fonte criada. Agora é só conectar seu site.");
      onOpenChange(false);
      onCreated(res.data);
    } catch {
      /* erro já mostrado pelo showApiError */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova fonte de captação</DialogTitle>
          <DialogDescription>
            Dê um nome e diga em qual funil o contato deve entrar quando alguém preencher seu
            formulário.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="src-name">Nome</Label>
            <Input
              id="src-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Landing page de Black Friday"
              minLength={1}
              maxLength={120}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>Funil de entrada</Label>
            <Select value={pipelineId} onValueChange={setPipelineId} disabled={pipelinesLoading}>
              <SelectTrigger>
                <SelectValue placeholder="Escolha o funil" />
              </SelectTrigger>
              <SelectContent>
                {pipelines.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Estágio de entrada</Label>
            <Select
              value={stageId}
              onValueChange={setStageId}
              disabled={!pipelineId || stagesLoading}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={pipelineId ? "Escolha o estágio" : "Escolha o funil primeiro"}
                />
              </SelectTrigger>
              <SelectContent>
                {stages.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="src-redirect">URL de obrigado (opcional)</Label>
            <Input
              id="src-redirect"
              type="url"
              value={redirectTo}
              onChange={(e) => setRedirectTo(e.target.value)}
              placeholder="https://seusite.com/obrigado"
            />
            <p className="text-xs text-muted-foreground">
              Para onde enviar a pessoa depois que ela preencher seu formulário.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Criar fonte
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
