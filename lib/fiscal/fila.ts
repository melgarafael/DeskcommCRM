/**
 * A FILA FISCAL — máquina de estados pura da emissão assíncrona.
 *
 * Pedido aceito vira nota `em_emissao` + job `pendente`; o drain (`POST
 * /api/v1/cron/fiscal-drain`) reclama jobs vencidos, chama o provider
 * (stub ou spednfe — o MESMO caminho do POST síncrono antigo) e move a nota.
 * Falha transitória volta para `pendente` com backoff; após o teto, a nota
 * cai em `erro` (dead-letter visível, nunca sumiço silencioso).
 *
 * Transições da NOTA (o banco só conhece o CHECK; isto aqui é a lei):
 *   em_emissao → autorizada | denegada | erro | cancelada
 *   erro → em_emissao (retry explícito)
 *   pendente → em_emissao (primeiro processamento)
 * Todo o resto é 422. `autorizada/denegada/cancelada` são terminais.
 */

export type StatusFila = "pendente" | "processando" | "concluido" | "erro";

export const MAX_TENTATIVAS = 5;

/** Backoff exponencial com teto: 2, 4, 8, 16, 32 min (+ jitter fora daqui). */
export function proximaTentativaEmMin(tentativa: number): number {
  return Math.min(32, 2 ** Math.max(1, tentativa));
}

export type TransicaoNota =
  | "autorizada"
  | "denegada"
  | "erro"
  | "cancelada"
  | "em_emissao";

const TRANSICOES: Record<string, TransicaoNota[]> = {
  pendente: ["em_emissao", "cancelada"],
  em_emissao: ["autorizada", "denegada", "erro", "cancelada"],
  erro: ["em_emissao", "cancelada"],
  autorizada: ["cancelada"],
  denegada: [],
  cancelada: [],
};

/** Guarda de transição — o drain e as rotas perguntam antes de escrever. */
export function podeTransitar(de: string, para: TransicaoNota): boolean {
  return (TRANSICOES[de] ?? []).includes(para);
}

/**
 * Destino após uma tentativa do drain. `tentativas` é a contagem JÁ incluindo
 * a que acabou de rodar: estourou o teto → `erro` (dead-letter); senão, volta
 * para a fila com backoff.
 */
export function destinoAposFalha(tentativas: number): { status: "pendente" | "erro"; esperaMin: number } {
  if (tentativas >= MAX_TENTATIVAS) return { status: "erro", esperaMin: 0 };
  return { status: "pendente", esperaMin: proximaTentativaEmMin(tentativas) };
}

/** Tipos de evento da timeline (CHECK de fiscal_events). */
export const TIPOS_DE_EVENTO = [
  "criada",
  "enviada",
  "autorizada",
  "rejeitada",
  "erro",
  "retry",
  "cancelada",
] as const;
export type TipoDeEvento = (typeof TIPOS_DE_EVENTO)[number];

/**
 * O que merece retry: só falha TRANSITÓRIA (rede, timeout, sidecar fora,
 * resposta fora do contrato, 5xx). "Falta X" (validação) e recusa da SEFAZ
 * (4xx/cstat determinístico) repetem o mesmo erro — vão direto a dead-letter
 * com a mensagem intacta para a tela de pendências.
 */
export function eRetentavel(mensagem: string): boolean {
  return /fora do ar|inalcançável|tempo esgotado|fora do contrato|indisponível|timeout|fetch failed|\[50[0234]\]|\b108\b|\b109\b/i.test(
    mensagem,
  );
}
