/** O vocabulário do quadro de tarefas (docs/agencia/SPEC-tarefas.md, T1). CHECK no banco (9004). */
export const COLUNAS = ["backlog", "a_fazer", "em_andamento", "revisao", "concluido"] as const;
export type Coluna = (typeof COLUNAS)[number];

export const ROTULO_DA_COLUNA: Record<Coluna, string> = {
  backlog: "Backlog",
  a_fazer: "A fazer",
  em_andamento: "Em andamento",
  revisao: "Revisão",
  concluido: "Concluído",
};

export const PRIORIDADES = ["baixa", "media", "alta", "urgente"] as const;
export type Prioridade = (typeof PRIORIDADES)[number];

export const ROTULO_DA_PRIORIDADE: Record<Prioridade, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
  urgente: "Urgente",
};

export const PADROES = ["diaria", "semanal", "mensal"] as const;
export type Padrao = (typeof PADROES)[number];

export const ROTULO_DO_PADRAO: Record<Padrao, string> = {
  diaria: "Todo dia",
  semanal: "Toda semana",
  mensal: "Todo mês",
};

export const DIAS_DA_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;
