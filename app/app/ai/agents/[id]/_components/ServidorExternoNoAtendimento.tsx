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
  /** `ai_agents.config.mcp_externo_no_atendimento` como está no banco (pode ser undefined). */
  inicial: unknown;
  disabled?: boolean;
}

/**
 * Cartão "servidor de ferramentas externo no atendimento" (#2147, opção A).
 *
 * Ligado, o servidor MCP externo da organização também entra em turno de
 * conversa, e cada requisição a ele leva a identidade do cliente da conversa
 * em cabeçalho (`lib/mcp/servidor-externo/carregar.ts`). Só quem é admin vê:
 * a rota que grava também só aceita admin.
 */
export function ServidorExternoNoAtendimento({ agentId, inicial, disabled }: Props) {
  const t = useT();
  const [ligado, setLigado] = useState<boolean>(inicial === true);
  const [salvando, setSalvando] = useState(false);

  async function alternar(valor: boolean) {
    const anterior = ligado;
    setLigado(valor);
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, {
        config: { mcp_externo_no_atendimento: valor },
      });
      toast.success(
        valor
          ? t("Servidor de ferramentas externo ligado no atendimento.")
          : t("Servidor de ferramentas externo desligado no atendimento."),
      );
    } catch (err) {
      setLigado(anterior);
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <Switch
          id="mcp_externo_no_atendimento"
          checked={ligado}
          onCheckedChange={alternar}
          disabled={disabled || salvando}
        />
        <Label htmlFor="mcp_externo_no_atendimento">
          {t("Usar o servidor de ferramentas externo durante o atendimento")}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "O servidor recebe a identidade do cliente da conversa e deve filtrar os dados por ela.",
        )}
      </p>
    </Card>
  );
}
