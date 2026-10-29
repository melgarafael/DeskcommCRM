/**
 * O VOCABULÁRIO E OS DOIS ARTEFATOS DA LEITURA COMPARTILHADA (#3694).
 *
 * Duas classes de defeito que ninguém veria até a produção:
 *
 *   1. a função do banco e o TypeScript divergirem num nome — `recursoLigado(db,
 *      "campanhas")` lendo uma chave que a função não devolve responde
 *      `undefined`, que aqui vira LIGADO (lado seguro), então o gate
 *      simplesmente não economizaria nada e ninguém saberia o porquê;
 *   2. a migration e o apêndice do `baseline.sql` divergirem — o kit self-host
 *      aplica SÓ o baseline, e é o apêndice que chega ao cliente. Sem esta
 *      comparação, a correção valeria no Supabase CLI e não na VPS.
 *
 * Mesmo desenho do par `vocabulario-banco-x-typescript.test.ts`: a régua é o
 * TEXTO do último artefato que vale, não a memória de quem escreveu.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RECURSOS_DO_CRON } from "@/lib/cron/recursos-ligados";

const RAIZ = join(__dirname, "..", "..");
const MIGRATION = "supabase/migrations/20261029140000_9044_recursos_ligados_do_cron.sql";
const ASSINATURA = "create or replace function public.fn_cron_recursos_ligados()";

const migration = readFileSync(join(RAIZ, MIGRATION), "utf8");
const baseline = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");

/** O corpo da função (do `create or replace` até o `$$;`), normalizado. */
function corpo(texto: string): string {
  const inicio = texto.indexOf(ASSINATURA);
  expect(inicio).toBeGreaterThanOrEqual(0);
  const fim = texto.indexOf("$$;", inicio);
  expect(fim).toBeGreaterThan(inicio);
  return texto
    .slice(inicio, fim + 3)
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("fn_cron_recursos_ligados: banco e TypeScript com o mesmo vocabulário", () => {
  it("cada recurso do TypeScript existe como chave da função", () => {
    for (const recurso of RECURSOS_DO_CRON) {
      expect(migration, `chave '${recurso}' ausente na migration`).toContain(`'${recurso}', exists`);
    }
  });

  it("a função não devolve chave que o TypeScript não conhece", () => {
    const chaves = [...migration.matchAll(/^ {4}'([a-z_]+)', exists/mg)].map((m) => m[1]!);
    expect(chaves.slice().sort()).toEqual([...RECURSOS_DO_CRON].sort());
  });

  it("a função nasce fechada: EXECUTE revogado de public/anon/authenticated, concedido ao service_role", () => {
    for (const artefato of [migration, baseline]) {
      expect(artefato).toContain(
        "revoke execute on function public.fn_cron_recursos_ligados() from public, anon, authenticated;",
      );
      expect(artefato).toContain("grant execute on function public.fn_cron_recursos_ligados() to service_role;");
    }
  });
});

describe("migration x baseline.sql: o kit self-host recebe a MESMA função", () => {
  it("o apêndice do baseline traz o corpo idêntico ao da migration", () => {
    const noBaseline = baseline.lastIndexOf(ASSINATURA);
    expect(noBaseline, "a função não está no apêndice do baseline.sql").toBeGreaterThan(0);
    // O que vale no baseline é a ÚLTIMA definição: o arquivo é aplicado inteiro.
    expect(corpo(baseline.slice(noBaseline))).toBe(corpo(migration));
  });

  it("a migration declara o próprio manifesto (o MANIFEST.md é histórico e não recebe linha)", () => {
    expect(migration.split("\n")[0]).toMatch(/^-- manifest: .+#3694/);
  });
});
