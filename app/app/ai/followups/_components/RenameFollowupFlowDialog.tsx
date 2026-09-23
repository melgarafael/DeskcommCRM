"use client";

import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRenameFollowupFlow } from "@/hooks/followup/useFollowupFlow";

interface Props {
  flowId: string;
  flowName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function RenameForm({
  flowId,
  flowName,
  onClose,
}: {
  flowId: string;
  flowName: string;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(flowName);
  const [erro, setErro] = useState<string | null>(null);
  const rename = useRenameFollowupFlow();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);
    rename.mutate(
      { id: flowId, name: name.trim() },
      {
        onSuccess: () => {
          setErro(null);
          onClose();
        },
        onError: (err: unknown) => {
          setErro(
            err instanceof Error && err.message
              ? t(err.message)
              : t("Não consegui renomear o fluxo. Tente de novo."),
          );
        },
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="rename-flow-name">{t("Nome")}</Label>
        <Input
          id="rename-flow-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
          autoFocus
        />
      </div>
      {erro && (
        <p role="alert" data-testid="rename-flow-error" className="text-sm text-error-fg">
          {erro}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={rename.isPending}>
          {t("Cancelar")}
        </Button>
        <Button
          type="submit"
          disabled={rename.isPending || name.trim().length === 0 || name.trim() === flowName}
        >
          {rename.isPending ? t("Salvando…") : t("Salvar")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RenameFollowupFlowDialog({ flowId, flowName, open, onOpenChange }: Props) {
  const t = useT();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t("Renomear fluxo")}</DialogTitle>
          <DialogDescription>
            {t("Só o nome interno muda. Inscrições e a versão publicada continuam as mesmas.")}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <RenameForm flowId={flowId} flowName={flowName} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
