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
import { useCreateFollowupFlow } from "@/hooks/followup/useFollowupFlows";
import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Superfície do fluxo criado. Ausente = 'followup' (default do banco). */
  surface?: FollowupFlowSurface;
}

export function NewFlowDialog({ open, onOpenChange, surface }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const create = useCreateFollowupFlow();
  const deAtendimento = surface === "atendimento";

  const [erro, setErro] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);
    create.mutate(
      { name: name.trim(), ...(surface ? { surface } : {}) },
      {
      onSuccess: () => {
        setName("");
        setErro(null);
        onOpenChange(false);
      },
      // Sem isto o POST podia falhar e o diálogo ficava lá, parado, sem dizer
      // nada: o usuário clica "Criar fluxo" de novo achando que não pegou. O
      // erro fica DENTRO do diálogo (não num toast que some) porque é ali que
      // ele está olhando, e o diálogo NÃO fecha — fechar apagaria o nome digitado.
      onError: (err: unknown) => {
        setErro(
          err instanceof Error && err.message
            ? t(err.message)
            : t("Não consegui criar o fluxo. Tente de novo."),
        );
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName("");
          setErro(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {deAtendimento ? t("Novo fluxo de atendimento") : t("Novo fluxo de follow-up")}
          </DialogTitle>
          <DialogDescription>
            {deAtendimento
              ? t("Nasce como rascunho. Você cadastra as perguntas e a finalização no editor em seguida.")
              : t("Nasce como rascunho. Você monta as etapas no editor visual em seguida.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="flow-name">Nome</Label>
            <Input
              id="flow-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("Ex: Recuperação de carrinho abandonado")}
              maxLength={80}
              required
              autoFocus
            />
          </div>
          {erro && (
            <p role="alert" data-testid="new-flow-error" className="text-sm text-error-fg">
              {erro}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending || name.trim().length === 0}>
              {create.isPending ? "Criando…" : "Criar fluxo"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
