/**
 * Campanha de texto em vários balões (migration 0765, PR #3329).
 *
 * A divisão é a do AGENTE (`splitForSend`), não uma cópia: o parágrafo é a
 * fronteira do balão nos dois lugares, e duas regras fariam a prévia do
 * operador e o aparelho do cliente discordarem.
 *
 * ═══ Por que no máximo 3 balões ═══
 *
 * A rodada atende as campanhas em série, dentro de um laço que todos os
 * clientes da instalação dividem. Cada pausa entre balões é tempo que a
 * campanha do vizinho espera. Três balões custam duas pausas curtas; o texto
 * que passar disso vai junto no último balão, sem perder nada.
 */
import { splitForSend } from "@/lib/agent-engine/agent/split-message";

export const MAX_BALOES_POR_DESTINATARIO = 3;

/**
 * Os balões de um destinatário. Desligado (ou modelo aprovado, que quem chama
 * passa como `dividir = false`) é sempre um balão só, com o corpo intacto.
 * Sem teto de caracteres: a campanha divide só por parágrafo, que é o que o
 * operador escreveu e o que a tela promete.
 */
export function baloesDaCampanha(
  corpo: string,
  dividir: boolean,
  maxBaloes: number = MAX_BALOES_POR_DESTINATARIO,
): string[] {
  if (!dividir) return [corpo];
  const baloes = splitForSend(corpo, true, Number.POSITIVE_INFINITY, maxBaloes);
  return baloes.length > 0 ? baloes : [corpo];
}

/** A pausa entre balões: o espaçamento anti-ban do número (throttle + jitter), nunca o intervalo da campanha. */
export function pausaEntreBaloes(
  knobs: { throttleMs: number; jitterMaxMs: number },
  rng: () => number = Math.random,
): number {
  return knobs.throttleMs + Math.floor(rng() * knobs.jitterMaxMs);
}

/**
 * Envia os balões em ordem. Cada balão enviado passa por `registrar`, com o
 * índice (o `recordSend` da rodada: cada balão é uma mensagem física, conta no
 * teto do número e é a base do throttle do próximo envio). Para no primeiro balão `failed` e o devolve como desfecho: mandar o
 * resto depois de uma falha entregaria a mensagem pela metade e fora de ordem.
 */
export async function enviarEmBaloes<T extends { status?: string }>(
  baloes: readonly string[],
  passos: {
    enviar: (corpo: string, indice: number) => Promise<T>;
    registrar?: (indice: number) => Promise<void>;
    esperar: () => Promise<void>;
  },
): Promise<{ primeira: T; desfecho: T; indiceDoDesfecho: number }> {
  let primeira: T | undefined;
  let desfecho: T | undefined;
  let indice = 0;
  for (; indice < baloes.length; indice++) {
    if (indice > 0) await passos.esperar();
    desfecho = await passos.enviar(baloes[indice]!, indice);
    primeira ??= desfecho;
    await passos.registrar?.(indice);
    if (desfecho.status === "failed") break;
  }
  return { primeira: primeira!, desfecho: desfecho!, indiceDoDesfecho: Math.min(indice, baloes.length - 1) };
}
