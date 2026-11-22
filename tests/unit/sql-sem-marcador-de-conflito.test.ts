/**
 * Nenhum `.sql` do schema carrega marcador de conflito de merge.
 *
 * Por quê: em 19/11 um merge deixou `<<<<<<<`/`=======`/`>>>>>>>` no apêndice do
 * `supabase/baseline.sql`, e todas as cercas unitárias passaram — elas leem o
 * baseline em pedaços (por bloco, por função) e nenhuma tropeça numa linha que
 * não é SQL. Só o `test:db` pegou, ao aplicar o arquivo num Postgres, horas
 * depois. O `update.sh` do self-host aplica o baseline SEM `ON_ERROR_STOP`: um
 * marcador ali vira erro de sintaxe engolido e o bloco seguinte não chega ao
 * clone. Esta cerca custa um `readFileSync` e reprova no `test:unit`.
 *
 * O padrão exige o marcador NO COMEÇO da linha seguido de espaço ou fim de linha,
 * que é como o git os escreve — `=======` dentro de um comentário de régua
 * (`-- =======`) não começa a linha e não casa.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MARCADOR = /^(<<<<<<<|=======|>>>>>>>)( |$)/;

function arquivosSql(): string[] {
  const raiz = join(process.cwd(), "supabase");
  const migrations = join(raiz, "migrations");
  return [
    ...readdirSync(raiz).filter((f) => f.endsWith(".sql")).map((f) => join(raiz, f)),
    ...readdirSync(migrations).filter((f) => f.endsWith(".sql")).map((f) => join(migrations, f)),
  ];
}

function marcadoresDeConflito(texto: string): number[] {
  return texto
    .split("\n")
    .flatMap((linha, i) => (MARCADOR.test(linha) ? [i + 1] : []));
}

describe("os .sql do schema não carregam marcador de conflito", () => {
  it("o detector acha os três marcadores e ignora a régua de comentário", () => {
    const amostra = ["select 1;", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> origin/main", "-- =======", "x ======="].join("\n");
    expect(marcadoresDeConflito(amostra)).toEqual([2, 4, 6]);
  });

  it("baseline.sql e migrations/*.sql estão limpos", () => {
    const arquivos = arquivosSql();
    expect(arquivos.length).toBeGreaterThan(100);
    const sujos = arquivos
      .map((f) => ({ f: f.replace(process.cwd() + "/", ""), linhas: marcadoresDeConflito(readFileSync(f, "utf8")) }))
      .filter((x) => x.linhas.length > 0)
      .map((x) => `${x.f}: linhas ${x.linhas.join(", ")}`);
    expect(sujos, `marcador de conflito de merge em:\n${sujos.join("\n")}`).toEqual([]);
  });
});
