import { describe, expect, it } from "vitest";

import {
  COMANDO_LIMPAR_PADRAO,
  configDeLimpezaDoAgente,
  lerComandoDeLimpeza,
} from "./limpeza-de-conversa";

describe("lerComandoDeLimpeza — SÓ a mensagem inteira dispara", () => {
  it.each([
    ["#limpar"],
    ["  #limpar  "],
    ["#LIMPAR"],
    ["  #Limpar "],
  ])("%j → true", (entrada) => {
    expect(lerComandoDeLimpeza(entrada)).toBe(true);
  });

  it.each([
    ["oi", "mensagem comum"],
    ["quero #limpar agora", "comando no MEIO da frase"],
    ["#limpar por favor", "comando com texto ao redor"],
    ["##limpar", "prefixo dobrado"],
    ["limpar", "sem prefixo"],
    ["#apagar", "outro comando"],
    ["", "vazio"],
    ["   ", "só espaços"],
  ])("%j → false (%s)", (entrada) => {
    expect(lerComandoDeLimpeza(entrada)).toBe(false);
  });

  it("null/undefined → false (nunca lança)", () => {
    expect(lerComandoDeLimpeza(null)).toBe(false);
    expect(lerComandoDeLimpeza(undefined)).toBe(false);
  });

  it("sequência personalizada vale; o padrão deixa de valer", () => {
    expect(lerComandoDeLimpeza("apagar tudo", "apagar tudo")).toBe(true);
    expect(lerComandoDeLimpeza("APAGAR TUDO", "apagar tudo")).toBe(true);
    expect(lerComandoDeLimpeza("#limpar", "apagar tudo")).toBe(false);
  });

  it("emoji configurado casa com e sem variation selector", () => {
    expect(lerComandoDeLimpeza("🧹", "🧹")).toBe(true);
    expect(lerComandoDeLimpeza("🧹️", "🧹")).toBe(true);
  });

  it("o padrão é #limpar", () => {
    expect(COMANDO_LIMPAR_PADRAO).toBe("#limpar");
    expect(lerComandoDeLimpeza("#limpar")).toBe(true);
  });
});

/** Dublê do `ai_agents.select().eq()...maybeSingle()`. */
function clienteComConfig(config: unknown, opts: { erro?: boolean } = {}) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () =>
      opts.erro
        ? { data: null, error: { message: "falhou" } }
        : { data: config === undefined ? null : { config }, error: null },
  };
  return { from: () => chain };
}

describe("configDeLimpezaDoAgente — FAIL-CLOSED", () => {
  it("sem agente publicado → tudo desligado, sequência padrão", async () => {
    const cfg = await configDeLimpezaDoAgente(clienteComConfig(undefined) as never, "org");
    expect(cfg).toEqual({
      aceitaCliente: false,
      permiteAtendente: false,
      sequencia: COMANDO_LIMPAR_PADRAO,
    });
  });

  it("erro de leitura → tudo desligado (não libera por falha)", async () => {
    const cfg = await configDeLimpezaDoAgente(
      clienteComConfig({ aceita_limpeza_cliente: true }, { erro: true }) as never,
      "org",
    );
    expect(cfg.aceitaCliente).toBe(false);
    expect(cfg.permiteAtendente).toBe(false);
  });

  it("flags exatamente `true` ligam; outros valores não", async () => {
    const cfg = await configDeLimpezaDoAgente(
      clienteComConfig({
        aceita_limpeza_cliente: true,
        permite_limpeza_atendente: "sim",
        comando_limpar: "apagar tudo",
      }) as never,
      "org",
    );
    expect(cfg.aceitaCliente).toBe(true);
    expect(cfg.permiteAtendente).toBe(false);
    expect(cfg.sequencia).toBe("apagar tudo");
  });

  it("sequência vazia cai no padrão", async () => {
    const cfg = await configDeLimpezaDoAgente(
      clienteComConfig({ comando_limpar: "   " }) as never,
      "org",
    );
    expect(cfg.sequencia).toBe(COMANDO_LIMPAR_PADRAO);
  });
});
