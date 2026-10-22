/**
 * As escolhas PURAS dos blocos de distribuição do módulo Automações (out/2026):
 * quem recebe a conversa no `distribute` e por qual saída o contato segue no
 * `split`. Sem banco e sem relógio — quem lê os candidatos e grava a atribuição
 * é `distribuir-atendimento.ts`.
 *
 * Tudo que envolve sorte é DETERMINÍSTICO pela `chave` (inscrição + nó): o motor
 * pode reprocessar o mesmo passo (replay do tick) e o contato nunca muda de
 * caminho nem de pessoa no meio do caminho.
 */
import { selectByLoad, selectRoundRobin, type RoutingCandidate } from "@/lib/routing/decide";

import type { DistributeMode, SplitBranch } from "./graph-schema";

/** FNV-1a de 32 bits: estável entre processos e versões do Node, ao contrário de `Math.random`. */
export function hashEstavel(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Sorteia um índice na proporção dos pesos, sempre o mesmo para a mesma chave. */
export function indicePorPeso(pesos: readonly number[], chave: string): number {
  const total = pesos.reduce((soma, p) => soma + Math.max(0, p), 0);
  if (pesos.length === 0) return -1;
  if (total <= 0) return hashEstavel(chave) % pesos.length;
  let ponto = hashEstavel(chave) % total;
  for (let i = 0; i < pesos.length; i++) {
    const peso = Math.max(0, pesos[i] ?? 0);
    if (ponto < peso) return i;
    ponto -= peso;
  }
  return pesos.length - 1;
}

/** A saída do `split` por onde esta inscrição segue. */
export function escolherSaidaDoDivisor(saidas: readonly SplitBranch[], chave: string): string | null {
  const i = indicePorPeso(
    saidas.map((s) => s.peso),
    chave,
  );
  return i < 0 ? null : (saidas[i]?.id ?? null);
}

export interface CandidatoDaDistribuicao extends RoutingCandidate {
  /** Só lido no modo `percentual`. Ausente = 1. */
  peso?: number;
}

/**
 * Quem recebe, entre candidatos JÁ filtrados (disponibilidade, teto, lista do
 * bloco). Devolve a ordem de preferência inteira: se o primeiro perder a
 * disputa no banco (alguém ficou indisponível entre a leitura e a gravação),
 * quem grava tenta o seguinte sem refazer a leitura.
 */
export function ordemDeEscolha(
  modo: DistributeMode,
  candidatos: readonly CandidatoDaDistribuicao[],
  chave: string,
): string[] {
  const restantes = [...candidatos];
  const ordem: string[] = [];
  let rodada = 0;
  while (restantes.length > 0) {
    const escolhido = escolherUm(modo, restantes, `${chave}:${rodada}`);
    if (!escolhido) break;
    ordem.push(escolhido);
    restantes.splice(
      restantes.findIndex((c) => c.userId === escolhido),
      1,
    );
    rodada++;
  }
  return ordem;
}

function escolherUm(
  modo: DistributeMode,
  candidatos: readonly CandidatoDaDistribuicao[],
  chave: string,
): string | null {
  if (candidatos.length === 0) return null;
  switch (modo) {
    case "rodizio":
      return selectRoundRobin([...candidatos]);
    case "carga":
      return selectByLoad([...candidatos]);
    case "aleatorio": {
      // A ordem de entrada não pode decidir o sorteio: ordena por id antes.
      const ordenados = [...candidatos].sort((a, b) => (a.userId < b.userId ? -1 : 1));
      return ordenados[hashEstavel(chave) % ordenados.length]?.userId ?? null;
    }
    case "percentual": {
      const ordenados = [...candidatos].sort((a, b) => (a.userId < b.userId ? -1 : 1));
      const i = indicePorPeso(
        ordenados.map((c) => c.peso ?? 1),
        chave,
      );
      return ordenados[i]?.userId ?? null;
    }
  }
}
