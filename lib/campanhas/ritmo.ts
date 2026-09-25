/**
 * O ritmo PRÓPRIO da campanha, por cima do ritmo do canal.
 *
 * ═══ Por que existe um ritmo a mais ═══
 *
 * O canal protege o número no dia a dia (`channel_knobs`: throttle de 1,2 s,
 * janela, warm-up, e o teto de `channel_sessions.daily_message_limit`). Isso
 * basta para atendimento, onde cada mensagem responde alguém que escreveu. Não
 * basta para lista FRIA: 30 mensagens em 30 minutos, do mesmo número, para quem
 * nunca falou com a empresa, é o padrão que o WhatsApp bane — e número banido
 * não volta em dias, volta em semanas de warm-up.
 *
 * ═══ Por que não há tabela nova (Spec 13 §4.1) ═══
 *
 * A "proteção de envio por conexão" que a Spec 13 desenha já existe neste repo,
 * com tela (`AntiBanSheet`) e motor (`decidePacing` + `pacing_ledger`). Este
 * módulo é só o OVERRIDE da campanha, e ele só sabe ir mais devagar: o efetivo é
 * o mais restritivo entre os dois, sempre. Campos `null` herdam o canal.
 *
 * Puro de propósito: "pode mandar agora?" é a decisão mais fácil de errar em
 * silêncio, e a mais cara quando erra.
 */

import { horaNoFuso } from "./relogio";

export interface RitmoDaCampanha {
  intervaloSegundos: number | null;
  janelaInicioHora: number | null;
  janelaFimHora: number | null;
  tetoDiario: number | null;
  tetoHorario: number | null;
}

export interface EstadoDoEnvio {
  /** Quando a ÚLTIMA mensagem desta campanha saiu. `null` = nenhuma ainda. */
  ultimoEnvio: Date | null;
  /** Quantas desta campanha já saíram no dia local de hoje. */
  enviadasHoje: number;
  /** Quantas desta campanha saíram na última hora corrida. */
  enviadasNaUltimaHora: number;
}

export type MotivoDeEspera = "intervalo" | "fora_da_janela" | "teto_diario" | "teto_horario";

export type VetoDeRitmo =
  | { pode: true }
  | { pode: false; motivo: MotivoDeEspera; detalhe: string };

/** A hora local (0-23) do instante, no fuso dado. Reexportada por conveniência. */
export { horaNoFuso as horaLocal };

/**
 * Pode mandar agora?
 *
 * A ordem dos vetos é a do mais barato para o mais caro de descobrir, mas também
 * a da mensagem mais útil: "faltam 4 min" é diferente de "hoje acabou" e de
 * "fora do horário".
 *
 * Nada aqui é falha: ritmo é ESPERA. O destinatário continua pendente e a rodada
 * seguinte tenta de novo — marcar `failed` por ritmo faria a campanha perder
 * gente por estar funcionando como projetada.
 */
export function podeMandarAgora(
  ritmo: RitmoDaCampanha,
  estado: EstadoDoEnvio,
  agora: Date,
  fuso: string,
): VetoDeRitmo {
  if (ritmo.tetoDiario !== null && estado.enviadasHoje >= ritmo.tetoDiario) {
    return {
      pode: false,
      motivo: "teto_diario",
      detalhe: `A campanha já mandou ${estado.enviadasHoje} hoje, que é o teto dela.`,
    };
  }

  if (ritmo.tetoHorario !== null && estado.enviadasNaUltimaHora >= ritmo.tetoHorario) {
    return {
      pode: false,
      motivo: "teto_horario",
      detalhe: `A campanha já mandou ${estado.enviadasNaUltimaHora} na última hora, que é o teto dela.`,
    };
  }

  if (ritmo.janelaInicioHora !== null && ritmo.janelaFimHora !== null) {
    const hora = horaNoFuso(agora, fuso);
    if (hora < ritmo.janelaInicioHora || hora >= ritmo.janelaFimHora) {
      return {
        pode: false,
        motivo: "fora_da_janela",
        detalhe: `Fora do horário da campanha (${ritmo.janelaInicioHora}h-${ritmo.janelaFimHora}h).`,
      };
    }
  }

  if (ritmo.intervaloSegundos !== null && estado.ultimoEnvio) {
    const decorrido = (agora.getTime() - estado.ultimoEnvio.getTime()) / 1000;
    if (decorrido < ritmo.intervaloSegundos) {
      const faltam = Math.ceil(ritmo.intervaloSegundos - decorrido);
      return { pode: false, motivo: "intervalo", detalhe: `Faltam ${faltam}s para o próximo envio.` };
    }
  }

  return { pode: true };
}

/**
 * Quando faz sentido tentar de novo — o `next_attempt_at` do destinatário.
 *
 * Não é precisão de relógio: é para a fila não ser varrida a cada tique por uma
 * campanha que só volta amanhã. Erra sempre para MENOS (tenta um pouco antes),
 * porque quem tenta cedo recebe outro veto barato; quem tenta tarde perde janela.
 */
export function proximaTentativa(veto: VetoDeRitmo, agora: Date): Date | null {
  if (veto.pode) return null;
  const ms = agora.getTime();
  switch (veto.motivo) {
    case "intervalo":
      // O detalhe carrega os segundos que faltam; reconstruí-los seria duplicar
      // a conta. Um minuto é o grão do cron — abaixo disso não há ganho.
      return new Date(ms + 60_000);
    case "teto_horario":
      return new Date(ms + 10 * 60_000);
    case "fora_da_janela":
    case "teto_diario":
      return new Date(ms + 30 * 60_000);
  }
}
