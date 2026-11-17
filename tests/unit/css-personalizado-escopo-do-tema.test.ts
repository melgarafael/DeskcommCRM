/**
 * O ESCOPO DO TEMA ESCURO NO CSS PERSONALIZADO (#4463, item 1).
 *
 * O defeito medido: `validarCssPersonalizado` prefixa TODA regra com `:root:root`
 * (`lib/branding/css-personalizado.ts`), e o tema mora em `data-theme` no
 * `<html>` — então uma cor escolhida para o escuro também vale no claro, e é
 * exatamente aí que ela fica ilegível.
 *
 * A prova aqui é de COMPORTAMENTO, não de string: a folha emitida é injetada no
 * documento, e o que se lê é a cor computada do elemento com e sem
 * `data-theme="dark"`. Se o prefixo não carregar o atributo, o caso do tema
 * claro fica branco no branco e este teste reprova.
 */
import { afterEach, describe, expect, it } from "vitest";

import { validarCssPersonalizado } from "@/lib/branding/css-personalizado";

/** A regra de base que o produto já tem no claro — o que o CSS do cliente deve vencer. */
const BASE = ".cartao { color: rgb(0, 0, 0); }";

function montarDocumento(folha: string | null) {
  document.head.innerHTML = "";
  document.body.innerHTML = '<div class="cartao">campanha</div>';
  document.documentElement.removeAttribute("data-theme");
  const estilo = document.createElement("style");
  estilo.textContent = `${BASE}\n${folha ?? ""}`;
  document.head.append(estilo);
  const cartao = document.querySelector(".cartao");
  if (!cartao) throw new Error("esperava o cartão no documento");
  return cartao;
}

function cor(cartao: Element): string {
  return getComputedStyle(cartao).color;
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
});

describe("o CSS personalizado do tema escuro fica escopado no escuro", () => {
  it("a regra do escuro vence no escuro e NÃO vaza para o claro", () => {
    const regra = validarCssPersonalizado(".cartao { color: rgb(255, 255, 255); }", "escuro");
    expect(regra.erro).toBeNull();

    const cartao = montarDocumento(regra.css);

    // Claro: a regra do escuro não pode valer.
    expect(cor(cartao)).toBe("rgb(0, 0, 0)");

    // Escuro: ela vale.
    document.documentElement.setAttribute("data-theme", "dark");
    expect(cor(cartao)).toBe("rgb(255, 255, 255)");
  });

  it("sem escopo declarado o comportamento de hoje continua: vale nos dois temas", () => {
    const regra = validarCssPersonalizado(".cartao { color: rgb(1, 2, 3); }");
    expect(regra.erro).toBeNull();

    const cartao = montarDocumento(regra.css);

    expect(cor(cartao)).toBe("rgb(1, 2, 3)");
    document.documentElement.setAttribute("data-theme", "dark");
    expect(cor(cartao)).toBe("rgb(1, 2, 3)");
  });

  it("as duas folhas convivem: a do escuro vence a do claro quando o escuro está ativo", () => {
    const claro = validarCssPersonalizado(".cartao { color: rgb(10, 20, 30); }");
    const escuro = validarCssPersonalizado(".cartao { color: rgb(240, 240, 240); }", "escuro");
    expect(claro.erro).toBeNull();
    expect(escuro.erro).toBeNull();

    const cartao = montarDocumento(`${claro.css}\n${escuro.css}`);

    expect(cor(cartao)).toBe("rgb(10, 20, 30)");
    document.documentElement.setAttribute("data-theme", "dark");
    expect(cor(cartao)).toBe("rgb(240, 240, 240)");
  });

  it("o escopo do escuro obedece a MESMA régua de validação do claro", () => {
    // Seletor que o validador já recusa no claro também não passa no escuro:
    // o escopo muda o prefixo, nunca a allowlist.
    expect(validarCssPersonalizado("div { color: #fff; }", "escuro").erro).not.toBeNull();
    expect(validarCssPersonalizado(".a { position: fixed; }", "escuro").erro).not.toBeNull();
    expect(validarCssPersonalizado(".a { color: #fff; }", "escuro").css).toContain(
      ':root:root[data-theme="dark"] .a',
    );
  });
});

/**
 * A PORTEIRA (#4463). O escopo do tema entra como PREFIXO controlado; quem
 * escreve a regra continua restrito a seletor de CLASSE. Se o escopo virasse
 * "aceita qualquer coisa quando `escuro`", a defesa contra o CSS que quebra a
 * instalação inteira cairia junto — e o cliente poderia forjar `[data-theme]`,
 * `#id` ou `body` no próprio texto.
 */
describe("o escopo do tema não abre a porteira do validador", () => {
  it.each([
    ["id, que o validador recusa desde sempre", "#nav-grupo-crm { color: #fff; }"],
    ["tag", "div { color: #fff; }"],
    ["atributo, inclusive o do tema", '[data-theme="dark"] .cartao { color: #fff; }'],
    ["atributo depois da classe", '.cartao[aria-current="page"] { color: #fff; }'],
    ["pseudo-classe de raiz", ":root .cartao { color: #fff; }"],
    ["universal", "* { color: #fff; }"],
    ["pseudo-elemento", ".cartao::before { color: #fff; }"],
    ["lista em que só um seletor é de classe", ".cartao, #conteudo { color: #fff; }"],
  ])("recusa %s nos DOIS escopos", (_caso, css) => {
    for (const escopo of ["claro", "escuro"] as const) {
      const resultado = validarCssPersonalizado(css, escopo);
      expect(resultado.css, escopo).toBeNull();
      expect(resultado.erro, escopo).toBeTruthy();
    }
  });

  it("o cliente não consegue acrescentar um segundo [data-theme] ao seletor", () => {
    const regra = validarCssPersonalizado(".cartao { color: #fff; }", "escuro");
    expect(regra.erro).toBeNull();
    // O prefixo é a ÚNICA ocorrência do atributo na folha emitida: o texto do
    // cliente nunca o contém, então não há o que forjar.
    expect((regra.css ?? "").match(/\[data-theme/g)).toHaveLength(1);
    expect(regra.css).toBe(':root:root[data-theme="dark"] .cartao { color: #fff; }');
  });

  it("a classe válida sai idêntica nos dois escopos, só com o prefixo trocado", () => {
    const regra = ".cartao:hover, .cartao > .titulo { color: #fff; }";
    const claro = validarCssPersonalizado(regra, "claro");
    const escuro = validarCssPersonalizado(regra, "escuro");
    expect(claro.erro).toBeNull();
    expect(escuro.erro).toBeNull();
    expect(escuro.css?.replaceAll(':root:root[data-theme="dark"]', ":root:root")).toBe(claro.css);
  });
});
