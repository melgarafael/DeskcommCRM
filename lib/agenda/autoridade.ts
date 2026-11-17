/**
 * QUEM MANDA NO COMPROMISSO (#4227, etapa 1 de 2 do doc 356).
 *
 * `calendar_appointments.authority` é `'local'` de fábrica: a agenda do CRM é a
 * dona do horário. Outro valor diz que um sistema de fora (o de uma clínica,
 * por exemplo) é a autoridade, e a linha daqui é o espelho dele — quem marca,
 * remarca e cancela é aquele sistema, pelo módulo que o integra. O nome do
 * provedor é vocabulário aberto, de cada módulo; o banco só guarda a coerência
 * (migration 9392).
 *
 * O mesmo vale para `calendar_event_types.external_provider`: tipo de
 * atendimento que veio de fora não se marca pela agenda local.
 *
 * Quem lê isto: os crons da agenda (lembrete e expiração de pendentes) só
 * consideram linha local, e os handlers de marcar, remarcar e cancelar recusam
 * o que é de fora. A etapa 2 troca a recusa pelo caminho do módulo.
 */
export const AUTORIDADE_LOCAL = "local";

export const RECUSA_DE_AUTORIDADE_EXTERNA =
  "Este compromisso é gerido por um sistema externo integrado. Remarque ou cancele por lá.";

export const RECUSA_DE_TIPO_EXTERNO =
  "Este tipo de atendimento vem de um sistema externo integrado e não se marca pela agenda local.";
