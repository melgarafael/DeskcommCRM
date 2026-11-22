/**
 * Caminhar a árvore de passos — a peça que o worker (`cron/cadencia-worker`)
 * usa pra saber "o que vem depois do passo X". Pura, como o resto de
 * `arvore.ts`: recebe a árvore e devolve, nunca muta.
 *
 * Contrato de `email_cadence_enrollments.passo_atual_id` (migration 0428):
 * é o id do passo A EXECUTAR nesta rodada. `null` quer dizer "ainda não
 * começou" — o worker resolve pro primeiro passo da raiz. Quando não há
 * PRÓXIMO depois de executar o atual (fim de um caminho, com ou sem ramo),
 * a inscrição CONCLUI (`status='concluida'`) — não existe um segundo estado
 * "null = acabou": `status` já carrega esse fato sem ambiguidade.
 *
 * Ramos nunca se rejuntam: "sim" e "não" são caminhos independentes até o
 * fim (mesmo comentário de `inserirPasso` em `arvore.ts`) — por isso achar o
 * próximo irmão dentro da lista onde o passo mora é a regra inteira; não há
 * "voltar pro pai" depois de esgotar um lado do ramo.
 */
import type { Passo } from "./tipos";

/** O passo a executar nesta rodada, ou `null` se a inscrição já deveria concluir. */
export function passoParaExecutar(passos: Passo[], passoAtualId: string | null): Passo | null {
  if (passoAtualId === null) return passos[0] ?? null;
  return encontrarPassoLocal(passos, passoAtualId);
}

function encontrarPassoLocal(passos: Passo[], id: string): Passo | null {
  for (const p of passos) {
    if (p.id === id) return p;
    if (p.tipo === "ramo") {
      const achado = encontrarPassoLocal(p.sim, id) ?? encontrarPassoLocal(p.nao, id);
      if (achado) return achado;
    }
  }
  return null;
}

/**
 * O irmão seguinte, na MESMA lista onde `idAtual` mora (raiz, ou o lado de um
 * ramo). `null` = fim daquele caminho — o chamador conclui a inscrição.
 */
export function proximoIrmao(passos: Passo[], idAtual: string): Passo | null {
  const achado = buscarEmLista(passos, idAtual);
  return achado ?? null;
}

/** `undefined` = o id não está nesta lista nem nos ramos dela (procure na próxima). */
function buscarEmLista(lista: Passo[], idAtual: string): Passo | null | undefined {
  for (let i = 0; i < lista.length; i++) {
    const p = lista[i];
    if (!p) continue;
    if (p.id === idAtual) return lista[i + 1] ?? null;
    if (p.tipo === "ramo") {
      const noSim = buscarEmLista(p.sim, idAtual);
      if (noSim !== undefined) return noSim;
      const noNao = buscarEmLista(p.nao, idAtual);
      if (noNao !== undefined) return noNao;
    }
  }
  return undefined;
}

/** O primeiro passo do lado escolhido de um ramo — `null` = lado vazio, conclui. */
export function primeiroDoLado(ramo: Extract<Passo, { tipo: "ramo" }>, lado: "sim" | "nao"): Passo | null {
  return ramo[lado][0] ?? null;
}
