/**
 * `precoNumero`: o SQL que converte texto de preço em número no MySQL.
 * O que se prova aqui é a FORMA do SQL (o MySQL de verdade roda em
 * `tests/mysql/receita-wordpress-conteudo.test.ts`): o símbolo sai ANTES do CAST e preço
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

  /**
   * A ORDEM dos ramos é a régua do formato: a vírgula decimal (BR) é
   * decidida ANTES do ponto decimal (US). Sem esta guarda, trocar os dois
   * ramos passa — e a leitura do preço americano sai errada.
   */
  it("o ramo de vírgula decimal vem ANTES do de ponto decimal", () => {
    const iVirgula = sql.indexOf("REGEXP ',[0-9]{1,2}$'");
    const iPonto = sql.indexOf("REGEXP '[.][0-9]{1,2}$'");
    expect(iVirgula).toBeGreaterThan(-1);
    expect(iPonto).toBeGreaterThan(-1);
    expect(iVirgula).toBeLessThan(iPonto);
  });

  /**
   * Cada ramo tem a SUA forma — a do decimal brasileiro tira o ponto e troca
   * a vírgula por ponto, a do decimal americano tira a vírgula e mantém o
   * ponto, e o resto (só milhar) tira os dois separadores.
   */
  it("cada ramo do CASE tem a forma da sua régua (vírgula decimal, ponto decimal, só milhar)", () => {
    // (b) vírgula decimal (BR): o ponto é milhar e sai, a vírgula vira ponto.
    expect(sql).toContain(
      `WHEN ${LIMPO} REGEXP ',[0-9]{1,2}$' THEN CAST(REPLACE(REPLACE(${LIMPO}, '.', ''), ',', '.') AS DECIMAL(10,2))`,
    );
    // (c) ponto decimal (US): a vírgula é milhar e sai, o ponto fica.
    expect(sql).toContain(
      `WHEN ${LIMPO} REGEXP '[.][0-9]{1,2}$' THEN CAST(REPLACE(${LIMPO}, ',', '') AS DECIMAL(10,2))`,
    );
    // (d) só separadores de milhar: os dois saem.
    expect(sql).toContain(
      `ELSE CAST(REPLACE(REPLACE(${LIMPO}, '.', ''), ',', '') AS DECIMAL(10,2))`,
    );
  });
});
