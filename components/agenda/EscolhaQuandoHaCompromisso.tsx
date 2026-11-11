"use client";

import * as React from "react";

import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { lerEscolhaNoEnvio, type EscolhaNoEnvio } from "@/lib/agenda/escolha-no-envio";

/**
 * #3813 — AS TRÊS RESPOSTAS PARA "E SE O CONTATO TIVER HORÁRIO MARCADO?".
 *
 * O componente nasceu dentro do editor de REGRAS (passo que envia) e agora serve
 * às duas superfícies que leem a mesma chave: o `config` do passo de automação e
 * o `followup` publicado do agente. Ele mora em `components/agenda/` porque
 * duplicá-lo daria duas telas que dizem a mesma coisa com palavras que divergem
 * no primeiro ajuste de texto — e a escolha é UMA (`lib/agenda/escolha-no-envio`).
 *
 * A ajuda de cada opção diz o EFEITO, não o nome do campo: quem lê isto é quem
 * descobriu que os parabéns saíram duas semanas atrasados.
 */
export const ESCOLHAS_DA_AGENDA: Array<{
  valor: EscolhaNoEnvio;
  rotulo: string;
  ajuda: string;
}> = [
  {
    valor: "adiar",
    rotulo: "Adiar e enviar depois do horário",
    ajuda:
      "A mensagem espera o atendimento terminar e sai logo depois. É o comportamento de sempre e o que continua valendo em quem nunca mexeu aqui.",
  },
  {
    valor: "enviar",
    rotulo: "Enviar mesmo assim",
    ajuda:
      "A mensagem sai na hora, mesmo com atendimento marcado. Serve para o pós-atendimento e o aniversário, que perdem o sentido se esperarem.",
  },
  {
    valor: "nao_enviar",
    rotulo: "Não enviar",
    ajuda:
      "A mensagem não sai e o pulo fica registrado na Atividade com o motivo “contato com horário marcado”, para a equipe saber que a automação passou.",
  },
];

export function EscolhaQuandoHaCompromisso({
  escolha,
  onChange,
  disabled,
}: {
  /** O valor JÁ lido com `lerEscolhaNoEnvio` — quem chama não reimplementa a leitura. */
  escolha: EscolhaNoEnvio;
  onChange: (escolha: EscolhaNoEnvio) => void;
  /**
   * Desligado quando o dono do envio está desligado (follow-up parado, por
   * exemplo): oferecer a escolha ali prometeria um efeito que não acontece.
   */
  disabled?: boolean;
}) {
  const t = useT();
  const grupo = React.useId();

  return (
    <div className="space-y-1">
      <Label id={`${grupo}-rotulo`}>{t("Quando o contato tiver horário marcado")}</Label>
      <p className="text-xs text-muted-foreground">
        {t(
          "Em qualquer das três continuam valendo o descadastro do contato, a janela de envio do número e o limite diário.",
        )}
      </p>
      <div role="radiogroup" aria-labelledby={`${grupo}-rotulo`} className="space-y-1">
        {ESCOLHAS_DA_AGENDA.map((opcao) => (
          <label
            key={opcao.valor}
            className="flex cursor-pointer items-start gap-2 rounded-md border p-3"
          >
            <input
              type="radio"
              name={grupo}
              value={opcao.valor}
              checked={escolha === opcao.valor}
              onChange={() => onChange(opcao.valor)}
              disabled={disabled}
              className="mt-1"
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">{t(opcao.rotulo)}</span>
              <span className="block text-xs text-muted-foreground">{t(opcao.ajuda)}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Reexporta a leitura para quem já importa o componente e precisa do valor
 * tolerante (a chave ausente vale `adiar`): uma importação só, sem dois
 * caminhos para a mesma pergunta.
 */
export { lerEscolhaNoEnvio };
