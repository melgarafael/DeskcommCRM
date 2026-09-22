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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useLoseLead } from "@/hooks/kanban/useUpdateLead";
import { CANONICAL_LOST_REASONS } from "@/lib/schemas/leads";

const REASON_LABELS: Record<(typeof CANONICAL_LOST_REASONS)[number], string> = {
  requested_by_customer: "Cliente solicitou cancelamento",
  price: "Preço",
  no_response: "Sem resposta do cliente",
  product_unavailable: "Produto indisponível",
  cancelled_by_store: "Cancelado pela loja",
  cancelled_by_customer: "Cancelado pelo cliente",
  payment_failed: "Falha no pagamento",
  other: "Outro motivo",
};

interface LoseLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
}

const MAX_LEN = 500;

export function LoseLeadDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
}: LoseLeadDialogProps) {
  const t = useT();
  const [reasonCode, setReasonCode] = useState<string>("");
  const [otherText, setOtherText] = useState("");
  const mutation = useLoseLead(pipelineId);

  const finalReason = reasonCode === "other" ? otherText.trim() || "other" : reasonCode;
  const disabled = !reasonCode || finalReason.length === 0 || finalReason.length > MAX_LEN || mutation.isPending;

  const handleSubmit = async () => {
    if (disabled) return;
    try {
      await mutation.mutateAsync({ leadId, lostReason: finalReason });
      setReasonCode("");
      setOtherText("");
      onOpenChange(false);
    } catch {
      // error already toasted
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Marcar como perdido")}</DialogTitle>
          <DialogDescription>
            {t("Informe o motivo. Essa informação ajuda a melhorar o funil.")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Label>{t("Motivo")}</Label>
          <div className="grid grid-cols-1 gap-1.5">
            {CANONICAL_LOST_REASONS.map((code) => (
              <label
                key={code}
                className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent"
              >
                <input
                  type="radio"
                  name="lost-reason"
                  value={code}
                  checked={reasonCode === code}
                  onChange={(e) => setReasonCode(e.target.value)}
                />
                <span>{t(REASON_LABELS[code])}</span>
              </label>
            ))}
          </div>
          {reasonCode === "other" && (
            <div className="grid gap-1.5">
              <Label htmlFor="lost-reason-other">{t("Detalhe (opcional)")}</Label>
              <Textarea
                id="lost-reason-other"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder={t("Ex: Cliente desistiu por X motivo")}
                maxLength={MAX_LEN}
                rows={3}
              />
              <div className="text-right text-[11px] text-muted-foreground tabular-nums">
                {otherText.length}/{MAX_LEN}
              </div>
            </div>
          )}
        </div>

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
