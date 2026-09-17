import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A LISTA DE HORÁRIOS ROLA EM VEZ DE ESTICAR A JANELA — medido numa instalação
 * real em 2026-09-12, e a cerca que impede o defeito de voltar.
 *
 * ## O que esta cerca é, e o que ela NÃO é
 *
 * É cerca de FORMA: lê o código-fonte e exige a presença do que conserta. Não
 * prova comportamento — não abre o modal, não mede pixel. A prova de verdade é
 * pela tela, e ela é do `tests/e2e/` e de quem opera.
 *
 * Existe assim mesmo porque o defeito é do tipo que passa por typecheck, lint e
 * pela suíte inteira sem um arranhão: uma classe de CSS ausente. Nenhum gate
 * deste repositório olhava para ela, e o defeito chegou à instalação de um
 * cliente. Aqui a forma BASTA porque o que se vigia É uma forma: a presença do
 * par `max-height` + `overflow-y-auto` na lista.
 *
 * ⚠️ O OUTRO defeito daquela mesma tela — "Novo agendamento" abrindo com o
 * cliente da vez anterior — TAMBÉM tinha uma cerca de texto aqui, e ela foi
 * removida: exigia `setContactId("")` no `_client.tsx`, ficou verde e o produto
 * quebrou (o `e2e` reprovou com `contact_id: null`). Cercar comportamento com
 * texto de código cimenta uma implementação e não vigia nada. Foi trocada por
 * `tests/unit/agenda-vinculo-da-marcacao.test.tsx`, que exerce a regra nos dois
 * sentidos.
 */

const RAIZ = process.cwd();

describe("a lista de horários rola em vez de esticar a janela", () => {
  const FONTE = fs.readFileSync(
    path.join(RAIZ, "components", "agenda", "PainelDeMarcacao.tsx"),
    "utf8",
  );

  /** A linha de classes da lista, achada pelo `data-testid` que a nomeia. */
  const classes = (() => {
    const i = FONTE.indexOf('data-testid="lista-de-horarios"');
    if (i < 0) return "";
    const trecho = FONTE.slice(i, i + 400);
    return /className=\{?"([^"]+)"/.exec(trecho)?.[1] ?? "";
  })();

  it("CONTROLE: as classes da lista foram encontradas", () => {
    expect(classes.length).toBeGreaterThan(10);
  });

  it("⛔ a lista tem TETO — sem ele o `overflow-y-auto` é enfeite", () => {
    // O par é indivisível: `overflow-y-auto` só rola quando existe altura que
    // limite o filho. Durante meses o teto veio do pai, e no dia em que o pai
    // perdeu a altura (para a janela parar de CORTAR os botões em tela baixa) a
    // lista passou a crescer sem fim — treze horários numa janela que não cabia
    // na tela. `max-height` não depende de cadeia nenhuma.
    expect(classes).toMatch(/max-h-/);
    expect(classes).toMatch(/overflow-y-auto/);
  });

  it("o teto vale só da coluna para cima — no celular quem rola é o diálogo", () => {
    // Dois roladores aninhados no telefone prendem o dedo no de dentro: a pessoa
    // tenta rolar a página e move a lista. Abaixo de `lg` o painel é empilhado e
    // o diálogo inteiro rola, que é o certo.
    expect(classes).toMatch(/lg:max-h-/);
  });

  it("o teto tem parte relativa à JANELA — senão volta a cortar em tela baixa", () => {
    // Um teto só em pixel, escolhido num monitor grande, corta em 1366×768 —
    // que é exatamente onde o defeito original apareceu.
    expect(classes).toMatch(/\d+vh/);
  });

  it("⛔ e tem parte em PIXEL — senão em tela alta o teto não é teto", () => {
    // Medido na prova de tela: `60vh` sozinho fez a barra de rolagem aparecer
    // (o mecanismo estava certo) e ainda assim rendeu ~570px de lista numa
    // janela de ~950px. O relato foi "scroll de horas ainda gigante". Rolar não
    // era o objetivo; caber era. O erro não estava no mecanismo, estava no
    // NÚMERO — e nenhum gate mede número: só a tela mostra.
    expect(classes).toMatch(/\d+px/);
  });
});
