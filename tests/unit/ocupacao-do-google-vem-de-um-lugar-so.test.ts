/**
 * A OCUPAÇÃO DO GOOGLE QUE A TELA MOSTRA SAI DE UM LUGAR SÓ (#525).
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * A premissa inteira do conserto da #525 é "uma leitura só": a semente do
 * servidor (`app/app/agenda/page.tsx`) e a rota
 * (`app/api/v1/agenda/agendamentos/route.ts`) liam a MESMA ocupação com a MESMA
 * consulta copiada, e foi só uma das cópias mudar para a tela passar a mostrar
 * livre um horário que o motor recusa.
 *
 * `tests/unit/agenda-recorte-do-google-atravessa-o-limite.test.ts` mede a
 * FUNÇÃO: dá linhas a `lerOcupacaoExterna` e confere a fatia devolvida. Nenhum
 * caso dali abre um arquivo de tela — devolver qualquer consumidor à consulta
 * inline da `main` deixava a suíte inteira verde, com a divergência de volta.
 *
 * ─── O que ele prende, e por que por CLASSE e não por instância ─────────────
 *
 * Cobrar `lerOcupacaoExterna(` nos dois arquivos conhecidos guarda os dois
 * arquivos conhecidos. O que este repo já pagou caro é o conserto por
 * INSTÂNCIA: a terceira tela que precisar da ocupação amanhã nasce fora da
 * lista, escreve a consulta de novo, e nenhum gate acusa. Por isso a varredura
 * é sobre TODO arquivo versionado sob `app/` e `lib/agenda/`, e a lista é de
 * EXCEÇÕES, não de alvos — arquivo novo entra vigiado por construção.
 *
 * `supabase/`, `lib/database.types.ts`, `tests/`, `docs/` e `evidence/` ficam
 * fora do alcance de propósito: lá o nome da view é schema, tipo gerado,
 * fixture ou prosa, não uma segunda leitura da ocupação.
 *
 *     npx vitest run tests/unit/ocupacao-do-google-vem-de-um-lugar-so.test.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** A view que só o módulo da ocupação pode ler. */
const VIEW = "calendar_selected_external_events";

/** O ÚNICO arquivo do alcance autorizado a nomear a view. */
const DONO = "lib/agenda/ocupacao-externa.ts";

/** Os consumidores que precisam continuar chamando a leitura única. */
const CONSUMIDORES = ["app/app/agenda/page.tsx", "app/api/v1/agenda/agendamentos/route.ts"];

const raiz = process.cwd();

/**
 * Os arquivos VERSIONADOS do alcance. `git ls-files` e não uma varredura do
 * disco: arquivo não rastreado não existe para o CI, e medir o disco daria um
 * verde que o CI não reproduz — e um vermelho por artefato de build local.
 */
function arquivosDoAlcance(): string[] {
  const saida = execFileSync(
    "git",
    ["ls-files", "--", "app/*.ts", "app/*.tsx", "lib/agenda/*.ts", "lib/agenda/*.tsx"],
    { cwd: raiz, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return saida.split("\n").filter(Boolean);
}

describe("a ocupação do Google tem UMA leitura, e ela é lib/agenda/ocupacao-externa.ts", () => {
  it("nenhum arquivo de app/ ou lib/agenda/ além do dono nomeia a view", () => {
    const alcance = arquivosDoAlcance();
    // Controle de instrumento: uma lista vazia deixaria o `for` abaixo passar
    // sem medir nada, e o verde leria como "ninguém nomeia a view".
    expect(alcance.length, "git ls-files não devolveu arquivo nenhum do alcance").toBeGreaterThan(
      50,
    );
    expect(alcance, "o próprio dono precisa estar no alcance varrido").toContain(DONO);

    const infratores = alcance.filter(
      (arquivo) => arquivo !== DONO && readFileSync(join(raiz, arquivo), "utf8").includes(VIEW),
    );
    expect(
      infratores,
      `só ${DONO} pode ler "${VIEW}" — uma segunda consulta é a divergência da #525 de volta`,
    ).toEqual([]);
  });

  it("CONTROLE: o dono realmente nomeia a view — senão o caso acima passa por vacuidade", () => {
    expect(readFileSync(join(raiz, DONO), "utf8")).toContain(VIEW);
  });

  it("a tela e a rota continuam PEDINDO a leitura única", () => {
    // O caso da varredura prova que ninguém tem consulta PRÓPRIA. Este prova que
    // os dois consumidores seguem chamando a de todos: sem ele, apagar a chamada
    // e deixar a grade sem ocupação nenhuma passaria verde nos dois.
    for (const arquivo of CONSUMIDORES) {
      expect(readFileSync(join(raiz, arquivo), "utf8"), arquivo).toContain("lerOcupacaoExterna(");
    }
  });
});
