import { describe, expect, it } from "vitest";

import { lerComandoDeControle } from "./comando-de-canal";

describe("lerComandoDeControle — reconhece #on/#off, e SÓ a mensagem inteira", () => {
  it.each([
    ["#on", "on"],
    ["#off", "off"],
    ["  #on  ", "on"],
    ["  #off  ", "off"],
    ["#ON", "on"],
    ["#OFF", "off"],
    ["#On", "on"],
    ["#oFf", "off"],
  ])("%j → %s", (entrada, esperado) => {
    expect(lerComandoDeControle(entrada)).toBe(esperado);
  });

  it.each([
    ["oi", "mensagem comum"],
    ["vou dar um #off agora", "comando no MEIO da frase"],
    ["#on das 10h", "comando com texto ao redor"],
    ["##on", "prefixo dobrado"],
    ["/on", "barra — NÃO aceita (só #)"],
    ["/off", "barra — NÃO aceita (só #)"],
    ["on", "sem prefixo"],
    ["off", "sem prefixo"],
    ["#ligar", "sinônimo não aceito"],
    ["#desligar", "sinônimo não aceito"],
    ["", "vazio"],
    ["   ", "só espaços"],
  ])("%j → null (%s)", (entrada) => {
    expect(lerComandoDeControle(entrada)).toBeNull();
  });

  it("null/undefined → null (nunca lança)", () => {
    expect(lerComandoDeControle(null)).toBeNull();
    expect(lerComandoDeControle(undefined)).toBeNull();
  });
});
