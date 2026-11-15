/**
 * QUEM SEMEIA NEGÓCIO NO E2E NÃO ESCOLHE A ETAPA POR ÍNDICE DO EMBED.
 *
 * ═══ O defeito medido ═══════════════════════════════════════════════════════
 *
 * `e2e-parte (3)` reprovou com a suíte quase inteira verde (82 passed):
 *
 *     ✘ 42 inbox-quem-manda.spec.ts:221 › o automático atende, a pessoa
 *          assume, o automático PARA, e a volta existe (0ms)
 *
 *        Error: crm_leads: lost_reason_required
 *           > 218 |     if (erroLead) throw new Error(`crm_leads: ${erroLead.message}`);
 *
 * O `beforeAll` morria SEMEAR DO um negócio, antes de o corpo do teste rodar
 * (daí os 0ms e o "1 did not run" do teste seguinte). A semeadura pegava a
 * etapa assim:
 *
 *     .select("id, crm_stages(id)")   // lista NÃO ordenada
 *     …
 *     const etapaId = funil.crm_stages?.[0]?.id;
 *
 * `crm_stages` é lista: sem ORDER BY, a primeira linha é a que o plano de
 * consulta entregar. Nessa corrida ela foi a etapa de PERDA (`is_lost`), e aí
 * dois gatilhos do baseline fizeram o resto, em silêncio:
 *
 *   - `trg_crm_lead_close_on_stage` (baseline.sql, `fn_crm_lead_close_on_stage`)
 *     grava `status='lost'` no INSERT quando a etapa de destino é de perda —
 *     é o único escritor de `crm_leads.status`;
 *   - `trg_validate_lost_reason_required` (`fn_validate_lost_reason_required`)
 *     levanta `22023 lost_reason_required` porque um negócio perdido sem
 *     motivo não existe.
 *
 * O erro chegava ao spec como `crm_leads: lost_reason_required`, apontando
 * para a semeadura — nada a ver com o comando da conversa, que é o que a spec
 * mede. E o mesmo commit passou noutra corrida: mesma base, ordem diferente.
 *
 * ═══ A régua ════════════════════════════════════════════════════════════════
 *
 * A regra de "onde o negócio nasce" já existe no produto e é única:
 * `funilDeEntrada` (`lib/leads/nascimento-do-lead.ts`) — funil padrão da
 * organização e etapa de MENOR `position` entre as não arquivadas, não ganhas
 * e não perdidas. Quem semeia negócio no e2e chama essa função em vez de
 * reimplementar a escolha; a spec do inbox é o caso que motivou esta guarda.
 *
 * A guarda cobra duas coisas:
 *
 *   1. nenhum arquivo de `tests/e2e/` nem de `scripts/` indexa `crm_stages`
 *      (`crm_stages[0]`, `funil.crm_stages?.[0]`) — o índice sobre uma lista
 *      sem ORDER BY é o defeito, não o caso;
 *   2. a spec do inbox semeia pela regra do produto (`funilDeEntrada`), e não
 *      por uma consulta própria.
 *
 * ═══ O que esta guarda NÃO pega — dito para a omissão não anestesiar ═════════
 *
 * Ela lê a ÁRVORE do arquivo, não o comportamento: um seed que pegue a etapa
 * com `find(...)` sobre o embed, com índice calculado (`etapas[idx]`) ou por
 * uma consulta própria sem `is_lost` continua passando por aqui. O que ela
 * impede é a reincidência silenciosa da forma que reprovou o CI — quem
 * escrever a próxima semeadura esbarra na regra e lê o porquê.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/** Onde mora quem semeia dado de e2e. */
const DIRETORIOS = ["tests/e2e", "scripts"];

/** A spec que reprovou o `e2e-parte (3)` e o módulo que ela passou a usar. */
const SPEC = "tests/e2e/inbox-quem-manda.spec.ts";
const MODULO_DA_REGRA = "lib/leads/nascimento-do-lead";

function arquivosTypeScript(relativo: string): string[] {
  const absoluto = path.join(RAIZ, relativo);
  const achados: string[] = [];
  for (const entrada of readdirSync(absoluto, { withFileTypes: true })) {
    const rel = path.join(relativo, entrada.name);
    if (entrada.isDirectory()) {
      achados.push(...arquivosTypeScript(rel));
      continue;
    }
    if (/\.tsx?$/.test(entrada.name)) achados.push(rel);
  }
  return achados;
}

/**
 * Linhas em que o arquivo indexa `crm_stages` por número.
 *
 * A árvore do TypeScript, e não regex: a primeira versão desta guarda casava o
 * próprio comentário que explica o defeito (`crm_stages[0]` dentro de uma
 * frase) e acusava a spec já consertada. Comentário e string não são nó de
 * acesso a elemento, então não entram.
 */
function linhasQueIndexamCrmStages(fonte: string, nome: string): number[] {
  const arquivo = ts.createSourceFile(nome, fonte, ts.ScriptTarget.Latest, true);
  const linhas: number[] = [];

  const visitar = (no: ts.Node): void => {
    if (ts.isElementAccessExpression(no)) {
      // `crm_stages[0]`, `funil.crm_stages?.[0]`, `(x as T)?.crm_stages[0]`:
      // o que importa é o NOME do alvo terminar em `crm_stages`.
      const alvo = no.expression.getText(arquivo);
      const indice = no.argumentExpression;
      if (/crm_stages$/.test(alvo) && indice && ts.isNumericLiteral(indice)) {
        linhas.push(arquivo.getLineAndCharacterOfPosition(no.getStart(arquivo)).line + 1);
      }
    }
    ts.forEachChild(no, visitar);
  };

  visitar(arquivo);
  return linhas;
}

describe("semeadura de negócio no e2e", () => {
  it("nenhum arquivo de tests/e2e nem de scripts pega a etapa por índice do embed", () => {
    const ofensores = DIRETORIOS.flatMap((dir) => arquivosTypeScript(dir))
      .map((rel) => ({ rel, linhas: linhasQueIndexamCrmStages(readFileSync(path.join(RAIZ, rel), "utf8"), rel) }))
      .filter(({ linhas }) => linhas.length > 0)
      .map(({ rel, linhas }) => `${rel}:${linhas.join(",")}`);

    expect(ofensores).toEqual([]);
  });

  it("a spec do inbox semeia o negócio pela regra do produto, não por consulta própria", () => {
    const fonte = readFileSync(path.join(RAIZ, SPEC), "utf8");

    // Importar sem chamar não conta: a semeadura tem de passar pela função.
    expect(fonte).toContain(`import { funilDeEntrada } from "../../${MODULO_DA_REGRA}";`);
    expect(fonte).toContain("await funilDeEntrada(admin, creds.org_id)");

    // E não pode reimplementar a escolha: consulta própria a `crm_stages` here.
    expect(fonte).not.toMatch(/\.from\("crm_stages"\)/);
  });
});
