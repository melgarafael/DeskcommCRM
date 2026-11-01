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
 *   1. o CHECK da coluna, como o banco o instala (a ÚLTIMA definição EM
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
 *
 * ─── A âncora é a TABELA, não o arquivo (#3826) ────────────────────────────
 *
 * A primeira versão procurava a ÚLTIMA grafia do CHECK no `baseline.sql`
 * INTEIRO (`lastIndexOf("check (outcome in (")`). Passou a ler o CHECK de OUTRA
 * tabela no minuto em que um apêndice no fim do arquivo declarou uma coluna
 * `outcome` com lista por `in` (#3823, `ai_router_decisions`), e reprovou um PR
 * que não mexe na captação. Definição de coluna de outra tabela nunca disse
 * nada sobre esta, então toda busca daqui tem âncora: o bloco `create table …
 * public.webhook_lead_captures (` para a forma inline e o `alter table
 * public.webhook_lead_captures … add constraint
 * webhook_lead_captures_outcome_check` para a forma explícita.
 *
 * Entre as duas quem decide continua sendo a POSIÇÃO no arquivo (a última
 * vence), porque o baseline é aplicado inteiro, em ordem.
 *
 * O `describe` do fim prova que a âncora segura: ele lê baselines SINTÉTICOS
 * num temporário — o que OUTRA tabela escreva sobre `outcome`, em qualquer das
 * duas grafias, e o que a prosa dos apêndices CITE, não muda o que a cerca lê.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DESFECHOS_DA_CAPTACAO } from "@/lib/schemas/lead-captures";

const RAIZ = join(__dirname, "..", "..");

/** O `create table` desta tabela, em qualquer grafia de `create table`. */
const CRIA_A_TABELA =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.webhook_lead_captures\s*\(/gi;

/** O `add constraint` nomeado, preso ao `alter table` DESTA tabela. */
const ADICIONA_A_CONSTRAINT =
  /alter\s+table\s+(?:if\s+exists\s+)?public\.webhook_lead_captures\s+add\s+constraint\s+webhook_lead_captures_outcome_check/gi;

/**
 * O baseline sem as linhas de COMENTÁRIO (`-- …`).
 *
 * O arquivo é dump + apêndice, e os apêndices vêm com manifest em prosa que CITA
 * SQL — inclusive nome de constraint e lista de valores. Citação em prosa não é
 * definição, e uma delas no fim do arquivo voltaria a mentir sobre o vocabulário
 * vigente. Corta só a linha que COMEÇA com `--` (nunca um `--` no meio da
 * linha, que pode estar dentro de um literal).
 */
function semProsa(sql: string): string {
  return sql.replace(/^[ \t]*--.*$/gm, "");
}

/** O índice da ÚLTIMA ocorrência de `padrao` em `texto` (-1 se não houver). */
function ultimoIndice(texto: string, padrao: RegExp): number {
  let achado = -1;
  for (const m of texto.matchAll(padrao)) achado = m.index ?? achado;
  return achado;
}

/**
 * A ÚLTIMA definição do CHECK de `webhook_lead_captures.outcome`, ancorada na
 * TABELA.
 *
 * Duas formas escrevem o mesmo CHECK (a tabela nasce com ele inline no dump;
 * migration posterior troca por `alter table … add constraint`), então o que
 * decide é a que aparece DEPOIS no arquivo — e ele é aplicado inteiro, em
 * ordem. Ancorar na primeira responderia sobre uma definição que o banco desfaz
 * (doutrina 10); ancorar no ARQUIVO inteiro responde sobre outra tabela (é o
 * defeito do #3826).
 *
 * @param caminho baseline a ler — os casos com baseline sintético passam o seu
 */
function valoresDoCheck(caminho = join(RAIZ, "supabase", "baseline.sql")): string[] {
  const baseline = semProsa(readFileSync(caminho, "utf8"));

  // FORMA INLINE: o `check (outcome in (…))` DENTRO do bloco que cria esta
  // tabela. O mesmo texto FORA dele é de outra tabela e não vale.
  const tabela = ultimoIndice(baseline, CRIA_A_TABELA);
  let inline = -1;
  if (tabela !== -1) {
    const fecha = baseline.indexOf("\n);", tabela);
    const corpo = baseline.slice(tabela, fecha === -1 ? undefined : fecha);
    const noCorpo = corpo.lastIndexOf("check (outcome in (");
    if (noCorpo !== -1) inline = tabela + noCorpo;
  }

  // FORMA EXPLÍCITA: a constraint nomeada, presa ao `alter table` desta tabela.
  const constraint = ultimoIndice(baseline, ADICIONA_A_CONSTRAINT);

  const inicio = Math.max(inline, constraint);
  expect(
    inicio,
    "o baseline não define o CHECK de webhook_lead_captures.outcome",
  ).toBeGreaterThan(-1);
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

/**
 * A âncora da leitura (#3826), medida em baseline SINTÉTICO.
 *
 * Estes casos não dependem do `baseline.sql` de verdade nem de PR futuro: um
 * arquivo temporário com esta tabela e um apêndice é tudo o que a leitura vê.
 * Se a cerca voltar a cegar, o defeito aparece aqui primeiro e aponta para a
 * âncora, não para a captação.
 */
describe("a cerca lê a tabela certa, aconteça o que acontecer no fim do arquivo (#3826)", () => {
  const pasta = mkdtempSync(join(tmpdir(), "cerca-do-desfecho-"));

  afterAll(() => {
    rmSync(pasta, { recursive: true, force: true });
  });

  /** O bloco desta tabela, com o CHECK inline que o dump instala. */
  const TABELA_DA_CAPTACAO = `create table if not exists public.webhook_lead_captures (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  outcome text not null
    check (outcome in ('criado', 'duplicado', 'recusado')),
  reject_reason text
);
`;

  /** O apêndice que troca o CHECK pela constraint nomeada, já com `atualizado`. */
  const APENDICE_DA_CONSTRAINT = `do $$
begin
  alter table public.webhook_lead_captures
    drop constraint if exists webhook_lead_captures_outcome_check;
  alter table public.webhook_lead_captures
    add constraint webhook_lead_captures_outcome_check
    check (outcome = any (array['criado'::text, 'duplicado'::text, 'recusado'::text,
                                'atualizado'::text]));
end $$;
`;

  let n = 0;
  /** Grava um baseline temporário e devolve o que a cerca leu dele. */
  function ler(...pedacos: string[]): string[] {
    const arquivo = join(pasta, `baseline-${++n}.sql`);
    writeFileSync(arquivo, pedacos.join("\n"));
    return valoresDoCheck(arquivo);
  }

  /** O que a cerca lê quando o arquivo termina nesta tabela e no seu apêndice. */
  const ESPERADO = ["criado", "duplicado", "recusado", "atualizado"];

  it("controle: a fixture sintética tem as duas formas, e a última vence", () => {
    expect(ler(TABELA_DA_CAPTACAO, APENDICE_DA_CONSTRAINT)).toEqual(ESPERADO);
  });

  it("só a forma inline (dump recém-criado) é lida do bloco desta tabela", () => {
    // Sem esta, a âncora da forma inline nunca é exercitada: a constraint
    // nomeada venceria sempre, e um bloco procurado no lugar errado passaria.
    expect(ler(TABELA_DA_CAPTACAO)).toEqual(["criado", "duplicado", "recusado"]);
  });

  it("CHECK de `outcome` de OUTRA tabela, no fim do arquivo, não muda a leitura", () => {
    const outraTabela = `create table if not exists public.ai_router_decisions (
  id uuid primary key default gen_random_uuid(),
  outcome text not null
    check (outcome in ('classified', 'sticky', 'fallback', 'no_match'))
);
`;
    const lido = ler(TABELA_DA_CAPTACAO, APENDICE_DA_CONSTRAINT, outraTabela);
    expect(lido, "a cerca leu o CHECK de outra tabela — a âncora escorregou").toEqual(
      ESPERADO,
    );
    expect(lido).not.toContain("classified");
  });

  it("CHECK de `outcome` de outra tabela em `= any (array[…])` também não muda", () => {
    const outraTabela = `create table if not exists public.followup_runs (
  id uuid primary key default gen_random_uuid(),
  outcome text not null
    check (outcome = any (array['enviado'::text, 'pulado'::text]))
);
`;
    expect(ler(TABELA_DA_CAPTACAO, APENDICE_DA_CONSTRAINT, outraTabela)).toEqual(ESPERADO);
  });

  it("prosa de apêndice que CITA a constraint antiga não muda a leitura", () => {
    // O manifest dos apêndices cita SQL o tempo todo; uma citação que grafasse
    // a lista antiga (`criado`/`duplicado`, sem `atualizado`) no fim do arquivo
    // seria lida como definição vigente.
    const prosa = `-- antes desta migration o CHECK era
--     alter table public.webhook_lead_captures
--       add constraint webhook_lead_captures_outcome_check
--       check (outcome in ('criado', 'duplicado')),
-- e o card atualizado caía na ponte do 23514.
`;
    const lido = ler(TABELA_DA_CAPTACAO, APENDICE_DA_CONSTRAINT, prosa);
    expect(lido, "a cerca leu um COMENTÁRIO como se fosse definição").toEqual(ESPERADO);
    expect(lido).toContain("atualizado");
  });
});
