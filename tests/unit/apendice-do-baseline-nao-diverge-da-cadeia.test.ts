import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * O APÊNDICE DO BASELINE É ESPELHO DA CADEIA — E ESPELHO SE DERIVA, NÃO SE COPIA.
 *
 * Toda mudança de schema sai em DOIS artefatos: o arquivo em
 * `supabase/migrations/` (que o Supabase CLI aplica em ordem) e o apêndice
 * idempotente do `supabase/baseline.sql` (que o `install.sh`/`update.sh` do
 * self-host aplica). Quando os dois divergem, cada público recebe um produto
 * diferente — e o gate não vê, porque `pnpm test:db` aplica só o baseline.
 *
 * Foi o que aconteceu e o que este arquivo existe para impedir: a migration
 * 0224 redefiniu `fn_service_event_origin` com o corpo ANTERIOR ao conserto da
 * 0223. Assinatura idêntica, então `create or replace` sobrescreve, e
 * `20260906120000 > 20260906030000` — na cadeia o conserto sumia. No baseline
 * não, porque lá o bloco foi editado à mão. Verde em todo lugar, e quem aplica
 * a cadeia ficava com o defeito.
 *
 * A regra que este teste cobra: para toda função cuja ÚLTIMA definição no
 * baseline está no APÊNDICE (isto é, foi escrita à mão, e não despejada pelo
 * `pg_dump`), o corpo tem de ser igual ao da ÚLTIMA definição na cadeia de
 * migrations. Funções que só existem no corpo do dump ficam de fora de
 * propósito: ali o `pg_dump` reformata, e comparar texto acusaria diferença que
 * não é divergência — o modo de falha de medir a FORMA em vez do conteúdo.
 */
const RAIZ = join(process.cwd(), "supabase");
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");

/** Primeira marca de apêndice: daí para baixo, tudo é escrito à mão. */
const INICIO_DO_APENDICE = BASELINE.search(/^-- ---- .* \(migration \d+\) ----/m);

/**
 * O que se compara é CÓDIGO, não prosa.
 *
 * Comentário reescrito de um lado só é divergência de TEXTO, não de
 * comportamento — medido: 11 funções antigas diferem exatamente assim (uma
 * assinatura quebrada em linhas, um comentário reformulado). Um gate que as
 * acusasse nasceria vermelho por ruído, e gate que tolera ruído é gate que
 * ninguém lê. Sem os comentários, o que sobra é o que o Postgres executa — e é
 * ali que a divergência custa caro.
 *
 * A varredura de `--` não distingue comentário de hífen duplo dentro de string
 * literal. Nenhuma função destes artefatos tem uma, e o custo de errar seria um
 * falso VERMELHO (nunca um falso verde), que é o lado certo para errar.
 */
function semComentarios(sql: string): string {
  return (
    sql
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join(" ")
      // A MARCA DO DELIMITADOR é escolha de quem escreveu, não semântica: o
      // baseline usa `$fn$` onde a migration usa `$$`, e o Postgres executa o
      // mesmo corpo. Uniformizar aqui evita um vermelho que não fala de nada.
      .replace(/\$[a-z_]*\$/gi, "$$$$")
      .replace(/\s+/g, " ")
      // Espaço colado ou não em `(`, `)` e `,` também é estilo — o `pg_dump` e a
      // mão humana discordam nisso o tempo todo.
      .replace(/\s*([(),])\s*/g, "$1")
      .trim()
  );
}

function definicoes(texto: string): Map<string, { corpo: string; pos: number }> {
  const achadas = new Map<string, { corpo: string; pos: number }>();
  const re = /create or replace function public\.(fn_[a-z_]+)\s*\(/gi;
  for (let m = re.exec(texto); m !== null; m = re.exec(texto)) {
    // O DELIMITADOR NÃO É SEMPRE `$$`. O baseline usa `$fn$ … $fn$` em algumas
    // funções, e procurar `$$;` fixo faz o corpo ser lido ALÉM do fim — foi
    // exatamente assim que esta sonda acusou `fn_agora` e
    // `fn_upsert_wa_conversation` como divergentes quando o que divergia era
    // ela. A marca de abertura é lida do próprio texto e a de fechamento é a
    // igual a ela.
    const abertura = /\$([a-z_]*)\$/i.exec(texto.slice(m.index, m.index + 600));
    if (!abertura) continue;
    const marca = abertura[0];
    const fim = texto.indexOf(marca, m.index + abertura.index + marca.length);
    if (fim === -1) continue;
    // A ÚLTIMA vence, que é a que o Postgres deixa de pé.
    achadas.set(m[1]!.toLowerCase(), {
      corpo: semComentarios(texto.slice(m.index, fim + marca.length)),
      pos: m.index,
    });
  }
  return achadas;
}

const cadeia = (() => {
  const acc = new Map<string, { corpo: string; pos: number }>();
  for (const arquivo of readdirSync(join(RAIZ, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    for (const [nome, def] of definicoes(readFileSync(join(RAIZ, "migrations", arquivo), "utf8")))
      acc.set(nome, def);
  return acc;
})();
const noBaseline = definicoes(BASELINE);

describe("apêndice do baseline não diverge da cadeia de migrations", () => {
  it("a sonda está viva — o apêndice existe e tem função escrita à mão", () => {
    // Sem este controle, um `search` que voltasse -1 faria o conjunto medido
    // ficar vazio e o caso abaixo passar por vacuidade.
    expect(
      INICIO_DO_APENDICE,
      "nenhuma marca `-- ---- … (migration N) ----` no baseline",
    ).toBeGreaterThan(0);
    const doApendice = [...noBaseline.entries()].filter(([, d]) => d.pos > INICIO_DO_APENDICE);
    expect(
      doApendice.length,
      "nenhuma função no apêndice — o parser mudou de forma?",
    ).toBeGreaterThan(5);
  });

  it("toda função escrita à mão no apêndice tem o mesmo corpo da última definição na cadeia", () => {
    const divergentes: string[] = [];
    for (const [nome, def] of noBaseline) {
      if (def.pos <= INICIO_DO_APENDICE) continue; // veio do pg_dump: reformatado, não comparável
      const naCadeia = cadeia.get(nome);
      if (!naCadeia) continue; // só no baseline: fora do escopo desta regra
      if (naCadeia.corpo !== def.corpo) divergentes.push(nome);
    }
    expect(
      divergentes,
      "A última definição na CADEIA difere da do APÊNDICE. Quem aplica as migrations recebe " +
        "um corpo, quem aplica o baseline recebe outro — e nenhum gate vê, porque `test:db` só " +
        "aplica o baseline. Causa típica: uma migration POSTERIOR redefiniu a função com o corpo " +
        "de antes de um conserto (assinatura igual ⇒ `create or replace` sobrescreve). Derive o " +
        "apêndice da migration em vez de reescrevê-lo.\n",
    ).toEqual([]);
  });
});
