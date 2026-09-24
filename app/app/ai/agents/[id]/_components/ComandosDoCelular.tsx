"use client";

import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

interface Props {
  agentId: string;
  /** `ai_agents.config.aceita_comandos_celular` como está no banco (pode ser undefined). */
  inicial: unknown;
  disabled?: boolean;
  aoSalvar?: (ligado: boolean) => void;
}

/**
 * Cartão "Comandos pelo celular" na tela do AGENTE (C-076).
 *
 * Liga/desliga o reconhecimento de `#on`/`#off` enviados do celular vinculado.
 * É uma decisão de PRODUTO, e por isso mora na tela e não numa migration: o
 * comando é digitado no chat do CLIENTE, que pode vê-lo. Desligado (default), a
 * mensagem do operador apenas pausa a IA, como qualquer outra.
 */
export function ComandosDoCelular({ agentId, inicial, disabled, aoSalvar }: Props) {
  const t = useT();
  const [ligado, setLigado] = useState<boolean>(inicial === true);
  const [salvando, setSalvando] = useState(false);

  async function alternar(valor: boolean) {
    const anterior = ligado;
    setLigado(valor);
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, {
        config: { aceita_comandos_celular: valor },
      });
      toast.success(
        valor
          ? t("Comandos pelo celular ligados — já valem no próximo atendimento.")
          : t("Comandos pelo celular desligados."),
      );
      aoSalvar?.(valor);
    } catch (err) {
      setLigado(anterior);
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("Comandos pelo celular")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Ligado, o atendente pode enviar #off para pausar o automático e #on para devolvê-lo à IA, digitando no próprio WhatsApp do celular. Desligado, essas mensagens são tratadas como texto comum.",
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="aceita_comandos_celular"
          checked={ligado}
          onCheckedChange={alternar}
          disabled={disabled || salvando}
        />
        <Label htmlFor="aceita_comandos_celular">
          {t("Aceitar #on/#off enviados pelo celular")}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Atenção: o comando é digitado no chat do cliente e pode aparecer para ele. Vale por conversa, e a pausa só termina com #on ou pelo botão “devolver ao automático”.",
        )}
      </p>
    </Card>
  );
}
