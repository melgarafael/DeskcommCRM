/**
 * Vocabulário das cadências — espelho dos CHECK da migration 0426.
 *
 * ⚠️ A forma `const X = [...] as const` é requisito de instrumento:
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` lê estas tuplas e as
 * compara com o banco. Código e rótulo são coisas diferentes — o rótulo mora na
 * tela, passando por `t()`.
 */

export const STATUS_DA_CADENCIA = ["rascunho", "ativa", "pausada"] as const;

export const STATUS_DA_INSCRICAO = ["ativa", "concluida", "parada"] as const;
export type StatusDaInscricao = (typeof STATUS_DA_INSCRICAO)[number];

export const ORIGENS_DA_INSCRICAO = ["manual", "tag"] as const;
export type OrigemDaInscricao = (typeof ORIGENS_DA_INSCRICAO)[number];

export const MOTIVOS_DE_PARADA = [
  "respondeu",
  "bounce",
  "descadastro",
  "ganho_ou_perdido",
  "manual",
  "sem_email",
  "falha",
] as const;
export type MotivoDeParada = (typeof MOTIVOS_DE_PARADA)[number];

export const TIPOS_DE_EVENTO_DA_CADENCIA = [
  "inscrito",
  "reinscrito",
  "email_enviado",
  "email_falhou",
  "aberto",
  "clicado",
  "descadastrou",
  "ramo_sim",
  "ramo_nao",
  "tarefa_criada",
  "parada",
  "concluida",
] as const;
export type TipoDeEventoDaCadencia = (typeof TIPOS_DE_EVENTO_DA_CADENCIA)[number];
