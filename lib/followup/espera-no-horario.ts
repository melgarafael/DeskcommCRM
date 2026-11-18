import {
  lerJanelaDeAtendimento,
  msAteAJanelaAbrir,
  type JanelaDeAtendimento,
} from "@/lib/agent-engine/agent/janela-de-atendimento";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

/**
 * A ESPERA QUE SÓ TERMINA EM HORÁRIO COMERCIAL (`wait.ate_o_horario`).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * Uma espera fixa conta a partir do passo anterior. Num fluxo "boas-vindas → 24 h
 * → lembrete → 48 h → último toque", o lembrete sai à MESMA hora do formulário:
 * quem se cadastrou às 2h da manhã recebe o lembrete às 2h da manhã do dia
 * seguinte. As duas réguas de horário que o envio conhece não resolvem isso sem
 * estragar outra coisa:
 *
 *  - a janela de disparo do CANAL (`channel_knobs`) vale para todo envio
 *    proativo do número — inclusive a boas-vindas, que precisa sair na hora;
 *  - a faixa do AGENTE (`followup.send_window`) vale para a inscrição inteira, e
 *    exige um agente fixado nela.
 *
 * Faltava a régua no lugar certo: a ESPERA que antecede o passo. É ela que diz
 * "24 h, e se cair de noite ou no domingo, até a próxima abertura".
 *
 * ─── A regra ───────────────────────────────────────────────────────────────
 *
 * O fim da espera é empurrado para a próxima abertura do horário quando cai fora
 * dele. Dias e horas são do nó; o FUSO é o da organização (`organizations.timezone`),
 * o mesmo relógio da condição por data e da faixa do agente — nenhum terceiro
 * relógio nasce aqui.
 *
 * A conta de calendário NÃO é reescrita: é `lerJanelaDeAtendimento` +
 * `msAteAJanelaAbrir`, as mesmas funções do horário de atendimento do agente e da
 * faixa do follow-up. Três leitores de "aberto agora?" concordam por construção.
 *
 * ─── Falha ABERTA ──────────────────────────────────────────────────────────
 *
 * Horário que não dá para obedecer (início depois do fim, nenhum dia, hora torta)
 * vira "sem horário": a espera termina na duração configurada, como antes. O
 * publish recusa esse horário (`horario_da_espera_invalido`), então só um grafo
 * escrito à mão chega aqui assim — e uma config quebrada não pode virar mordaça
 * que segura o lead para sempre. Fuso inválido cai no padrão do produto
 * (`fusoUtilizavel`), como em todo o resto do follow-up.
 */
export interface HorarioDaEspera {
  /** `HH:MM` local. */
  start: string;
  /** `HH:MM` local, maior que `start` (janela que vira a meia-noite não é suportada). */
  end: string;
  /** 0=domingo … 6=sábado. */
  weekdays: number[];
}

/** A janela que a espera obedece, ou `null` quando não há horário (ou ele não dá para obedecer). */
export function janelaDaEspera(
  horario: HorarioDaEspera | undefined,
  fuso: string | null | undefined,
): JanelaDeAtendimento | null {
  if (!horario) return null;
  return lerJanelaDeAtendimento({
    filters: {
      business_hours: {
        timezone: fusoUtilizavel(fuso),
        start: horario.start,
        end: horario.end,
        weekdays: horario.weekdays,
      },
    },
  });
}

/**
 * O primeiro instante, a partir de `instante`, em que o horário está aberto:
 * o próprio `instante` quando já está, a próxima abertura quando não está.
 * Sem janela, devolve `instante` — a espera de sempre.
 */
export function primeiroInstanteNoHorario(instante: Date, janela: JanelaDeAtendimento | null): Date {
  if (janela === null) return instante;
  const falta = msAteAJanelaAbrir(janela, instante);
  return falta === null ? instante : new Date(instante.getTime() + falta);
}

/** O publish usa isto: o horário escrito no nó dá para obedecer? (o fuso não entra: é o da organização) */
export function horarioDaEsperaValido(horario: HorarioDaEspera): boolean {
  return janelaDaEspera(horario, "UTC") !== null;
}
