import { describe, expect, it, vi } from "vitest";

import { agenteAceitaComandoDeCelular, lerComandoDeControle } from "./comando-de-canal";

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

/**
 * O gate de configuração (C-076): FAIL-CLOSED. Só `true` explícito liga; erro
 * de leitura, ausência de agente ou chave ausente ⇒ `false` (não aplica comando).
 */
function admin(over: { data?: unknown; error?: unknown } = {}) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit"]) {
    chain[m] = () => chain;
  }
  chain.maybeSingle = () =>
    Promise.resolve({ data: over.data ?? null, error: over.error ?? null });
  return { from: vi.fn(() => chain) } as never;
}

describe("agenteAceitaComandoDeCelular — liga/desliga pela UI", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";

  it("`true` explícito → aceita", async () => {
    await expect(
      agenteAceitaComandoDeCelular(admin({ data: { config: { aceita_comandos_celular: true } } }), ORG),
    ).resolves.toBe(true);
  });

  it("`false` → não aceita", async () => {
    await expect(
      agenteAceitaComandoDeCelular(admin({ data: { config: { aceita_comandos_celular: false } } }), ORG),
    ).resolves.toBe(false);
  });

  it("chave ausente → não aceita (default fechado)", async () => {
    await expect(
      agenteAceitaComandoDeCelular(admin({ data: { config: {} } }), ORG),
    ).resolves.toBe(false);
  });

  it("sem agente → não aceita", async () => {
    await expect(agenteAceitaComandoDeCelular(admin({ data: null }), ORG)).resolves.toBe(false);
  });

  it("erro de leitura → não aceita (fail-closed)", async () => {
    await expect(
      agenteAceitaComandoDeCelular(admin({ error: { message: "boom" } }), ORG),
    ).resolves.toBe(false);
  });
});
