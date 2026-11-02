/**
 * A FAIXA DE MIGRATION DO FORK NÃO VOLTA PARA ONDE O ORIGINAL NUMERA.
 *
 * O fork reservava 9001+. Em 26/10/2026 o original pulou de 0807 para 9016 e
 * passou a numerar ali (máximo + 1), então a faixa antiga colide. O fork numera
 * de 5001 em diante. Regra em `FORK.md`.
 *
 * O original NÃO abandonou a série baixa: a v1.98.0 trouxe 0808 e 0809. Por
 * isso o trecho vigiado começa na faixa do fork (5000) e não em 0808 — abaixo
 * de 5000 é número do original.
 *
 * Limite: este teste não distingue uma migration do fork numerada 9022+ de uma
 * do original — quem pega esse caso é a sincronização (`.fork/sincronizar.sh`,
 * colisão de NNNN). Ele trava esse trecho e o texto que ensina o número.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const DIR = join(RAIZ, "supabase", "migrations");

/** Já rodam em VPS: o número é a versão gravada no banco, não se renumera. */
const LEGADAS_DO_FORK = new Set(["9001", "9002", "9003", "9004"]);
/** Primeiro NNNN da série alta do original; abaixo de 5000, a série baixa dele. */
const ORIGINAL_DEPOIS_DO_PULO = 9016;
const SERIE_BAIXA_DO_ORIGINAL_ATE = 5000;
const INICIO_DA_FAIXA = 5001;

function numeros(): string[] {
  return readdirSync(DIR)
    .map((f) => /^[0-9]{14}_([0-9]{4})_/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined);
}

describe("faixa de migration do fork", () => {
  it("entre 5000 e 9015 só há a faixa 5001+ e as quatro legadas", () => {
    const fora = numeros().filter((n) => {
      const v = Number(n);
      const noBuraco = v >= SERIE_BAIXA_DO_ORIGINAL_ATE && v < ORIGINAL_DEPOIS_DO_PULO;
      const naFaixa = v >= INICIO_DA_FAIXA && v < 9000;
      return noBuraco && !naFaixa && !LEGADAS_DO_FORK.has(n);
    });
    expect(fora).toEqual([]);
  });

  it("o FORK.md ensina a faixa 5001, não a antiga 9001", () => {
    const fork = readFileSync(join(RAIZ, "FORK.md"), "utf-8");
    expect(fork).toContain("faixa 5001 em diante");
    expect(fork).not.toMatch(/faixa 9001 em diante/);
    expect(fork).not.toMatch(/grep -oE '_9\[0-9\]\{3\}_'/);
  });
});
