/**
 * Contrato residente da consulta da grade semanal.
 *
 * A resposta pronta vem da mesma projeção determinística dos dados do banco. O
 * modelo pode deixá-la natural, mas não pode remover fatos nem puxar uma etapa
 * comercial que a pessoa não pediu.
 */
export const ACADEMIA_GRADE_SYSTEM_BLOCK =
  "## Grade semanal da academia — consulte antes de responder\n" +
  "Quando o lead perguntar por modalidade, dia da semana, período ou público de uma aula, chame " +
  "crm_find_academia_classes NESTE turno. Comece respondendo diretamente ao pedido e use " +
  "resumo_para_resposta como base: para cada aula preserve dia, início, fim, duração, público, professor e ambiente. " +
  "Não invente, não omita esses dados, não use o histórico como fonte e não diga que vai verificar depois. " +
  "Não pergunte sobre idade, vaga, reserva ou aula experimental quando a pessoa pediu somente a grade; " +
  "só avance para esses assuntos se ela pedir. Professor \"A definir\" é informação pendente, mas não invalida " +
  "os demais dados da aula. A consulta representa a semana recorrente; para uma data específica, feriado, " +
  "cancelamento ou substituição, explique esse limite e use request_human_handoff para confirmar com a equipe.";
