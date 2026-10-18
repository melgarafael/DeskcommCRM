/**
 * `precoNumero`: o SQL que converte texto de preço em número no MySQL.
 * O que se prova aqui é a FORMA do SQL (o MySQL de verdade roda em
 * `tests/mysql/receita-acf-imoveis.test.ts`): o símbolo sai ANTES do CAST e preço
 * sem dígito vira NULL, não 0.
 */
import { describe, expect, it } from "vitest";

import { precoNumero } from "./preco";

const COL = "mpreco.meta_value";
const LIMPO = `REGEXP_REPLACE(${COL}, '[^0-9.,]', '')`;

describe("precoNumero", () => {
  const sql = precoNumero(COL);

  it("tira tudo que não é dígito, ponto ou vírgula antes de converter ('R$ 650.000,00')", () => {
    expect(sql).toContain(LIMPO);
    // Depois de tirar a expressão limpa, a coluna crua não pode sobrar em CAST/REPLACE/LIKE/REGEXP.
    const semLimpo = sql.split(LIMPO).join("«limpo»");
    expect(semLimpo).not.toContain(COL);
    // Os três ramos do CAST convertem a coluna LIMPA.
    const casts = semLimpo.match(/CAST\([^\n]*AS DECIMAL\(10,2\)\)/g) ?? [];
    expect(casts).toHaveLength(3);
    for (const c of casts) expect(c).toContain("«limpo»");
  });

  it("preço sem nenhum dígito vira NULL (nunca 0), e é o PRIMEIRO ramo do CASE", () => {
    const primeiroWhen = sql.indexOf("WHEN");
    expect(sql.indexOf(`WHEN ${LIMPO} NOT REGEXP '[0-9]' THEN NULL`)).toBe(primeiroWhen);
  });

  it("não introduz placeholder nem nada que o validador de receita proíbe", () => {
    expect(sql).not.toContain("?");
    expect(sql).not.toMatch(/--|\/\*|#|;/);
  });

  it("mantém os três formatos: vírgula decimal, ponto decimal de 1-2 dígitos, ponto de milhar", () => {
    expect(sql).toContain("LIKE '%,%'");
    expect(sql).toContain("REGEXP '[.][0-9]{1,2}$'");
    expect(sql).toContain("ELSE CAST(REPLACE(");
  });
});
