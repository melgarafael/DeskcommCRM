"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

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
import { useT } from "@/hooks/i18n/useT";
import { renameAgentAction } from "../_actions";
import {
  CODIGO_NOME_DE_AGENTE_EM_USO,
  NOME_DE_AGENTE_EM_USO,
} from "@/lib/ai/agents/nome-repetido";
import type { AgentRow } from "@/hooks/ai/useAgent";

interface Props {
  agent: AgentRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RenameAgentDialog({ agent, open, onOpenChange }: Props) {
  const t = useT();
  const router = useRouter();
  const [name, setName] = useState(agent.name);
  const [isPending, startTransition] = useTransition();
  // Nome que a organização já usa (#3952): a frase fica no campo, e o diálogo
  // continua aberto com o nome digitado para a pessoa trocar.
  const [erroNoNome, setErroNoNome] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(agent.name);
      setErroNoNome(null);
    }
  }, [open, agent.name]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await renameAgentAction(agent.id, name);
      if (res.ok) {
        toast.success(t("Renomeado."));
        onOpenChange(false);
        router.refresh();
      } else if (res.error === CODIGO_NOME_DE_AGENTE_EM_USO) {
        setErroNoNome(t(NOME_DE_AGENTE_EM_USO));
      } else {
        toast.error(res.message ?? `${t("Falha")}: ${res.error}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Renomear agente")}</DialogTitle>
          <DialogDescription>
            {t("Apenas o nome interno muda. Versões publicadas e histórico são preservados.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agent-name">{t("Nome")}</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => {
                setErroNoNome(null);
                setName(e.target.value);
              }}
              maxLength={120}
              required
              autoFocus
              aria-invalid={!!erroNoNome}
              aria-describedby={erroNoNome ? "erro-do-nome-renomear" : undefined}
            />
            {erroNoNome ? (
              <p id="erro-do-nome-renomear" role="alert" className="text-xs text-destructive">
                {erroNoNome}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={isPending || name.trim().length === 0}>
              {t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
