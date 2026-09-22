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

  useEffect(() => {
    if (open) setName(agent.name);
  }, [open, agent.name]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await renameAgentAction(agent.id, name);
      if (res.ok) {
        toast.success(t("Renomeado."));
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.message ?? `${t("Falha")}: ${res.error}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Renomear funcionário")}</DialogTitle>
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
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
              autoFocus
            />
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
