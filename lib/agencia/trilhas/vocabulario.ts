/** O vocabulário da trilha do cliente (docs/agencia/SPEC-trilhas.md). CHECK no banco (9006). */
export const TIPOS_DE_PASSO = ["tarefa", "reuniao", "marco"] as const;
export type TipoDePasso = (typeof TIPOS_DE_PASSO)[number];

export const ROTULO_DO_TIPO_DE_PASSO: Record<TipoDePasso, string> = {
  tarefa: "Tarefa",
  reuniao: "Reunião",
  marco: "Marco (marcado à mão)",
};

export const SITUACOES_DO_PASSO = ["bloqueado", "liberado", "em_andamento", "concluido", "pulado"] as const;
export type SituacaoDoPasso = (typeof SITUACOES_DO_PASSO)[number];

export const ROTULO_DA_SITUACAO_DO_PASSO: Record<SituacaoDoPasso, string> = {
  bloqueado: "Bloqueado",
  liberado: "Liberado",
  em_andamento: "Em andamento",
  concluido: "Concluído",
  pulado: "Pulado",
};

/** Situações que contam como "feito" para desbloquear os passos seguintes (R4). */
export const SITUACOES_FEITAS: readonly SituacaoDoPasso[] = ["concluido", "pulado"];

export const REGRAS_DE_PRAZO = ["manual", "apos_liberar", "apos_ancora", "fim_preparacao"] as const;
export type RegraDePrazo = (typeof REGRAS_DE_PRAZO)[number];

export const ROTULO_DA_REGRA: Record<RegraDePrazo, string> = {
  manual: "Sem prazo automático",
  apos_liberar: "N dias depois de liberar",
  apos_ancora: "N dias depois de outro passo",
  fim_preparacao: "Fim do mês de preparação",
};

export const SITUACOES_DA_TRILHA = ["ativa", "concluida", "cancelada"] as const;
export type SituacaoDaTrilha = (typeof SITUACOES_DA_TRILHA)[number];

export const ROTULO_DA_ETAPA: Record<number, string> = {
  1: "Etapa 1 — Reuniões com o cliente",
  2: "Etapa 2 — Preparação",
  3: "Etapa 3 — Ciclo mensal",
};

/**
 * O marco que liga o calendário do contrato (R6). É a única chave com sentido
 * próprio para o motor: ao concluí-la, a regra do dia 15 calcula as datas.
 */
export const CHAVE_ASSINOU_PAGOU = "assinou_pagou";

/** Hora do dia (Brasília) em que vence um prazo contado em dias. */
export const HORA_DO_PRAZO = "18:00";
