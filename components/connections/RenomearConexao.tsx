"use client";

import { useEffect, useState } from "react";
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
import { apiClient } from "@/lib/api/client";
import { PencilSimple } from "@/lib/ui/icons";

export function RenomearConexao({
  channelId,
  currentName,
  onSaved,
}: {
  channelId: string;
  currentName: string | null;
  onSaved: () => void | Promise<unknown>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => setName(currentName ?? ""), [currentName]);

  // #2892: o `name` digitado sobrevivia ao Cancelar e reaparecia na
  // reabertura — o useEffect acima só repunha quando `currentName` MUDAVA.
  // Repor na abertura cobre as duas portas: o clique em Renomear e qualquer
  // `onOpenChange(true)`; o Cancelar (e o X, e o Escape) só fecham.
  function abrirDialogo() {
    setName(currentName ?? "");
    setOpen(true);
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await apiClient.patch(`/api/v1/channel-sessions/${channelId}/name`, {
        display_name: trimmed,
      });
      toast.success(t("Nome interno atualizado."));
      setOpen(false);
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? t(error.message) : t("Não foi possível salvar o nome."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={abrirDialogo}>
        <PencilSimple size={14} aria-hidden />
        {t("Renomear")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? abrirDialogo() : setOpen(false))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Nome interno da conexão")}</DialogTitle>
            <DialogDescription>
              {t("Só a sua equipe vê este nome. O nome público no provedor não muda.")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`connection-name-${channelId}`}>{t("Nome interno")}</Label>
            <Input
              id={`connection-name-${channelId}`}
              value={name}
              maxLength={80}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
              placeholder={t("Ex.: WA | Fixo 7906")}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              {t("Cancelar")}
            </Button>
            <Button onClick={() => void save()} disabled={saving || !name.trim()}>
              {saving ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
