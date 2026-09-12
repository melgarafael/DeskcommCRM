/**
 * O motivo do fim de uma chamada, em linguagem de gente.
 *
 * O WaCalls devolve o vocabulário do `EndCallReason` dele — `user_ended`,
 * `do_not_disturb`, `timeout` — e a coluna `voice_calls.end_reason` guarda o
 * valor cru de propósito (é vocabulário de terceiro, sem CHECK, para não
 * quebrar quando o upstream ganhar um valor novo).
 *
 * O que NÃO pode acontecer é esse token chegar à tela. O aviso da Central
 * nascia com o corpo `Motivo: user_ended`: quem opera o CRM não fala inglês de
 * protocolo, e "user_ended" ainda por cima é ambíguo — o "user" ali é a pessoa
 * do outro lado, não quem lê o aviso.
 *
 * Motivo desconhecido NÃO é escondido: a frase diz que não sabemos e mostra o
 * token entre parênteses. Sumir com ele deixaria quem for investigar sem a
 * única pista que existe, e uma frase tranquilizadora onde não há informação é
 * pior que a informação estranha.
 */
const MOTIVOS: Record<string, string> = {
  user_ended: 'Quem ligou desligou antes de alguém atender.',
  declined: 'A chamada foi recusada.',
  rejected: 'A chamada foi recusada.',
  timeout: 'O telefone tocou e ninguém atendeu.',
  busy: 'A linha estava ocupada.',
  cancelled: 'A chamada foi cancelada.',
  canceled: 'A chamada foi cancelada.',
  failed: 'A chamada falhou antes de completar.',
  do_not_disturb: 'O aparelho estava no modo "não perturbe".',
  unknown: 'A chamada terminou sem que o WhatsApp informasse o motivo.',
};

/** Frase em português para o `end_reason` cru do upstream. */
export function motivoDaChamadaEmPortugues(motivo: string | null | undefined): string {
  const cru = (motivo ?? '').trim();
  if (!cru) return MOTIVOS['unknown']!;
  const conhecido = MOTIVOS[cru.toLowerCase()];
  if (conhecido) return conhecido;
  return `A chamada terminou por um motivo que ainda não sabemos traduzir (${cru}).`;
}
