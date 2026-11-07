export const STATUS_AVALIACAO = [
  "agendado",
  "em_avaliacao",
  "cancelado",
  "atrasado",
  "aguardando",
  "avaliado",
] as const;

export type StatusAvaliacao = (typeof STATUS_AVALIACAO)[number];

export const ROTULO_STATUS: Record<StatusAvaliacao, string> = {
  agendado: "Agendado",
  em_avaliacao: "Em avaliação",
  cancelado: "Cancelado",
  atrasado: "Atrasado",
  aguardando: "Aguardando",
  avaliado: "Avaliado",
};

export const ACOES_TRANSICAO = [
  "cancelar",
  "reativar",
  "aguardando",
  "reverter",
  "iniciar_avaliacao",
  "concluir",
] as const;

export type AcaoTransicaoAvaliacao = (typeof ACOES_TRANSICAO)[number];
