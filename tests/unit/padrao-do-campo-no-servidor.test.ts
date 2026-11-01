/**
 * A régua do padrão do campo (#2730) no servidor tem PRAZO: a conferência que
 * não termina em `PRAZO_DA_CONFERENCIA_MS` fecha como padrão inválido, em vez
 * de segurar o processo que atende a instalação inteira.
 *
 * Sabotagem: trocar `testaComPrazo` por `re.test(texto)` deixa o primeiro caso
 * vermelho (a conferência leva segundos e devolve `false`), e tirar o
 * `testaComPrazo` de qualquer escritor do servidor deixa o último vermelho.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validaPadraoDoCampo } from "@/lib/leads/padrao-do-campo";
import { testaComPrazo } from "@/lib/leads/padrao-do-campo-no-servidor";

const LENTO = "^(a+)+$";
const TEXTO_LENTO = `${"a".repeat(26)}!`;

describe("conferência do padrão no servidor", () => {
  it("o padrão que não termina no prazo fecha como inválido, sem segurar o processo", () => {
    const inicio = performance.now();
    const veredito = validaPadraoDoCampo({ key: "k", padrao: LENTO }, TEXTO_LENTO, testaComPrazo);
    const gasto = performance.now() - inicio;

    expect(veredito).toEqual({ ok: false, motivo: "padrao_invalido" });
    expect(gasto, "a conferência passou do prazo").toBeLessThan(1000);
  });

  it("o padrão comum confere igual ao `test` direto", () => {
    const def = { key: "idades", padrao: "^\\d{1,2}(,\\d{1,2})*$" };
    expect(validaPadraoDoCampo(def, "2,9", testaComPrazo)).toEqual({ ok: true });
    expect(validaPadraoDoCampo(def, "dois", testaComPrazo)).toEqual({
      ok: false,
      motivo: "fora_do_padrao",
    });
    expect(testaComPrazo(/^[A-Z0-9]{6}$/, "ABC123")).toBe(true);
  });

  it("todo escritor do servidor confere com prazo", () => {
    const chamadores = execFileSync(
      "git",
      ["grep", "-l", "recusasDePadrao(", "--", "app", "lib", ":!*.test.ts", ":!*.test.tsx"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((arquivo) => arquivo && arquivo !== "lib/leads/padrao-do-campo.ts");

    // Controle positivo: os três escritores conhecidos estão na lista.
    expect(chamadores).toEqual(
      expect.arrayContaining([
        "app/api/v1/contacts/_handler.ts",
        "app/api/v1/leads/_handler.ts",
        "lib/mcp/conferencia-de-campos.ts",
      ]),
    );
    for (const arquivo of chamadores) {
      const fonte = readFileSync(arquivo, "utf8");
      const chamadas = fonte.match(/recusasDePadrao\([^;]*?\);/gs) ?? [];
      expect(chamadas.length, arquivo).toBeGreaterThan(0);
      for (const chamada of chamadas) expect(chamada, arquivo).toContain("testaComPrazo");
    }
  });
});
