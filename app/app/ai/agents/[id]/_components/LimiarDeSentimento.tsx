"use client";

import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { DEFAULT_SENTIMENT_THRESHOLD } from "@/lib/ai/prompts/sentiment";

interface Props {
  agentId: string;
  /** `ai_agents.config.sentiment_threshold` como está no banco (pode ser undefined). */
  inicial?: unknown;
  disabled?: boolean;
}

/**
 * Cartão "Limiar de sentimento" na tela do AGENTE (issue #2209).
 *
 * O worker já lia `config.sentiment_threshold` — o campo não estava em
 * formulário nenhum e o schema do PATCH o descartava, então a única forma de
 * mexer no limiar era SQL direto no banco (foi o contorno medido numa
 * instalação de advocacia, onde uma frase que só descrevia o problema
 * disparava a passagem para humano). Aqui a porta pública daquela chave:
 * mesma rota PATCH que os demais campos de `config`, gravada e relida na hora.
 *
 * Salva no `onBlur` (e no Enter, que chama o blur), não a cada tecla: um PATCH
 * por dígito encheia a fila de requisições de quem só estava conferindo o
 * número. Sem botão próprio de salvar — o valor vale assim que o campo perde o
 * foco, e o erro de digitação cai no toast, sem gravar nada.
 */
export function LimiarDeSentimento({ agentId, inicial, disabled }: Props) {
  const t = useT();
  const gravado = typeof inicial === "number" ? inicial : DEFAULT_SENTIMENT_THRESHOLD;
  const [texto, setTexto] = useState(String(gravado));
  const [ultimoSalvo, setUltimoSalvo] = useState(gravado);
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    const bruto = texto.trim().replace(",", ".");
    const nota = Number(bruto);
    if (bruto === "" || !Number.isFinite(nota) || nota < 0 || nota > 1) {
      setTexto(String(ultimoSalvo));
      toast.error(t("Digite um valor entre 0 e 1."));
      return;
    }
    if (nota === ultimoSalvo) {
      setTexto(String(ultimoSalvo));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, {
        config: { sentiment_threshold: nota },
      });
      setUltimoSalvo(nota);
      setTexto(String(nota));
      toast.success(t("Limiar de sentimento salvo — vale a partir do próximo clima classificado."));
    } catch (err) {
      setTexto(String(ultimoSalvo));
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("Limiar de sentimento")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Abaixo desta nota o clima é considerado fechado e a conversa passa para uma pessoa. Quem só descreve o problema que o trouxe até aqui não irritou ninguém, então esse relato não deve custar a passagem para o humano.",
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="sentiment_threshold">{t("Nota mínima do clima, de 0 a 1")}</Label>
          <Input
            id="sentiment_threshold"
            type="number"
            inputMode="decimal"
            step={0.05}
            min={0}
            max={1}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onBlur={salvar}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            disabled={disabled || salvando}
            className="w-28"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {`${t("Padrão")}: ${DEFAULT_SENTIMENT_THRESHOLD}`}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Nota mais alta manda mais conversas para uma pessoa; mais baixa deixa só a hostilidade forte acionar a passagem.",
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          "Em nichos onde todo contato chega como queixa — advocacia, saúde, assistência técnica —, relatar o problema não é irritação. O que aciona a passagem é hostilidade com o atendimento, ameaça ou pedido agressivo de falar com uma pessoa.",
        )}
      </p>
    </Card>
  );
}
