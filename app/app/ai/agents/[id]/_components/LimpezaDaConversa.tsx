"use client";

import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { COMANDO_LIMPAR_PADRAO } from "@/lib/escalacao/limpeza-de-conversa";

interface Props {
  agentId: string;
  /** `ai_agents.config` como está no banco (pode ser undefined). */
  configInicial: {
    aceita_limpeza_cliente?: unknown;
    permite_limpeza_atendente?: unknown;
    comando_limpar?: unknown;
  };
  disabled?: boolean;
  aoSalvar?: () => void;
}

function textoInicial(valor: unknown, padrao: string): string {
  return typeof valor === "string" && valor.trim() !== "" ? valor : padrao;
}

/**
 * Cartão "Limpeza de conversa" na tela do AGENTE (C-104).
 *
 * Duas portas, dois interruptores, uma decisão de produto cada:
 *   - o CLIENTE apaga os próprios dados mandando o comando no WhatsApp;
 *   - o ATENDENTE apaga pela tela da conversa.
 *
 * Ambos salvam em `ai_agents.config` (parcial, o PATCH faz merge) e o ingest/rota
 * releem a MESMA flag — a tela só torna visível o que o servidor já enforcementa.
 * Default dos dois: DESLIGADO. Apagar dado é irreversível.
 */
export function LimpezaDaConversa({ agentId, configInicial, disabled, aoSalvar }: Props) {
  const t = useT();
  const [clienteLigado, setClienteLigado] = useState<boolean>(
    configInicial.aceita_limpeza_cliente === true,
  );
  const [atendenteLigado, setAtendenteLigado] = useState<boolean>(
    configInicial.permite_limpeza_atendente === true,
  );
  const [comando, setComando] = useState<string>(
    textoInicial(configInicial.comando_limpar, COMANDO_LIMPAR_PADRAO),
  );
  const [salvando, setSalvando] = useState(false);

  const vazio = comando.trim() === "";

  async function salvarConfig(patch: Record<string, unknown>, msg: string) {
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, { config: patch });
      toast.success(msg);
      aoSalvar?.();
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarCliente(valor: boolean) {
    const anterior = clienteLigado;
    setClienteLigado(valor);
    try {
      await salvarConfig(
        { aceita_limpeza_cliente: valor },
        valor
          ? t("Limpeza pedida pelo cliente ligada — já vale no próximo atendimento.")
          : t("Limpeza pedida pelo cliente desligada."),
      );
    } catch {
      setClienteLigado(anterior);
    }
  }

  async function alternarAtendente(valor: boolean) {
    const anterior = atendenteLigado;
    setAtendenteLigado(valor);
    try {
      await salvarConfig(
        { permite_limpeza_atendente: valor },
        valor
          ? t("Limpeza pela conversa ligada — o botão aparece no atendimento.")
          : t("Limpeza pela conversa desligada."),
      );
    } catch {
      setAtendenteLigado(anterior);
    }
  }

  async function salvarComando() {
    if (vazio) return;
    await salvarConfig(
      { comando_limpar: comando.trim() },
      t("Comando de limpeza salvo — já vale no próximo atendimento."),
    );
  }

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("Limpeza de conversa")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Apaga tudo o que o CRM guarda de um cliente: o contato da lista, a conversa, as mensagens e os interesses. A ação é irreversível e o próximo contato começa do zero.",
          )}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="aceita_limpeza_cliente"
          checked={clienteLigado}
          onCheckedChange={alternarCliente}
          disabled={disabled || salvando}
        />
        <Label htmlFor="aceita_limpeza_cliente">
          {t("O cliente pode apagar os próprios dados pelo WhatsApp")}
        </Label>
      </div>

      <div className="space-y-1">
        <Label htmlFor="comando_limpar">{t("Comando para apagar (a mensagem inteira)")}</Label>
        <Input
          id="comando_limpar"
          value={comando}
          maxLength={32}
          onChange={(e) => setComando(e.target.value)}
          placeholder={COMANDO_LIMPAR_PADRAO}
          disabled={disabled || salvando}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={salvarComando}
          disabled={disabled || salvando || vazio}
        >
          {t("Salvar comando")}
        </Button>
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => setComando(COMANDO_LIMPAR_PADRAO)}
          disabled={disabled || salvando}
        >
          {t("Voltar ao padrão (#limpar)")}
        </button>
      </div>

      {vazio ? (
        <p className="text-xs text-destructive">{t("O comando precisa de um texto.")}</p>
      ) : null}

      <div className="flex items-center gap-2 border-t pt-4">
        <Switch
          id="permite_limpeza_atendente"
          checked={atendenteLigado}
          onCheckedChange={alternarAtendente}
          disabled={disabled || salvando}
        />
        <Label htmlFor="permite_limpeza_atendente">
          {t("O atendente pode apagar pela tela da conversa")}
        </Label>
      </div>

      <p className="text-xs text-muted-foreground">
        {t(
          "Pode ser uma palavra ou um emoji. Só conta quando a mensagem inteira é o comando. O cliente verá a mensagem que enviou.",
        )}
      </p>
    </Card>
  );
}
