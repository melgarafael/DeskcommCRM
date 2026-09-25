/**
 * O vocabulário do módulo de Campanhas — os dois conjuntos de estado e os
 * motivos de exclusão, num lugar só.
 *
 * Os valores são os mesmos do CHECK da migration 0375. Quem mudar um lado muda o
 * outro: `tests/invariants/vocabulario-banco-x-typescript.test.ts` varre as
 * colunas que têm CHECK e reprova divergência.
 */

export const STATUS_DA_CAMPANHA = [
  "draft",
  "preparing",
  "ready",
  "scheduled",
  "running",
  "paused",
  "completed",
  "cancelled",
  "failed",
] as const;

export type StatusDaCampanha = (typeof STATUS_DA_CAMPANHA)[number];

export const STATUS_DO_DESTINATARIO = [
  "pending",
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
  "skipped",
  "cancelled",
  "opted_out",
] as const;

export type StatusDoDestinatario = (typeof STATUS_DO_DESTINATARIO)[number];

/**
 * Estados dos quais o despacho não tira mais ninguém.
 *
 * `sent` está aqui e continua evoluindo para `delivered`/`read`/`replied`: a
 * campanha conclui quando não há mais o que DESPACHAR, não quando todo mundo
 * leu — esperar leitura deixaria campanha aberta para sempre por causa de quem
 * nunca abre o WhatsApp.
 */
export const TERMINAIS_DE_DESPACHO: ReadonlySet<StatusDoDestinatario> = new Set([
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
  "skipped",
  "cancelled",
  "opted_out",
]);

/**
 * Por que alguém do recorte não vai receber.
 *
 * Código, não frase: a frase é traduzida na borda (`TEXTO_DA_EXCLUSAO`), e
 * gravar frase no banco impede contar "quantos por motivo" sem `like`.
 */
export const MOTIVOS_DE_EXCLUSAO = [
  "sem_telefone",
  "telefone_invalido",
  "opt_out",
  "anonimizado",
  "recusou_marketing",
  "excluido_manualmente",
  "duplicado",
  "variavel_ausente",
  "ja_em_campanha",
  "suprimido",
] as const;

export type MotivoDeExclusao = (typeof MOTIVOS_DE_EXCLUSAO)[number];

/** O que o operador lê na tela. Espanhol entra pelo `traduzir()` da borda. */
export const TEXTO_DA_EXCLUSAO: Record<MotivoDeExclusao, string> = {
  sem_telefone: "Sem telefone no cadastro",
  telefone_invalido: "Telefone fora do formato de envio",
  opt_out: "Pediu para não receber mensagens",
  anonimizado: "Contato anonimizado (LGPD)",
  recusou_marketing: "Recusou receber contato comercial",
  excluido_manualmente: "Excluído à mão desta campanha",
  duplicado: "Mesmo telefone de outro contato da lista",
  variavel_ausente: "Falta um dado que a mensagem usa",
  ja_em_campanha: "Já está em outra campanha ainda não concluída",
  suprimido: "Está na lista de exclusão de campanhas",
};
