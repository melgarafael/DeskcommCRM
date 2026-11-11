/**
 * O PRIMEIRO NOME DO RÓTULO (#4031).
 *
 * O balão diz `Atendente · Andreia`. O nome vem de `auth.users.user_metadata`,
 * que é JSONB e chega cru: pode ser composto, vir com espaço em volta, vir em
 * branco (cadastro incompleto) ou não ser texto. Nenhum desses casos pode
 * produzir `"Atendente · "` — separador pendurado — nem um erro na tela.
 */
import { describe, expect, it } from "vitest";

import { primeiroNomeDeQuemEnviou } from "./nome-no-balao";

describe("#4031 — primeiro nome de quem enviou", () => {
  it("nome composto vira o primeiro nome", () => {
    expect(primeiroNomeDeQuemEnviou("Andreia Cristina de Souza")).toBe("Andreia");
  });

  it("espaço em volta não vaza para o rótulo", () => {
    expect(primeiroNomeDeQuemEnviou("  Thamyres  ")).toBe("Thamyres");
  });

  it("nome de uma palavra sai inteiro", () => {
    expect(primeiroNomeDeQuemEnviou("Thamyres")).toBe("Thamyres");
  });

  it("tab e espaço duplo separam como espaço simples (nome colado do Google)", () => {
    expect(primeiroNomeDeQuemEnviou("Andreia\tCristina")).toBe("Andreia");
    expect(primeiroNomeDeQuemEnviou("Andreia    Cristina")).toBe("Andreia");
  });

  it("nome em branco, nulo ou ausente devolve null — o balão cai em 'Atendente'", () => {
    expect(primeiroNomeDeQuemEnviou("")).toBeNull();
    expect(primeiroNomeDeQuemEnviou("   ")).toBeNull();
    expect(primeiroNomeDeQuemEnviou(null)).toBeNull();
    expect(primeiroNomeDeQuemEnviou(undefined)).toBeNull();
  });

  it("o que não é texto não vira rótulo (JSONB pode trazer qualquer coisa)", () => {
    expect(primeiroNomeDeQuemEnviou(42)).toBeNull();
    expect(primeiroNomeDeQuemEnviou({ nome: "Andreia" })).toBeNull();
    expect(primeiroNomeDeQuemEnviou(["Andreia"])).toBeNull();
  });
});
