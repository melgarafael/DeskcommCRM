"use client";
import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useAnonymizeContact } from "@/hooks/contacts/useAnonymizeContact";

interface Props {
  contactId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const CONFIRM_TEXT = "ANONIMIZAR";

export function AnonymizeDialog({ contactId, open, onOpenChange }: Props) {
  const anon = useAnonymizeContact();
  const [step, setStep] = useState<1 | 2>(1);
  const [justification, setJustification] = useState("");
  const [confirm, setConfirm] = useState("");

  function reset() {
    setStep(1);
    setJustification("");
    setConfirm("");
  }

  async function handleSubmit() {
    try {
      const res = await anon.mutateAsync({
        contact_id: contactId,
        justification: justification.trim(),
      });
      if (res.data.action === "already_anonymized") {
        toast.info("Contato já estava anonimizado.");
      } else {
        toast.success("Contato anonimizado.");
      }
      reset();
      onOpenChange(false);
    } catch {
      // hook handles toast
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-error-fg">Anonimizar contato (LGPD)</DialogTitle>
          <DialogDescription>
            Esta ação é irreversível. O nome será substituído por &quot;Contato Anonimizado #N&quot;,
            email/telefone/NUIT serão limpos, e atividades terão conteúdo redigido.
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="anon-justif">Justificativa (mínimo 10 caracteres)</Label>
              <Textarea
                id="anon-justif"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Ex.: Solicitação formal do titular via email em DD/MM/YYYY"
                rows={4}
              />
              <p className="text-xs text-muted-foreground">
                {justification.trim().length}/10 caracteres mínimos
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                Cancelar
              </Button>
              <Button
                variant="destructive"
                onClick={() => setStep(2)}
                disabled={justification.trim().length < 10}
              >
                Continuar
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border border-error-fg/30 bg-error-bg p-3 text-sm text-error-fg">
              Para confirmar, digite <strong>{CONFIRM_TEXT}</strong> abaixo.
            </div>
            <div className="space-y-2">
              <Label htmlFor="anon-confirm">Confirmação</Label>
              <Input
                id="anon-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={CONFIRM_TEXT}
                autoComplete="off"
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep(1)} disabled={anon.isPending}>
                Voltar
              </Button>
              <Button
                variant="destructive"
                onClick={handleSubmit}
                disabled={confirm !== CONFIRM_TEXT || anon.isPending}
              >
                {anon.isPending ? "Anonimizando…" : "Anonimizar permanentemente"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
