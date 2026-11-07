/**
 * Semente do módulo Atualização do sistema: a instalação está numa versão
 * publicada e o servidor já avisou que saiu a seguinte. A versão instalada é a
 * anterior à das fotos, e a nova é a das fotos, com o trecho REAL do
 * CHANGELOG.md entre as duas: o "O que muda" da foto é o que de fato mudou.
 *
 * O pedido que a aula faz pelo botão "Atualizar agora" fica numa fila que só o
 * agente do servidor lê, e a bancada não tem agente. A base apaga o pedido antes de cada aula.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { type Contexto, confirmarVersaoDaInstalacao, versaoDasFotos } from "../semear-demonstracao";

export async function semear(_c: Contexto) {
  const nova = versaoDasFotos();
  const changelog = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "CHANGELOG.md"), "utf8");
  // a seção da versão das fotos e a anterior: a anterior é a instalada
  const secoes = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)];
  const i = secoes.findIndex((m) => m[1] === nova);
  const anterior = secoes[i + 1];
  if (i < 0 || !anterior) throw new Error(`CHANGELOG.md sem as seções ${nova} e a anterior`);
  const trecho = changelog.slice(secoes[i]!.index, secoes[i + 2]?.index ?? changelog.length);
  await confirmarVersaoDaInstalacao(anterior[1], nova, trecho);
  console.info(`atualizacao: instalada ${anterior[1]}, nova ${nova}`);
}
