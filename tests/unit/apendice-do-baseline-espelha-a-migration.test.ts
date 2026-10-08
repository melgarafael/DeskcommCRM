/**
 * O APÊNDICE DO BASELINE É ESPELHO EXATO DA MIGRATION — e isto é cerca, não prosa.
 *
 * ─── O defeito que ela fecha, medido DUAS VEZES na mesma sessão ─────────────
 *
 * O procedimento de merge desta frente é: o `baseline.sql` vem INTEIRO da main e o delta é
 * reaplicado por script (artefato derivado não se resolve hunk a hunk). O script escreve os dois
 * arquivos de uma vez, então eles saem iguais.
 *
 * Mas se alguém edita a MIGRATION depois de rodar o script — corrigindo uma citação, reescrevendo
 * um cabeçalho —, o apêndice do baseline fica com o texto velho e **nada acusa**. Eu fiz isso duas
 * vezes seguidas: na primeira, o baseline manteve uma citação de migration errada que um cético já
 * havia reprovado; na segunda, manteve a redação que o mesmo cético havia pedido para mudar.
 *
 * Por que isso importa mais do que texto: o kit self-host aplica **só o `baseline.sql`**
 * (`install.sh` em banco novo, `update.sh` em banco existente). A migration é a fonte da verdade
 * para quem usa o Supabase CLI; o baseline é o que chega ao cliente. Divergência entre os dois
 * significa que o clone recebe uma versão diferente da que o repositório diz entregar — e a prosa
 * é o caso benigno. O maligno é divergir no SQL.
 *
 * ─── Por que comparar por INCLUSÃO, e não por igualdade ────────────────────
 *
 * O apêndice recebe um cabeçalho de três linhas (`-- ---- … (migration NNNN) ----`) que a migration
 * não tem, e vive no meio do baseline, antes do último bloco de varredura. O que tem de valer é:
 * o conteúdo da migration aparece no baseline **sem uma única diferença**. Comparar por igualdade
 * exigiria recortar o cabeçalho e erraria no primeiro ajuste dele.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const MIGRATION = "supabase/migrations/20261008130000_0611_modulo_de_dados_compilador.sql";

describe("o apêndice do baseline espelha a migration do módulo de dados", () => {
  it("controle: os dois arquivos existem e não estão vazios", () => {
    // Sem isto, um caminho errado deixaria a cerca verde sobre dois arquivos que não leu —
    // é a forma mais silenciosa de gate morto.
    expect(existsSync(join(RAIZ, MIGRATION))).toBe(true);
    const migration = readFileSync(join(RAIZ, MIGRATION), "utf8");
    const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
    expect(migration.length).toBeGreaterThan(1000);
    expect(baseline.length).toBeGreaterThan(1000);
  });

  it("⭐ o conteúdo da migration aparece no baseline, sem uma única diferença", () => {
    const migration = readFileSync(join(RAIZ, MIGRATION), "utf8");
    const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

    if (!baseline.includes(migration)) {
      // A mensagem aponta a PRIMEIRA linha divergente, porque "não bate" sem o lugar manda quem
      // for consertar reler 39 mil bytes. O conserto é refazer o apêndice a partir da main, nunca
      // editar o baseline à mão.
      const linhas = migration.split("\n");
      const divergente = linhas.findIndex((l) => l.trim().length > 0 && !baseline.includes(l));
      throw new Error(
        divergente === -1
          ? "O baseline não contém a migration inteira, mas toda linha dela existe nele isolada: " +
            "o apêndice provavelmente está fora de ordem ou cortado."
          : `O apêndice do baseline divergiu da migration a partir da linha ${divergente + 1}:\n` +
            `  ${linhas[divergente]}\n` +
            "Refaça o apêndice a partir do baseline da main (git checkout origin/main -- " +
            "supabase/baseline.sql) e reaplique o delta. Não edite o baseline à mão.",
      );
    }
    expect(baseline.includes(migration)).toBe(true);
  });
});
