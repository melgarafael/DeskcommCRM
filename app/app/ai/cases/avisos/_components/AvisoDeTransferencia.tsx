"use client";
/**
 * O interruptor das TRANSFERÊNCIAS (#3784). Fora do formulário do aviso de
 * propósito: aquele salva pelo RPC de `config_aviso_de_caso`, e esta opção mora
 * em `settings.crm` — misturar as duas num "Salvar" só faria uma gravação
 * depender da outra. Ligada por padrão, como o aviso de Propostas.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirAvisoDeTransferencia } from "@/app/actions/settings/definirAvisoDeTransferencia";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

export function AvisoDeTransferencia({ ligada }: { ligada: boolean }) {
  const t = useT();
  const [valor, setValor] = useState(ligada);
  const [pendente, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Card className="flex items-start gap-3 p-4">
      <Switch
        id="avisar_transferencia_no_whatsapp"
        checked={valor}
        disabled={pendente}
        onCheckedChange={(novo) =>
          startTransition(async () => {
            const r = await definirAvisoDeTransferencia(novo);
            if (!r.ok) {
              toast.error(t(r.error ?? "Não foi possível salvar."));
              return;
            }
            setValor(novo);
            toast.success(t("Opção salva."));
            router.refresh();
          })
        }
      />
      <div className="space-y-1">
        <Label htmlFor="avisar_transferencia_no_whatsapp" className="text-sm font-medium">
          {t("Avisar também nas transferências para atendimento humano")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t(
            "Cada transferência manda uma mensagem ao mesmo número e conta no limite diário dele. Desligue para receber só os avisos de casos.",
          )}
        </p>
      </div>
    </Card>
  );
}
