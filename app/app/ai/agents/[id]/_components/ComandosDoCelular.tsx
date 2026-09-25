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
import {
  COMANDO_DESLIGAR_PADRAO,
  COMANDO_LIGAR_PADRAO,
} from "@/lib/escalacao/comando-de-canal";

interface Props {
  agentId: string;
  /** `ai_agents.config` como está no banco (pode ser undefined). */
  configInicial: {
    aceita_comandos_celular?: unknown;
    comando_ligar?: unknown;
    comando_desligar?: unknown;
  };
  disabled?: boolean;
  aoSalvar?: () => void;
}

function textoInicial(valor: unknown, padrao: string): string {
  return typeof valor === "string" && valor.trim() !== "" ? valor : padrao;
}

/**
 * Cartão "Comandos pelo celular" na tela do AGENTE (C-076 + C-077).
 *
 * Liga/desliga o reconhecimento dos comandos enviados do celular e permite
 * ESCOLHER as sequências que ligam e desligam a IA — `#on`/`#off` por padrão,
 * mas pode ser uma palavra leiga ("religar") ou um emoji.
 *
 * É uma decisão de PRODUTO, e por isso mora na tela e não numa migration: o
 * comando é digitado no chat do CLIENTE, que pode vê-lo. Desligado (default), as
 * mensagens do operador apenas pausam a IA, como qualquer outra.
 */
export function ComandosDoCelular({ agentId, configInicial, disabled, aoSalvar }: Props) {
  const t = useT();
  const [ligado, setLigado] = useState<boolean>(configInicial.aceita_comandos_celular === true);
  const [ligar, setLigar] = useState<string>(
    textoInicial(configInicial.comando_ligar, COMANDO_LIGAR_PADRAO),
  );
  const [desligar, setDesligar] = useState<string>(
    textoInicial(configInicial.comando_desligar, COMANDO_DESLIGAR_PADRAO),
  );
  const [salvando, setSalvando] = useState(false);

  const conflito = ligar.trim().toLowerCase() === desligar.trim().toLowerCase();
  const vazios = ligar.trim() === "" || desligar.trim() === "";

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

  async function alternar(valor: boolean) {
    const anterior = ligado;
    setLigado(valor);
    try {
      await salvarConfig(
        { aceita_comandos_celular: valor },
        valor
          ? t("Comandos pelo celular ligados — já valem no próximo atendimento.")
          : t("Comandos pelo celular desligados."),
      );
    } catch {
      setLigado(anterior);
    }
  }

  async function salvarSequencias() {
    if (vazios || conflito) return;
    await salvarConfig(
      { comando_ligar: ligar.trim(), comando_desligar: desligar.trim() },
      t("Comandos salvos — já valem no próximo atendimento."),
    );
  }

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("Comandos pelo celular")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Ligado, o atendente pode pausar e devolver o automático digitando os comandos no próprio WhatsApp do celular. Desligado, essas mensagens são tratadas como texto comum.",
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
          {t("Aceitar comandos enviados pelo celular")}
        </Label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="comando_ligar">{t("Comando para LIGAR a IA")}</Label>
          <Input
            id="comando_ligar"
            value={ligar}
            maxLength={32}
            onChange={(e) => setLigar(e.target.value)}
            placeholder={COMANDO_LIGAR_PADRAO}
            disabled={disabled || salvando}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="comando_desligar">{t("Comando para DESLIGAR a IA")}</Label>
          <Input
            id="comando_desligar"
            value={desligar}
            maxLength={32}
            onChange={(e) => setDesligar(e.target.value)}
            placeholder={COMANDO_DESLIGAR_PADRAO}
            disabled={disabled || salvando}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={salvarSequencias}
          disabled={disabled || salvando || vazios || conflito}
        >
          {t("Salvar comandos")}
        </Button>
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => {
            setLigar(COMANDO_LIGAR_PADRAO);
            setDesligar(COMANDO_DESLIGAR_PADRAO);
          }}
          disabled={disabled || salvando}
        >
          {t("Voltar ao padrão (#on / #off)")}
        </button>
      </div>

      {vazios ? (
        <p className="text-xs text-destructive">{t("Os dois comandos precisam de um texto.")}</p>
      ) : conflito ? (
        <p className="text-xs text-destructive">
          {t("O comando de ligar e o de desligar não podem ser iguais.")}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t(
          "Pode ser uma palavra ou um emoji. Só conta quando a mensagem inteira é o comando — “religar” ou “🔴” sozinhos valem, mas a mesma palavra no meio de uma frase não. O comando é digitado no chat do cliente e pode aparecer para ele.",
        )}
      </p>
    </Card>
  );
}
