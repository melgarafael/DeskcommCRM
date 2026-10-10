/**
 * O RÓTULO DA SEÇÃO DE LGPD NÃO INVENTA DADO ONDE A COLUNA ERA NULA (issue #2656).
 *
 * ─── O que a issue mede e este arquivo guarda ──────────────────────────────────────────────
 * A redação por seção declarada de módulo (`modulo_secoes_lgpd`, migration 0485, gatilho
 * `trg_lgpd_secoes_de_modulo` → `fn_lgpd_redigir_secoes_de_modulo`) gravava o rótulo de
 * anonimizado em TODA linha alcançada pelas colunas de `colunas_rotulo`, inclusive onde a
 * coluna era `NULL`:
 *
 *     select string_agg(format('%I = %L', c, v_rotulo), ', ' order by c) into v_rotulos
 *
 * Resultado: um campo que nunca foi preenchido passava a dizer `Cliente Anonimizado #N`.
 * O dado é inventado — a linha passa a afirmar que havia um texto ali. Na triagem do #1907
 * apareceu como `cancel_reason = 'Cliente Anonimizado #19070000'` numa comanda finalizada
 * sem cancelamento.
 *
 * O conserto é preservar o nulo no `set` gerado, exatamente como `colunas_redigidas` já faz
 * desde a 0619: `%I = case when %I is null then null else %L end`.
 *
 * ─── Por que aqui, e não só no invariante de efeito ────────────────────────────────────────
 * `tests/invariants/rotulo-da-secao-nao-inventa-o-nulo.test.ts` mede o EFEITO no banco, mas
 * ele só roda em `pnpm test:db` (Postgres efêmero). Este arquivo é a catraca barata que roda
 * em todo `pnpm test:unit` e cobre o que o texto sozinho sabe:
 *
 *   1. a ÚLTIMA definição da função (na cadeia de migrations E no apêndice do baseline —
 *      é ela que o `create or replace` deixa de pé) monta o `set` preservando o nulo;
 *   2. o conserto saiu como MIGRATION NOVA (forward-fix), sem reescrever a 0485 nem a 0619,
 *      que já estão aplicadas em toda instalação;
 *   3. a 0619 continua com o corpo antigo — prova de que a história não foi reescrita.
 *
 * A igualdade apêndice × cadeia, corpo a corpo, é medida por
 * `tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts`; aqui o alvo é o CONTEÚDO
 * da cláusula, que aquela comparação não olha.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR_MIGRACOES = join(process.cwd(), "supabase", "migrations");
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const NOME = "fn_lgpd_redigir_secoes_de_modulo";
const MARCA = `create or replace function public.${NOME}()`;

/** A definição que o Postgres deixa de pé: a ÚLTIMA do texto (`create or replace`). */
function ultimaDefinicao(texto: string): string {
  const inicio = texto.lastIndexOf(MARCA);
  if (inicio < 0) return "";
  const fim = texto.indexOf("create or replace function", inicio + MARCA.length);
  return texto.slice(inicio, fim < 0 ? texto.length : fim);
}

const arquivos = readdirSync(DIR_MIGRACOES)
  .filter((f) => f.endsWith(".sql"))
  .sort();

function ler(nome: string): string {
  return readFileSync(join(DIR_MIGRACOES, nome), "utf8");
}

/** Toda migration, em ordem, que redefine a função — a última é a que vale. */
const queRedefinem = arquivos.filter((f) => ler(f).includes(MARCA));

const ultimaNaCadeia =
  queRedefinem.length > 0 ? ultimaDefinicao(ler(queRedefinem[queRedefinem.length - 1]!)) : "";
const ultimaNoBaseline = ultimaDefinicao(BASELINE);

/** A cláusula CORRETA: o rótulo só entra onde já havia valor. */
const PRESERVA_NULO = "case when %1$I is null then null else %2$L end', c, v_rotulo";
/** A cláusula DEFeituosa: rótulo em toda linha alcançada, nula inclusive. */
const INVENTA_DADO = "format('%I = %L', c, v_rotulo)";

describe("o rótulo da seção de LGPD preserva o nulo (issue #2656)", () => {
  it("a sonda está viva — a função existe nas duas origens e a cadeia tem histórico", () => {
    expect(queRedefinem.length, "nenhuma migration redefine a função — o parser mudou?").toBeGreaterThan(1);
    expect(ultimaNoBaseline, "a última definição da função sumiu do baseline").not.toBe("");
    expect(ultimaNaCadeia, "nenhuma migration redefine a função").not.toBe("");
    // As duas migrations que hoje a definem continuam lá: apagá-las seria reescrever história.
    expect(queRedefinem.some((f) => f.includes("_0485_"))).toBe(true);
    expect(queRedefinem.some((f) => f.includes("_0619_"))).toBe(true);
  });

  it("NA CADEIA: a última definição monta o set preservando o nulo, e não grava rótulo às cegas", () => {
    expect(ultimaNaCadeia, "a última definição da cadeia não preserva o nulo do colunas_rotulo").toContain(
      PRESERVA_NULO,
    );
    expect(ultimaNaCadeia, "a última definição da cadeia ainda grava o rótulo sobre a coluna nula").not.toContain(
      INVENTA_DADO,
    );
  });

  it("NO BASELINE: a última definição monta o set preservando o nulo, e não grava rótulo às cegas", () => {
    expect(ultimaNoBaseline, "a última definição do baseline não preserva o nulo do colunas_rotulo").toContain(
      PRESERVA_NULO,
    );
    expect(ultimaNoBaseline, "a última definição do baseline ainda grava o rótulo sobre a coluna nula").not.toContain(
      INVENTA_DADO,
    );
  });

  it("o conserto é FORWARD-FIX: sai em migration posterior às já aplicadas", () => {
    const ultima = queRedefinem[queRedefinem.length - 1]!;
    expect(ultima, "o conserto reescreveu uma migration já aplicada em vez de abrir uma nova").not.toMatch(
      /_(0485|0619)_/,
    );
    expect(ultimaNaCadeia, "a migration do conserto não carrega a cláusula nova").toContain(PRESERVA_NULO);
  });

  it("a 0619 continua com o corpo antigo — a história não foi reescrita", () => {
    const aplicada = queRedefinem.find((f) => f.includes("_0619_"));
    expect(aplicada, "a migration 0619 sumiu da árvore").toBeTruthy();
    expect(ler(aplicada!), "a 0619 foi editada — migration aplicada é intocável").toContain(INVENTA_DADO);
  });

  it("o rótulo continua sendo o único valor possível para a coluna PREENCHIDA", () => {
    // Preservar o nulo não pode virar apagar o efeito: a coluna preenchida recebe o rótulo,
    // e é o invariante de efeito que mede isto no banco.
    for (const origem of [ultimaNaCadeia, ultimaNoBaseline]) {
      expect(origem).toContain("v_rotulo text := 'Cliente Anonimizado #' || substring(new.id::text from 1 for 8)");
    }
  });
});
