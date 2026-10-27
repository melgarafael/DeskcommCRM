/**
 * O vocabulário dos avisos da agência (docs/agencia/SPEC-avisos.md › Tipos).
 * Constante compartilhada — nunca string solta (CLAUDE.md › Modelagem, colunas
 * de vocabulário aberto: `agencia_avisos.tipo` não tem CHECK e cresce por fase).
 */
export const TIPOS_DE_AVISO = [
  "teste",
  "convite_aceito",
  "tarefa_atribuida",
  "prazo_chegando",
  "prazo_hoje",
  "prazo_atrasado",
  "reuniao_marcada",
  "reuniao_alterada",
  "reuniao_lembrete",
  "etapa_liberada",
  "formulario_enviado",
  "contrato_concluido",
  "aprovacao_respondida",
  "publicacao_feita",
  "publicacao_falhou",
  "envio_aguardando_drive",
] as const;

export type TipoDeAviso = (typeof TIPOS_DE_AVISO)[number];

/** Como uma mensagem agrupada chama vários avisos do mesmo tipo. */
export const PLURAL_DO_TIPO: Record<TipoDeAviso, string> = {
  teste: "avisos de teste",
  convite_aceito: "convites aceitos",
  tarefa_atribuida: "tarefas novas",
  prazo_chegando: "prazos chegando",
  prazo_hoje: "prazos que vencem hoje",
  prazo_atrasado: "tarefas atrasadas",
  reuniao_marcada: "reuniões marcadas",
  reuniao_alterada: "reuniões alteradas",
  reuniao_lembrete: "reuniões chegando",
  etapa_liberada: "etapas liberadas",
  formulario_enviado: "formulários preenchidos",
  contrato_concluido: "contratos assinados e pagos",
  aprovacao_respondida: "aprovações respondidas",
  publicacao_feita: "publicações no ar",
  publicacao_falhou: "publicações que falharam",
  envio_aguardando_drive: "envios aprovados esperando o Drive",
};
