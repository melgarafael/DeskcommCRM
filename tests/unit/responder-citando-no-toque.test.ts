import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O BOTÃO DE RESPONDER PRECISA EXISTIR NO CELULAR.
 *
 * ─── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * A primeira versão copiou o WhatsApp Web: `opacity-0` + `group-hover`. Em
 * desktop fica elegante; no celular o botão fica INVISÍVEL PARA SEMPRE — não há
 * como passar o mouse, e `focus-visible` só chega por teclado.
 *
 * Ou seja, a função sumia exatamente onde o dono deste CRM mais atende. Foi ele
 * quem apontou, olhando a tela do telefone, e não nenhum gate.
 *
 * ─── Por que a pergunta é `hover`, e não largura ────────────────────────────
 *
 * `@media (hover: hover)` pergunta pelo DISPOSITIVO. Um tablet largo com toque
 * continua mostrando o botão; um desktop com janela estreita continua
 * escondendo. Um breakpoint de largura (`md:`) erraria os dois casos, e erraria
 * em silêncio.
 *
 * ─── O que este teste NÃO prova, e por que ele é assim mesmo ───────────────
 *
 * Ele lê CLASSES, não comportamento — e classe presente não é botão alcançável.
 * A prova de verdade seria abrir um browser SEM hover, e o Playwright não sabe
 * emular isso: `emulateMedia` cobre `colorScheme`, `reducedMotion` e
 * `forcedColors`, não `hover`. `hasTouch` muda os eventos, não a media query.
 *
 * Então esta é a rede possível, e ela é honesta sobre o que segura: impede a
 * REGRESSÃO exata que aconteceu (alguém voltar a esconder sem condicionar ao
 * dispositivo). Quem quiser a prova real precisa de um aparelho na mão.
 */

const BOLHA = readFileSync("components/inbox/MessageBubble.tsx", "utf8");

describe("no celular o botão de responder aparece", () => {
  it("o padrão é VISÍVEL — esconder é a exceção", () => {
    // A ordem importa: `opacity-100` como base e o `0` atrás da media query.
    // Invertido, o celular volta a não ver nada.
    expect(BOLHA).toMatch(/"opacity-100 \[@media\(hover:hover\)\]:opacity-0"/);
  });

  it("só esconde onde EXISTE hover", () => {
    expect(BOLHA, "voltou a esconder sem perguntar pelo dispositivo").toMatch(
      /\[@media\(hover:hover\)\]:group-hover:opacity-100/,
    );
  });

  it("não usa breakpoint de LARGURA para decidir isso", () => {
    // `md:opacity-0` erraria o tablet com toque e o desktop estreito — e erraria
    // calado, que é o que torna esse tipo de bug caro.
    const trechos = [...BOLHA.matchAll(/(?:sm|md|lg|xl):opacity-0/g)];
    expect(trechos.map((m) => m[0]), "largura não responde 'tem hover?'").toEqual([]);
  });

  it("os DOIS botões (entrada e saída) seguem a mesma regra", () => {
    // São dois elementos espelhados. Consertar um e esquecer o outro deixaria a
    // metade da conversa sem resposta possível no celular.
    const comRegra = [...BOLHA.matchAll(/\[@media\(hover:hover\)\]:opacity-0/g)];
    expect(comRegra.length, "um dos dois botões ficou de fora").toBe(2);
  });

  it("o teclado também alcança", () => {
    // Quem navega por Tab não tem hover nem toque. Sem isto o botão existe e é
    // inalcançável — que é a mesma falha, com outro público.
    expect(BOLHA).toMatch(/focus-visible:opacity-100/);
  });
});
