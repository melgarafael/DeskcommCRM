/**
 * `ai_invocations` NÃO TEM MAIS ESCRITOR — LOGO, NÃO PODE TER LEITOR DE CONSUMO.
 *
 * A migration 0130 unificou a telemetria de IA em `llm_calls` e deixou
 * `ai_invocations` como histórico. `lib/ai/log-invocation.ts` passou a gravar
 * na tabela nova; nada escreve mais na antiga.
 *
 * O PR que fez isso migrou a tela do tenant (`/api/v1/ai/usage`) e esqueceu as
 * DUAS do painel de plataforma. Elas continuaram somando `ai_invocations` — que
 * a partir da migração só encolhe. O número congela e, passada a janela de 30
 * dias, vira ZERO consumo para todo tenant com o dinheiro saindo. É palavra por
 * palavra o sintoma que a 0130 existe para matar ("a tela mostrava ZERO custo
 * enquanto o dinheiro saía"), reintroduzido na tela do outro lado.
 *
 * ## Por que um gate de classe, e não um caso por rota
 *
 * O guard que existia (`usage-nao-conta-em-dobro.test.ts`) olha DUAS rotas
 * nomeadas. Um leitor novo — ou uma rota que já existia e ninguém lembrou —
 * passa por ele sem encostar. Aqui a varredura é do repositório inteiro, com
 * allowlist explícita: quem tiver razão para ler a tabela histórica escreve a
 * razão nesta lista, e a lista é a documentação de quem sobrou.
 *
 * Isto continua sendo uma sonda TEXTUAL, e uma paráfrase (`.from(TABELA)` com a
 * tabela numa constante) a driblaria. É o teto do que dá para medir sem banco;
 * o que não dá para deixar acontecer de novo é a classe inteira passar
 * despercebida.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * Quem PODE mencionar `ai_invocations`, e por quê. Uma entrada aqui é uma
 * decisão consciente — não um "deixa passar".
 */
const PERMITIDOS: Record<string, string> = {
  "lib/database.types.ts": "tipos gerados do schema; a tabela ainda existe como histórico",
  "lib/ai/log-invocation.ts": "o docblock explica a migração de tabela; o insert é em llm_calls",
  "lib/ai/usage/aggregate.ts": "o comentário descreve a origem histórica do shape agregado",
  "app/api/v1/ai/usage/route.ts": "o comentário registra POR QUE a rota parou de somar as duas",
  "scripts/qa-wave-10.ts": "script de QA histórico, fora do caminho de produção",
};

/** `.from("ai_invocations")` — a forma que efetivamente consulta a tabela. */
const CONSULTA = /\.from\(\s*["'`]ai_invocations["'`]\s*\)/;

describe("telemetria de IA tem uma tabela só", () => {
  const arquivos = arquivosDeCodigo([
    "app",
    "lib",
    "workers",
    "components",
    "hooks",
    "scripts",
  ]).map((absoluto) => ({
    caminho: caminhoRelativo(absoluto),
    conteudo: readFileSync(absoluto, "utf8"),
  }));

  it("a varredura enxerga o código (controle positivo)", () => {
    // Sem isto, um glob que devolvesse zero arquivos faria o teste abaixo
    // passar para sempre — verde por não medir nada.
    expect(arquivos.length).toBeGreaterThan(200);
    expect(arquivos.some((a) => a.caminho === "lib/ai/log-invocation.ts")).toBe(true);
  });

  it("ninguém consulta ai_invocations fora da allowlist", () => {
    const infratores = arquivos
      .filter((a) => CONSULTA.test(a.conteudo))
      .map((a) => a.caminho)
      .filter((caminho) => !(caminho in PERMITIDOS));

    expect(
      infratores,
      "Estes arquivos consultam `ai_invocations`, que desde a migration 0130 não tem NENHUM escritor:\n" +
        `${infratores.join("\n")}\n\n` +
        "O número lido dali congela e vira zero conforme a janela anda — com o dinheiro saindo.\n" +
        "Use `llm_calls` (colunas input_tokens/output_tokens/cost_cents/purpose), ou acrescente o\n" +
        "arquivo à allowlist deste teste COM a razão escrita.",
    ).toEqual([]);
  });

  it("a allowlist não guarda entrada morta", () => {
    // Allowlist que sobrevive ao arquivo que ela liberava vira permissão
    // fantasma: o próximo leitor lê a lista e conclui que a exceção é regra.
    const inexistentes = Object.keys(PERMITIDOS).filter(
      (caminho) => !arquivos.some((a) => a.caminho === caminho),
    );
    expect(
      inexistentes,
      `entradas da allowlist apontando para arquivo que não existe mais`,
    ).toEqual([]);
  });

  it("log-invocation grava em llm_calls, não na tabela depreciada", () => {
    const fonte = readFileSync(join(process.cwd(), "lib", "ai", "log-invocation.ts"), "utf8");
    expect(fonte).toContain('.from("llm_calls")');
    expect(CONSULTA.test(fonte)).toBe(false);
  });
});
