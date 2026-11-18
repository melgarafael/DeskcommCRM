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
import { definirNomeNaTransferencia } from "@/app/actions/settings/definirNomeNaTransferencia";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

export function AvisoDeTransferencia({
  ligada,
  comNome,
}: {
  ligada: boolean;
  comNome: boolean;
}) {
  const t = useT();
  const [valor, setValor] = useState(ligada);
  const [nome, setNome] = useState(comNome);
  const [pendente, startTransition] = useTransition();
  const [pendenteNome, startNome] = useTransition();
  const router = useRouter();
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start gap-3">
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
      </div>

      {valor && (
        <div className="flex items-start gap-3 border-t pt-3 pl-11">
          <Switch
            id="aviso_transferencia_com_nome"
            checked={nome}
            disabled={pendenteNome}
            onCheckedChange={(novo) =>
              startNome(async () => {
                const r = await definirNomeNaTransferencia(novo);
                if (!r.ok) {
                  toast.error(t(r.error ?? "Não foi possível salvar."));
                  return;
                }
                setNome(novo);
                toast.success(t("Opção salva."));
                router.refresh();
              })
            }
          />
          <div className="space-y-1">
            <Label htmlFor="aviso_transferencia_com_nome" className="text-sm font-medium">
              {t("Incluir o primeiro nome do cliente na mensagem")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                "Por padrão a mensagem leva só o link. Com esta opção, ela também mostra o primeiro nome do cliente. O motivo da transferência continua só no CRM, ao abrir a conversa.",
              )}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
