import { describe, expect, it } from "vitest";

import { agentPatchSchema } from "./guardrails-schema";
import { mesclarConfigDoAgente } from "./mesclar-config-do-agente";

/**
 * O PATCH DE CONFIG SÓ MUDA O QUE VEIO.
 *
 * Este teste existe porque o Zod esconde a armadilha: `agentConfigSchema
 * .partial()` PREENCHE os `.default()` dos campos ausentes. Confiar nisso para
 * um merge reescrevia com o default todo campo não enviado — era o que apagava
 * `aceita_limpeza_cliente` ao salvar o catálogo.
 */

describe("a armadilha do Zod que motivou o helper", () => {
  it("agentPatchSchema.partial() preenche defaults de campos NÃO enviados", () => {
    const parsed = agentPatchSchema.parse({ config: { aceita_limpeza_cliente: true } });
    // O campo enviado veio certo...
    expect(parsed.config?.aceita_limpeza_cliente).toBe(true);
    // ...mas os ausentes foram preenchidos com o default — e é por isso que não
    // se pode espalhar `parsed.config` por cima do config atual.
    expect(parsed.config?.aceita_comandos_celular).toBe(false);
    expect(parsed.config?.permite_limpeza_atendente).toBe(false);
    expect(parsed.config?.temperature).toBe(0.4);
  });
});

describe("mesclarConfigDoAgente — preserva o que não foi enviado", () => {
  const PADROES = { temperature: 0.4, aceita_limpeza_cliente: false } as const;

  it("salvar o catálogo NÃO desliga os interruptores já ligados", () => {
    const atual = {
      temperature: 0.7,
      aceita_limpeza_cliente: true,
      aceita_comandos_celular: true,
      catalog: { foto_por_moto: true },
      sentiment_threshold: 0.3,
    };
    const enviadas = { catalog: { foto_por_moto: false } };
    // O parseado traz os defaults preenchidos, como na vida real:
    const parseadas = {
      catalog: { foto_por_moto: false },
      aceita_limpeza_cliente: false,
      aceita_comandos_celular: false,
      temperature: 0.4,
    };

    const r = mesclarConfigDoAgente({ atual, padroes: PADROES, enviadas, parseadas });

    expect(r.catalog).toEqual({ foto_por_moto: false });
    expect(r.aceita_limpeza_cliente).toBe(true);
    expect(r.aceita_comandos_celular).toBe(true);
    expect(r.temperature).toBe(0.7);
    // Chave desconhecida do schema (legado/outra feature) sobrevive.
    expect(r.sentiment_threshold).toBe(0.3);
  });

  it("ligar um interruptor não desfaz o irmão enviado no mesmo PATCH", () => {
    const atual = { aceita_limpeza_cliente: false, permite_limpeza_atendente: false };
    const enviadas = { aceita_limpeza_cliente: true, permite_limpeza_atendente: true };
    const parseadas = { ...enviadas, temperature: 0.4, aceita_comandos_celular: false };

    const r = mesclarConfigDoAgente({ atual, padroes: PADROES, enviadas, parseadas });

    expect(r.aceita_limpeza_cliente).toBe(true);
    expect(r.permite_limpeza_atendente).toBe(true);
  });

  it("sem `enviadas` (corpo sem config) não muda nada", () => {
    const atual = { aceita_limpeza_cliente: true, temperatura: "x" };
    const parseadas = { aceita_limpeza_cliente: false, temperature: 0.4 };
    const r = mesclarConfigDoAgente({
      atual,
      padroes: PADROES,
      enviadas: null,
      parseadas,
    });
    expect(r.aceita_limpeza_cliente).toBe(true);
    expect(r.temperatura).toBe("x");
  });

  it("chave nunca vista cai no padrão quando o config atual não a tem", () => {
    const r = mesclarConfigDoAgente({
      atual: {},
      padroes: PADROES,
      enviadas: { comando_limpar: "#apagar" },
      parseadas: { comando_limpar: "#apagar", aceita_limpeza_cliente: false },
    });
    expect(r.aceita_limpeza_cliente).toBe(false);
    expect(r.comando_limpar).toBe("#apagar");
    expect(r.temperature).toBe(0.4);
  });
});
