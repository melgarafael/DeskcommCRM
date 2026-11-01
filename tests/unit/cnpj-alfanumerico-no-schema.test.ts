/**
 * A coluna que guarda o CNPJ tem de aceitar o formato que a rota aceita (#3495).
 *
 * O cadastro já recusava DV errado e o `normalizeCnpj` já chamava `isValidCnpj`
 * (veio com o #3515 pela importação), mas quem aceitava o CNPJ alfanumérico era
 * só a cobrança: `companies.normalized_cnpj` nasceu com
 * `check (normalized_cnpj ~ '^\d{14}$')` e a rota de empresa, por consequência,
 * recusava o documento que a Receita emite desde 2026. A régua de código e a de
 * banco têm de dizer a MESMA coisa — quando divergem, um documento válido morre
 * no INSERT com 500 em vez de mensagem.
 *
 * Este teste lê o schema como texto (é o que a instalação aplica), não declara a
 * régua à mão: quem for mudar o formato muda a migration e o espelho juntos.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { RAIZ_DO_REPO } from "./helpers/varrer-codigo";

/** O CHECK da coluna, como está escrito no arquivo: o texto entre parênteses. */
function checksDoCnpjNormalizado(arquivo: string): string[] {
  const sql = readFileSync(path.join(RAIZ_DO_REPO, arquivo), "utf8");
  const achados: string[] = [];
  const re = /check\s*\(([^;]*?normalized_cnpj[^;]*?)\)\s*[,;]/g;
  for (const m of sql.matchAll(re)) achados.push(m[1]!);
  return achados;
}

describe("o schema aceita o CNPJ alfanumérico da Receita (#3495)", () => {
  /**
   * O BASELINE é a instalação nova (é o arquivo inteiro que `install.sh`
   * aplica): nele não pode sobrar régua de dígito. A 0448 não entra nesta
   * conta — migration antiga é história e não se reescreve; quem cura banco
   * instalado antes é a 9056, logo abaixo.
   */
  it("o baseline não guarda CHECK de 14 DÍGITOS em normalized_cnpj", () => {
    const checks = checksDoCnpjNormalizado("supabase/baseline.sql");
    expect(checks.length).toBeGreaterThan(0);
    expect(
      checks.filter((check) => !/\[0-9A-Z\]/.test(check)),
      "check que só admite dígito recusa o CNPJ alfanumérico que a rota aceita",
    ).toEqual([]);
  });

  it("a migration da régua nova vem DEPOIS da 0448 que criou a coluna", () => {
    const culpada = "20260928132000_0448_empresas_pessoas_importacao.sql";
    const migration = readdirSync(path.join(RAIZ_DO_REPO, "supabase", "migrations")).find((n) =>
      /^[0-9]{14}_9056_[a-z0-9_]+\.sql$/.test(n),
    );
    expect(migration).toBeTruthy();
    expect(migration! > culpada).toBe(true);
  });

  it("o CHECK admite as 12 posições alfanuméricas + os 2 dígitos, em maiúscula", () => {
    const baseline = checksDoCnpjNormalizado("supabase/baseline.sql");
    expect(baseline.length).toBeGreaterThan(0);
    expect(baseline.join("\n")).toContain("[0-9A-Z]{14}");
  });

  it("a migration que muda a régua existe e é reaplicável (drop antes do add)", () => {
    const arquivo = readdirSync(path.join(RAIZ_DO_REPO, "supabase", "migrations")).find((n) =>
      /^[0-9]{14}_9056_[a-z0-9_]+\.sql$/.test(n),
    );
    expect(arquivo, "migration 9056 do CNPJ alfanumérico não encontrada").toBeTruthy();
    const sql = readFileSync(path.join(RAIZ_DO_REPO, "supabase", "migrations", arquivo!), "utf8");
    expect(sql).toMatch(/drop constraint if exists companies_normalized_cnpj_digits/);
    expect(sql).toMatch(/add constraint companies_normalized_cnpj_digits/);
    expect(sql).toMatch(/\[0-9A-Z\]\{14\}/);
    expect(sql.split("\n")[0]).toMatch(/^-- manifest: .{20,}/);
  });
});
