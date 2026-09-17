import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * A ATUALIZAÇÃO NÃO REABRE PERMISSÃO QUE O CLONE JÁ TINHA FECHADO.
 *
 * O `update.sh` re-aplica o `baseline.sql` inteiro num banco que já tem o schema,
 * em autocommit. `CREATE OR REPLACE` NÃO altera ACL, então o único jeito de a
 * aplicação afrouxar permissão no meio do caminho é um `GRANT` que o apêndice só
 * revoga adiante. Eram duas funções; as linhas saíram, e este invariante existe
 * para que não voltem.
 *
 * ## O que este invariante faz, e por que é assim
 *
 * O molde deste arquivo já tem o baseline aplicado (é o estado FINAL, o do clone
 * que acabou de atualizar). Aqui: (1) fotografa quem pode executar o quê; (2)
 * aplica o baseline TRUNCADO no primeiro rótulo de apêndice — que é o update
 * interrompido no pior ponto, com todo o corpo do dump aplicado e nenhum bloco de
 * endurecimento ainda; (3) exige que ninguém tenha ganhado EXECUTE.
 *
 * O corte no fim do corpo não é arbitrário: é onde TODOS os `GRANT` do `pg_dump`
 * já rodaram e NENHUM `revoke` do apêndice rodou. Se existe reabertura no arquivo,
 * ela é visível ali.
 *
 * A régua de texto que pega a mesma coisa sem banco é
 * `tests/unit/baseline-nao-reconcede-o-que-revoga.test.ts`.
 */
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/** Quem executa o quê, hoje: uma linha por função de public alcançável por papel de cliente. */
function permissoesDeCliente(): string {
  return sql(`
    select coalesce(string_agg(t, E'\\n' order by t), '') from (
      select p.oid::regprocedure::text || ' | ' ||
             case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'anon' else '' end ||
             case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then ' authenticated' else '' end as t
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
         and (has_function_privilege('anon', p.oid, 'EXECUTE')
              or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) x;
  `);
}

/** O baseline até o primeiro rótulo de apêndice: todo o dump, nenhum endurecimento. */
function corpoDoDump(): string {
  const linhas = BASELINE.split("\n");
  const fim = linhas.findIndex((l) => /^-- ---- .* \(migration \d+\) ----/.test(l));
  if (fim <= 0) throw new Error("fronteira corpo/apêndice não encontrada no baseline");
  return linhas.slice(0, fim).join("\n");
}

describe("re-aplicar o baseline não reabre permissão", () => {
  it(
    "nenhuma função de public ganha EXECUTE para anon ou authenticated no meio da atualização",
    () => {
      const antes = permissoesDeCliente();
      // Controle de vacuidade: se a sonda não enxerga nada, "nada mudou" seria
      // verdade por cegueira. O produto tem dezenas de funções alcançáveis.
      expect(antes.split("\n").filter(Boolean).length, "a sonda de permissão não achou função nenhuma").toBeGreaterThan(50);

      const r = spawnSync(
        "docker",
        ["exec", "-i", "-e", "PGOPTIONS=-c client_min_messages=warning", process.env.TEST_DB_CONTAINER!,
         "psql", "-U", "postgres", "-d", "postgres", "-q", "-f", "-"],
        { input: corpoDoDump(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      expect(r.error, "não consegui rodar o psql no contêiner").toBeUndefined();

      const depois = permissoesDeCliente();
      const linhasAntes = new Set(antes.split("\n").filter(Boolean));
      const ganharam = depois
        .split("\n")
        .filter(Boolean)
        .filter((l) => !linhasAntes.has(l));

      expect(
        ganharam,
        "A atualização REABRIU permissão que o clone já tinha fechado: até o revoke do apêndice chegar, " +
          "estas funções ficam alcançáveis por papel de cliente. Tire o GRANT do corpo do dump.\n",
      ).toEqual([]);
    },
    300_000,
  );
});
