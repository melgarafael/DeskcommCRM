import { describe, expect, it, vi } from "vitest";

import {
  agenteAceitaComandoDeCelular,
  lerComandoDeControle,
  normalizarComando,
} from "./comando-de-canal";

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

describe("lerComandoDeControle — sequências PERSONALIZADAS (C-077)", () => {
  const seq = { ligar: "religar", desligar: "🔴" };

  it("palavra leiga configurada é reconhecida", () => {
    expect(lerComandoDeControle("religar", seq)).toBe("on");
    expect(lerComandoDeControle("RELIGAR", seq)).toBe("on");
    expect(lerComandoDeControle("  religar  ", seq)).toBe("on");
  });

  it("emoji configurado é reconhecido, e o padrão (#on) deixa de valer", () => {
    expect(lerComandoDeControle("🔴", seq)).toBe("off");
    // As sequências padrão NÃO valem quando há configuração.
    expect(lerComandoDeControle("#off", seq)).toBeNull();
    expect(lerComandoDeControle("#on", seq)).toBeNull();
  });

  it("a palavra configurada no MEIO da frase não dispara", () => {
    expect(lerComandoDeControle("vou religar o atendimento", seq)).toBeNull();
  });

  it("sem configuração (undefined) → usa o padrão #on/#off", () => {
    expect(lerComandoDeControle("#on", undefined)).toBe("on");
    expect(lerComandoDeControle("#off", undefined)).toBe("off");
  });

  it("sequências iguais: 'ligar' vence (uma resposta só)", () => {
    expect(lerComandoDeControle("x", { ligar: "x", desligar: "x" })).toBe("on");
  });

  /**
   * C-078 — o teclado do celular pode mandar o emoji COM ou SEM o variation
   * selector (`U+FE0F`), e a comparação exata falhava em silêncio numa das
   * formas. Aqui as duas casam.
   */
  it("emoji COM e SEM variation selector casam entre si", () => {
    const comVs = "\u{1F3CD}\uFE0F"; // 🏍️
    const semVs = "\u{1F3CD}"; // 🏍
    const seq = { ligar: `#${comVs}`, desligar: semVs };

    expect(lerComandoDeControle(`#${comVs}`, seq)).toBe("on");
    expect(lerComandoDeControle(`#${semVs}`, seq), "teclado omitiu o VS").toBe("on");
    expect(lerComandoDeControle(comVs, seq)).toBe("off");
    expect(lerComandoDeControle(semVs, seq), "teclado omitiu o VS").toBe("off");
  });

  it("emoji DIFERENTES não são fundidos pela normalização", () => {
    const seq = { ligar: "🏍️", desligar: "🚗" };
    expect(lerComandoDeControle("🏍️", seq)).toBe("on");
    expect(lerComandoDeControle("🚗", seq)).toBe("off");
    expect(lerComandoDeControle("✈️", seq)).toBeNull();
  });

  it("normalizarComando é conservadora: texto puro fica igual", () => {
    expect(normalizarComando("  #ON  ")).toBe("#on");
    expect(normalizarComando("religar")).toBe("religar");
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
