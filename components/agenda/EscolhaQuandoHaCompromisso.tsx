"use client";

import * as React from "react";

import { useT } from "@/hooks/i18n/useT";
import { type EscolhaNoEnvio } from "@/lib/agenda/escolha-no-envio";

/**
 * AS TRÊS RESPOSTAS PARA "E SE O CONTATO TIVER HORÁRIO MARCADO?" (#3813).
 *
 * ─── Por que um módulo compartilhado ───────────────────────────────────────
 *
 * A pergunta nasceu na automação (o config de cada passo que envia) e o
 * follow-up do agente faz a MESMA pergunta sobre a configuração publicada
 * (`lib/followup/janela-de-disparo.ts` lê `quando_ha_compromisso` ao lado de
 * `send_window`). Duas cópias dos três rótulos divergem no dia em que uma
 * recebe uma palavra nova — e o operador passa a ver duas perguntas parecidas
 * com respostas que ele não sabe se valem a mesma coisa. Por isso o vocabulário
 * e o seletor moram AQUI, e não dentro de uma das telas.
 *
 * ─── O que a tela NÃO decide ───────────────────────────────────────────────
 *
 * Nada de régua: quem lê o valor é `lerEscolhaNoEnvio`
 * (`lib/agenda/escolha-no-envio.ts`), no disparo. Este arquivo só mostra a
 * escolha e devolve o valor — o efeito (adiar, enviar, pular com motivo
 * `compromisso_na_agenda`) já está medido no motor.
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

/**
 * O seletor. `escolha` já vem LIDA (`lerEscolhaNoEnvio`) — quem chama não
 * reimplementa a tolerância a config velha.
 *
 * `disabled` existe porque no follow-up a escolha só faz sentido com o
 * follow-up ligado: um campo ativo numa seção desligada gravaria uma
 * preferência que o motor nem lê.
 */
export function EscolhaQuandoHaCompromisso({
  escolha,
  onChange,
  disabled = false,
  ajudaExtra,
}: {
  escolha: EscolhaNoEnvio;
  onChange: (escolha: EscolhaNoEnvio) => void;
  disabled?: boolean;
  /** Frase curta do contexto de quem usa (ex.: o alcance no follow-up). */
  ajudaExtra?: string;
}) {
  const t = useT();
  const grupo = React.useId();

  return (
    <fieldset className="space-y-1" disabled={disabled}>
      <legend id={`${grupo}-rotulo`} className="text-sm font-medium leading-none">
        {t("Quando o contato tiver horário marcado")}
      </legend>
      <p className="text-xs text-muted-foreground">
        {t(
          "Em qualquer das três continuam valendo o descadastro do contato, a janela de envio do número e o limite diário.",
        )}
      </p>
      {ajudaExtra ? <p className="text-xs text-muted-foreground">{t(ajudaExtra)}</p> : null}
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
              className="mt-1"
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">{t(opcao.rotulo)}</span>
              <span className="block text-xs text-muted-foreground">{t(opcao.ajuda)}</span>
            </span>
          </label>
        ))}
      </div>
      {disabled ? (
        <p className="text-xs text-muted-foreground">
          {t("Ligue o follow-up para escolher o que fazer com quem tem horário marcado.")}
        </p>
      ) : null}
    </fieldset>
  );
}
