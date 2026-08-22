import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A BARRA LATERAL PASSAVA POR CIMA DA LISTA DE CONVERSAS.
 *
 * ─── O defeito, visto por quem usa ──────────────────────────────────────────
 *
 * Abrir o inbox e encontrar a barra expandida — com as etiquetas legíveis — e a
 * lista de conversas ATRÁS dela, com o começo de cada linha escondido. Um F5
 * "consertava", que é a assinatura clássica de servidor e navegador terem
 * pintado estados diferentes.
 *
 * ─── A causa, e por que ela é estrutural ────────────────────────────────────
 *
 * A barra era `fixed`: saía do fluxo e não ocupava lugar nenhum na linha. Quem
 * afastava o conteúdo era um `ml-16`/`ml-60` do lado de lá, em OUTRO componente.
 *
 * Duas medidas para a mesma coisa. Enquanto concordam, ninguém vê nada; no
 * instante em que discordam — largura de 60 com margem de 16 — a barra cobre a
 * lista. E as duas nascem do mesmo booleano em componentes de CLIENTE, então
 * basta um render fora de sincronia para elas divergirem.
 *
 * Consertar o valor não conserta a classe: enquanto houver duas medidas, existe
 * o dia em que discordam. `sticky` devolve a barra ao fluxo, e aí sobra para o
 * conteúdo exatamente o que ela não usou — não há segunda medida.
 *
 * ─── O que este teste NÃO prova ─────────────────────────────────────────────
 *
 * Ele lê CLASSES, não geometria. A prova de verdade é medir
 * `getBoundingClientRect` das duas caixas num browser e mostrar que não se
 * sobrepõem — o que a doutrina de QA Visual pede e um teste de unidade não
 * alcança. Esta é a rede possível: impede a volta do PADRÃO que causou o
 * defeito.
 */

const BARRA = readFileSync("components/shell/Sidebar.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
const CASCA = readFileSync("app/app/_components/AppShell.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

describe("a barra ocupa lugar, em vez de flutuar", () => {
  it("não é `fixed`", () => {
    // `fixed` é o que a tira do fluxo e obriga alguém a compensar por fora.
    expect(BARRA, "a barra voltou a flutuar").not.toMatch(/\bfixed\b/);
  });

  it("é `sticky` e ocupa a altura da tela", () => {
    // O efeito visual precisa continuar: a barra não rola com a página.
    expect(BARRA).toMatch(/\bsticky\b/);
    expect(BARRA).toMatch(/h-screen/);
  });

  it("não encolhe", () => {
    // Item de flex encolhe por padrão. Uma barra de 60 espremida para caber é o
    // mesmo defeito por outro caminho.
    expect(BARRA).toMatch(/shrink-0/);
  });

  it("a casca NÃO compensa com margem", () => {
    // Esta é a asserção que importa: enquanto existir a segunda medida, existe
    // o dia em que ela discorda da primeira.
    const margens = [...CASCA.matchAll(/\bml-(?:16|60)\b/g)].map((m) => m[0]);
    expect(margens, "voltou a segunda medida da mesma coisa").toEqual([]);
  });
});
