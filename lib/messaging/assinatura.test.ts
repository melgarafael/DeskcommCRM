/**
 * A assinatura do emissor (#2066): o nome de quem fala em negrito acima do texto.
 *
 * A casa de regras é PURA (`lib/messaging/assinatura.ts`) — quem lê o settings
 * e resolve o nome do atendente é o handler. Este arquivo prende o formato
 * (`*Nome*\n`), o opt-in só-com-`true`, o nome configurável da IA e a regra de
 * "não assina automação". A fiação dentro do handler tem prova à parte em
 * `tests/unit/assinatura-nas-mensagens.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  aplicarAssinatura,
  capitalizarIniciais,
  configAssinatura,
  linhaDeAssinatura,
} from "./assinatura";

describe("configAssinatura", () => {
  it("degenera para tudo desligado quando não há settings (adição não muda instalação existente)", () => {
    expect(configAssinatura(undefined)).toEqual({ humanos: false, ia: false, nomeIa: "Assistente Virtual" });
    expect(configAssinatura({})).toEqual({ humanos: false, ia: false, nomeIa: "Assistente Virtual" });
    expect(configAssinatura({ outras: 1 })).toEqual({ humanos: false, ia: false, nomeIa: "Assistente Virtual" });
  });

  it("lê humanos/ia/nome_ia do settings, e jsonb torto degrada sem lançar", () => {
    const on = configAssinatura({
      assinatura_mensagens: { humanos: true, ia: true, nome_ia: "Ana I.A." },
    });
    expect(on).toEqual({ humanos: true, ia: true, nomeIa: "Ana I.A." });

    // A string "true" não liga — só o booleano (régua da casa).
    expect(configAssinatura({ assinatura_mensagens: { humanos: "true", ia: 1 } }).humanos).toBe(false);
    expect(configAssinatura({ assinatura_mensagens: "lixo" })).toEqual({
      humanos: false,
      ia: false,
      nomeIa: "Assistente Virtual",
    });
  });
});

describe("capitalizarIniciais", () => {
  it("põe a primeira letra de cada palavra em maiúscula, sem rebaixar 'da/de/do'", () => {
    expect(capitalizarIniciais("junior da silva")).toBe("Junior Da Silva");
    expect(capitalizarIniciais("carlos gaban")).toBe("Carlos Gaban");
    expect(capitalizarIniciais("")).toBe("");
  });
});

describe("linhaDeAssinatura", () => {
  it("humano: `*Nome*\n` com iniciais em maiúsculo, quando a config liga humanos", () => {
    expect(linhaDeAssinatura({ humanos: true, ia: false, nomeIa: "x" }, "user", "carlos gaban")).toBe(
      "*Carlos Gaban*\n",
    );
  });

  it("humano desligado → null, mesmo com o nome à mão", () => {
    expect(linhaDeAssinatura({ humanos: false, ia: false, nomeIa: "x" }, "user", "Carlos")).toBeNull();
  });

  it("humano sem nome resolvido → null (não assina uma linha sem dono)", () => {
    expect(linhaDeAssinatura({ humanos: true, ia: false, nomeIa: "x" }, "user", "  ")).toBeNull();
    expect(linhaDeAssinatura({ humanos: true, ia: false, nomeIa: "x" }, "user", null)).toBeNull();
  });

  it("IA: usa o nome configurável da organização, no formato que ela deu", () => {
    expect(linhaDeAssinatura({ humanos: false, ia: true, nomeIa: "Assistente Virtual" }, "ai")).toBe(
      "*Assistente Virtual*\n",
    );
    expect(linhaDeAssinatura({ humanos: false, ia: true, nomeIa: "Agente Juliana" }, "ai")).toBe(
      "*Agente Juliana*\n",
    );
  });

  it("IA desligada → null", () => {
    expect(linhaDeAssinatura({ humanos: false, ia: false, nomeIa: "x" }, "ai")).toBeNull();
  });
});

describe("aplicarAssinatura", () => {
  it("prefixa o texto quando há assinatura", () => {
    expect(aplicarAssinatura("*Carlos*\n", "Bom dia!")).toBe("*Carlos*\nBom dia!");
  });

  it("devolve o texto como veio sem assinatura ou sem texto — mídia sem legenda não ganha linha solta", () => {
    expect(aplicarAssinatura(null, "oi")).toBe("oi");
    expect(aplicarAssinatura("*Carlos*\n", null)).toBeNull();
    expect(aplicarAssinatura("*Carlos*\n", "")).toBe("");
  });
});
describe("semAssinatura — a volta do que aplicarAssinatura pôs (#2079)", async () => {
  const { semAssinatura } = await import("./assinatura");

  it("tira exatamente a linha que a assinatura pôs, para IA e humano", () => {
    const cfg = configAssinatura({ assinatura_mensagens: { humanos: true, ia: true, nome_ia: "Bia" } });
    for (const linha of [linhaDeAssinatura(cfg, "ai"), linhaDeAssinatura(cfg, "user", "carlos gaban")]) {
      expect(semAssinatura(aplicarAssinatura(linha, "oi\n*tudo bem?*") ?? "")).toBe("oi\n*tudo bem?*");
    }
  });

  it("texto sem assinatura volta como veio, inclusive negrito que não é a primeira linha", () => {
    expect(semAssinatura("oi")).toBe("oi");
    expect(semAssinatura("*promo*")).toBe("*promo*");
  });
});
