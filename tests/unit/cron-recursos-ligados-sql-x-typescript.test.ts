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

describe("a sonda do follow-up casa com o claim que ela substitui", () => {
  it("os dois filtram (ou não) o status da organização juntos", () => {
    // A falha SILENCIOSA da peça inteira mora aqui: sonda mais ESTREITA que o
    // claim para de reclamar inscrição vencida sem dizer nada (a rota devolve
    // 200). Mais LARGA é inofensiva — só paga a consulta que já se pagava.
    // Hoje o claim de `fn_claim_due_followup_enrollments` exige organização
    // operante (0501), e a sonda acompanha. Se um dos dois mudar sozinho, este
    // caso acusa antes de a produção parar.
    const inicio = baseline.lastIndexOf("create or replace function fn_claim_due_followup_enrollments");
    expect(inicio).toBeGreaterThan(0);
    const claim = baseline.slice(inicio, baseline.indexOf("$$;", inicio));
    const sonda = migration.slice(migration.indexOf("'followup', exists"), migration.indexOf("'followup_silencio'"));

    const claimFiltraOrg = /organizations/.test(claim);
    const sondaFiltraOrg = /organizations/.test(sonda);
    expect(sondaFiltraOrg, "sonda e claim discordam sobre a organização operante").toBe(claimFiltraOrg);

    // E a parte que os dois têm em comum: status vivo, vencido e sem lease.
    // Comparados sem espaço: o claim escreve a lista colada (`'active','waiting_reply'`)
    // e a sonda escreve com espaço — a régua é o CONJUNTO, não a diagramação.
    const semEspaco = (texto: string) => texto.replace(/\s+/g, "");
    for (const condicao of ["'active','waiting_reply','dormente'", "next_eval_at<=now()", "claimed_until"]) {
      expect(semEspaco(claim)).toContain(condicao);
      expect(semEspaco(sonda)).toContain(condicao);
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
