"use client";

import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  TETO_DA_FRASE_DO_AVISO,
  normalizarFraseDoAviso,
} from "@/lib/escalacao/frase-do-aviso-configurada";

interface Props {
  agentId: string;
  /** `ai_agents.config.aviso_de_handoff` como está no banco (pode ser undefined). */
  inicial?: unknown;
  disabled?: boolean;
}

/**
 * Cartão "Frase do aviso de passagem" na tela do AGENTE (#3725, tela no #3816).
 *
 * ## Por que existe
 *
 * O aviso que o cliente lê quando a IA sai de campo era uma frase FIXA do
 * código. O runtime passou a aceitar a frase do tenant em
 * `ai_agents.config.aviso_de_handoff` (#3725), mas nada escrevia essa chave: o
 * `agentConfigPatchSchema` a descartava no PATCH e não havia campo no editor —
 * dava para configurar só por SQL. Schema sem tela é promessa que ninguém
 * configura.
 *
 * ## As decisões
 *
 * **Vazio grava `null`, não `""`.** É o `null` que devolve o padrão do produto
 * (`lerFraseDoAvisoConfigurada` recusa string vazia e cai no padrão); gravar
 * `""` deixaria a frase ANTIGA valendo e a tela mostrando um campo em branco —
 * a pior combinação possível.
 *
 * **A validação é a MESMA do runtime.** `normalizarFraseDoAviso` é quem decide o
 * que serve (tamanho mínimo, teto de `TETO_DA_FRASE_DO_AVISO`, ao menos uma
 * letra ou número), então a tela recusa antes de gastar um PATCH que o servidor
 * aceitaria e a leitura ignoraria em silêncio.
 *
 * **Botão próprio, e não salvar a cada tecla.** A frase é texto livre: um PATCH
 * por dígito encheria a fila de quem só estava conferindo o texto. Sem alteração
 * o botão fica desligado — salvar o que já está gravado só gera ruído no log.
 */
export function FraseDoAviso({ agentId, inicial, disabled }: Props) {
  const t = useT();
  const gravado = typeof inicial === "string" ? inicial : "";
  const [frase, setFrase] = useState(gravado);
  const [ultimoSalvo, setUltimoSalvo] = useState(gravado);
  const [salvando, setSalvando] = useState(false);

  const semAlteracao = frase.trim() === ultimoSalvo.trim();

  async function salvar() {
    const limpa = frase.replace(/\s+/g, " ").trim();
    // Frase vazia é o caminho de VOLTA ao padrão; qualquer outra precisa passar
    // na validação do runtime antes de virar PATCH.
    if (limpa !== "" && normalizarFraseDoAviso(limpa) === null) {
      toast.error(
        t("A frase precisa ter entre 3 e 320 caracteres, com pelo menos uma letra ou número."),
      );
      return;
    }
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, {
        config: { aviso_de_handoff: limpa === "" ? null : limpa },
      });
      setFrase(limpa);
      setUltimoSalvo(limpa);
      toast.success(
        limpa === ""
          ? t("Frase própria removida — o cliente volta a ler o aviso padrão.")
          : t("Frase do aviso salva — vale no próximo aviso de passagem."),
      );
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("Frase do aviso de passagem")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "É o que o cliente lê quando o agente passa a conversa para uma pessoa. Deixe vazio para usar a frase padrão.",
          )}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="aviso_de_handoff">{t("Frase do aviso de passagem")}</Label>
        <Input
          id="aviso_de_handoff"
          value={frase}
          onChange={(e) => setFrase(e.target.value)}
          placeholder={t("Ex.: Já chamei alguém do time — já te respondemos.")}
          disabled={disabled || salvando}
        />
        {/* Sem `maxLength` de propósito: o teto é conferido no salvar, com a MESMA
            função do runtime. `maxLength` esconderia o excesso (o texto colado
            seria cortado em silêncio) e o dono não saberia por que a frase
            "mudou sozinha". */}
        <p className="text-xs text-muted-foreground">
          {frase.length > TETO_DA_FRASE_DO_AVISO
            ? t("A frase passa do limite de 320 caracteres.")
            : `${frase.length}/${TETO_DA_FRASE_DO_AVISO}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={salvar}
          disabled={disabled || salvando || semAlteracao}
        >
          {t("Salvar frase")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("Vazio = frase padrão do produto.")}</p>
      </div>
    </Card>
  );
}
