/**
 * O DESFECHO DA CAPTAÇÃO TEM UM VOCABULÁRIO SÓ — banco, módulo e tela.
 *
 * ─── A classe de defeito, medida no #2316 ──────────────────────────────────
 *
 * O desfecho `atualizado` nasceu no TypeScript e não no banco: o CHECK de
 * `webhook_lead_captures.outcome` (migration 0174) só aceitava
 * `criado`/`duplicado`/`recusado`, `registrarCaptacao` promete NUNCA LANÇAR, e
 * o resultado foi uma PONTE — um `23514` regravava a linha como `duplicado`
 * para ela não sumir da tela "Leads recebidos", e a tela mostrava um desfecho
 * que não era o que aconteceu. Nada acusava enquanto o PR não passava por um
 * banco de verdade.
 *
 * Três listas do MESMO fato não podem divergir, e é isso que esta cerca cobra:
 *
 *   1. o CHECK da coluna, como o banco o instala (a ÚLTIMA definição em
 *      `supabase/baseline.sql` — o arquivo é dump + apêndice, e quem vale é o
 *      último, doutrina 10 do CLAUDE.md);
 *   2. `DESFECHOS_DA_CAPTACAO` (`lib/schemas/lead-captures.ts`), que valida o
 *      filtro da tela e é o que o `GET /lead-captures` aceita;
 *   3. o tipo `DesfechoDaCaptacao` (`lib/webhooks/captacao.ts`), que é o que a
 *      rota grava.
 *
 * A divergência que reaparecer aqui é a mesma do #2316 pela porta dos fundos:
 * um valor que a rota grava e o banco recusa. É por isso que a cerca existe, e
 * não porque texto em markdown compila.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DESFECHOS_DA_CAPTACAO } from "@/lib/schemas/lead-captures";

const RAIZ = join(__dirname, "..", "..");

/**
 * A ÚLTIMA definição do CHECK de `outcome` no baseline.
 *
 * Duas formas escrevem o mesmo CHECK (a tabela nasce com ele inline no dump;
 * migration posterior troca por `alter table … add constraint`), então o que
 * decide é a que aparece DEPOIS no arquivo — e ele é aplicado inteiro, em
 * ordem. Ancorar na primeira responderia sobre uma definição que o banco
 * desfaz (doutrina 10).
 */
function valoresDoCheck(): string[] {
  const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
  // O CHECK inline é procurado DENTRO do `create table` desta tabela: o
  // `lastIndexOf` no arquivo inteiro pegava o CHECK de outra tabela que também
  // chama a coluna de `outcome` assim que um apêndice novo a declarava depois
  // (#3823, `ai_router_decisions`), e a cerca reprovava um PR que não mexe na captação.
  const tabela = baseline.lastIndexOf("create table if not exists public.webhook_lead_captures (");
  const corpo = tabela === -1 ? "" : baseline.slice(tabela, baseline.indexOf("\n);", tabela));
  const noCorpo = corpo.indexOf("check (outcome in (");
  const inline = noCorpo === -1 ? -1 : tabela + noCorpo;
  const constraint = baseline.lastIndexOf(
    "add constraint webhook_lead_captures_outcome_check",
  );
  const inicio = Math.max(inline, constraint);
  expect(inicio, "o baseline não define o CHECK de webhook_lead_captures.outcome").toBeGreaterThan(
    -1,
  );
  // O primeiro `)` fecha a lista (inline) ou o `any(...)` (array) — nos dois
  // casos, os valores estão antes dele.
  const trecho = baseline.slice(inicio, inicio + 400);
  const fim = trecho.indexOf(")");
  return [...trecho.slice(0, fim).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

describe("o vocabulário do desfecho é um só (#2316, migration 0683)", () => {
  it("controle: a cerca achou os dois lados", () => {
    expect(DESFECHOS_DA_CAPTACAO.length).toBeGreaterThanOrEqual(3);
    expect(valoresDoCheck().length).toBeGreaterThanOrEqual(3);
  });

  it("⭐ o banco aceita TODOS os desfechos que a rota pode gravar", () => {
    const doBanco = new Set(valoresDoCheck());
    const faltando = DESFECHOS_DA_CAPTACAO.filter((d) => !doBanco.has(d));
    expect(
      faltando,
      `o CHECK da coluna não conhece ${faltando.join(", ")} — a rota grava um valor que o banco recusa`,
    ).toEqual([]);
  });

  it("⭐ e a tela não conhece desfecho que o banco não tem", () => {
    const daTela = new Set<string>(DESFECHOS_DA_CAPTACAO);
    const sobrando = valoresDoCheck().filter((d) => !daTela.has(d));
    expect(
      sobrando,
      `o CHECK aceita ${sobrando.join(", ")}, que a tela não sabe mostrar`,
    ).toEqual([]);
  });

  it("`atualizado` está nos dois lados — foi a migration que tirou a ponte de cena", () => {
    // Se este caso ficar vermelho, o desfecho do card atualizado voltou a ser
    // registrado com outro nome, e a tela volta a mentir sobre o que aconteceu.
    expect(valoresDoCheck()).toContain("atualizado");
    expect(DESFECHOS_DA_CAPTACAO).toContain("atualizado");
  });

  it("não há ponte de CHECK de volta em `registrarCaptacao`", () => {
    const fonte = readFileSync(join(RAIZ, "lib", "webhooks", "captacao.ts"), "utf8");
    expect(
      fonte.includes("23514"),
      "a ponte do CHECK voltou ao módulo: o banco e o vocabulário divergiram de novo",
    ).toBe(false);
  });
});
