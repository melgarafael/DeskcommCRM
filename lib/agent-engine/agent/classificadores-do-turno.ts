/**
 * QUAIS classificadores auxiliares o turno paga — a decisão, fora do turno.
 *
 * Mesmo motivo de `aux-model-args.ts` existir fora de `runAgentTurn`: a regra é
 * a parte que erra, e dentro de `executarTurnoDoAgente` (não exportada, precisa
 * do turno inteiro) ela ficaria sem como ser exercitada por teste unitário.
 *
 * Os dois auxiliares leem a MENSAGEM NOVA do cliente. No `followup_turn` e no
 * `case_reply_turn` não há mensagem nova: a última do cliente já foi
 * classificada no turno dela, e reclassificá-la pagava duas chamadas de modelo
 * para devolver a mesma resposta. É o critério que o Jev já usava. A prévia
 * (`jobKind === null`) simula uma mensagem nova e continua classificando.
 *
 * Perda aceita, por escrito: a escalação "manipulação alta + promessa fora de
 * tabela" não dispara em turno sem mensagem nova — a manipulação daquela
 * mensagem já foi medida no turno dela, e o veto determinístico de promessa
 * (F4-01) segue valendo em todo envio.
 */
export interface EntradaDosClassificadores {
  /** `null` = prévia (sem job operacional). */
  jobKind: string | null;
  /** O knob `stageClassifier` montado no boot. */
  estagioLigado: boolean;
  /**
   * O conversador tem `update_lead_state` neste turno. Sem ela (entregue ao
   * Operador), a sugestão mandaria usar uma ferramenta que ele não tem — paga e
   * contraditória.
   */
  temQuemConfirmeOEstagio: boolean;
  /** A camada anti-manipulação está ligada para a organização. */
  manipulacaoLigada: boolean;
  /** O que o cliente mandou por último (texto ou o derivado da mídia). */
  ultimaMensagemDoCliente: string;
}

export function classificadoresDoTurno(e: EntradaDosClassificadores): {
  estagio: boolean;
  manipulacao: boolean;
} {
  const mensagemNova = e.jobKind === null || e.jobKind === 'inbound_turn';
  return {
    estagio: e.estagioLigado && mensagemNova && e.temQuemConfirmeOEstagio,
    // Mensagem vazia não tem o que classificar: era uma chamada paga sobre "".
    manipulacao: e.manipulacaoLigada && mensagemNova && e.ultimaMensagemDoCliente.trim() !== '',
  };
}
