import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * NENHUM escritor de produção define `performed_at` — o banco carimba.
 *
 * POR QUE ISTO É UM INVARIANTE E NÃO UMA PREFERÊNCIA: a linha do tempo ordena
 * por `performed_at`. Se uns eventos vierem do relógio do PROCESSO e outros do
 * relógio do BANCO, a ordem pode inverter. Medido nesta máquina durante a wave
 * 7: **o banco está 2 segundos à frente**, e uma `note` criada DEPOIS apareceu
 * ANTES do `lead_cooled`.
 *
 * Os três motivos que fazem valer a guarda:
 *
 *  1. a inversão é INVISÍVEL quando acontece — linha do tempo invertida parece
 *     linha do tempo plausível, e ninguém desconfia de uma ordem;
 *  2. ela atinge exatamente o CASO INTERESSANTE: ação humana seguida da reação
 *     do sistema acontece com segundos de distância, que é a escala da deriva;
 *  3. o mesmo par de relógios já derrubou o worker inteiro por outra porta (o
 *     `since > detected_at` da 0081). A classe é conhecida e reincidente.
 *
 * ⚠️ VARREDURA VAZIA ESTOURA. Se o `grep` não achar escritor nenhum — o caminho
 * mudou de pasta, o insert virou RPC, o nome da tabela mudou — a lista vem vazia
 * e o teste passaria POR VACUIDADE, dizendo "ninguém escreve performed_at"
 * quando o que houve foi ele deixar de procurar. Zero escritores encontrados é
 * ERRO DO INSTRUMENTO: `crm_lead_activities` tem escritores, isso é fato do
 * sistema, não hipótese.
 */

const RAIZ = path.resolve(__dirname, "../..");

/** Onde mora código de produção. Sondas e testes ficam de fora de propósito:
 *  elas PODEM forjar instantes — é assim que se testa um relógio. */
const PASTAS = ["lib", "app", "hooks", "components"];

/**
 * Os caminhos por onde uma atividade nasce.
 *
 * ⚠️ NÃO BASTA PROCURAR O NOME DA TABELA, e a sabotagem provou: pus
 * `performed_at: new Date()` no `risk-worker.ts` e o teste passou VERDE, porque
 * aquele arquivo nunca escreve `crm_lead_activities` — ele chama
 * `emitLeadActivity`. A varredura por nome de tabela perde exatamente os
 * escritores CANÔNICOS, que são a maioria e os que mais importam.
 */
const MARCAS = ["crm_lead_activities", "emitLeadActivity", "buildLeadActivityRow"];

function arquivosQueEscrevemAtividade(): string[] {
  const achados = new Set<string>();
  for (const marca of MARCAS) {
    let saida = "";
    try {
      saida = execFileSync(
        "grep",
        ["-rl", "--include=*.ts", "--include=*.tsx", "--exclude=*.test.ts", "--exclude=*.test.tsx", marca, ...PASTAS],
        { cwd: RAIZ, encoding: "utf8" },
      );
    } catch {
      // `grep` sai com 1 quando não acha nada, e o `execFileSync` LANÇA. Sem
      // este catch, a sabotagem da varredura vazia derrubava o arquivo inteiro
      // com "Command failed" e nem chegava na guarda — o teste não passava por
      // vacuidade, ele simplesmente NÃO RODAVA, que é igualmente cego.
      saida = "";
    }
    for (const a of saida.split("\n").filter(Boolean)) achados.add(a);
  }
  return [...achados].sort();
}

describe("performed_at vem de UM relógio só (o do banco)", () => {
  const arquivos = arquivosQueEscrevemAtividade();

  it("a varredura achou escritores — lista vazia é falha do instrumento", () => {
    // Sem esta guarda, mudar `crm_lead_activities` de lugar faria o invariante
    // passar dizendo que ninguém escreve `performed_at`. Ele passaria para
    // sempre, e em silêncio.
    expect(
      arquivos.length,
      `a varredura por ${MARCAS.join(" / ")} não achou arquivo nenhum em ` +
        `${PASTAS.join(", ")}. Isso é ERRO DO INSTRUMENTO — a tabela tem ` +
        "escritores. Ensine a varredura antes de confiar neste teste.",
    ).toBeGreaterThan(0);
  });

  it("nenhum deles define performed_at na escrita", () => {
    const infratores: string[] = [];
    for (const rel of arquivos) {
      const fonte = readFileSync(path.join(RAIZ, rel), "utf8");
      // O ALVO É ATRIBUIR UM INSTANTE DO CLIENTE — não mencionar a coluna.
      //
      // A primeira versão acusava qualquer `performed_at:` e produziu três
      // falsos positivos, todos LEITURA: `encodeCursor({ performed_at: ... })`
      // em duas rotas de timeline e um `select ... performed_at::text` no
      // contexto do agente. Invariante com falso positivo é pior que invariante
      // nenhum de um jeito específico: ele é DESLIGADO, e leva junto a
      // verificação que funcionava.
      //
      // LIMITAÇÃO DECLARADA: `performed_at: algumaVariavel` escapa, porque não
      // dá para saber de onde a variável veio sem AST. A escolha é deliberada —
      // o padrão real do defeito é o literal (`new Date().toISOString()`), e
      // ampliar a mira para pegar o caso opaco traria de volta os falsos
      // positivos que fazem o teste ser ignorado.
      const RELOGIO_DO_CLIENTE = /new Date\(|Date\.now\(|toISOString\(|dayjs\(|DateTime\./;
      for (const linha of fonte.split("\n")) {
        const semComentario = linha.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (!/\bperformed_at\s*:/.test(semComentario)) continue;
        if (!RELOGIO_DO_CLIENTE.test(semComentario)) continue;
        infratores.push(`${rel}: ${linha.trim()}`);
      }
    }
    expect(
      infratores,
      "estes escrevem `performed_at` do lado do CLIENTE. A linha do tempo ordena " +
        "por essa coluna, e o relógio do processo diverge do banco (medido: 2s) — " +
        "eventos próximos saem FORA DE ORDEM, e ordem errada parece ordem certa. " +
        "Omita a coluna: o default `now()` do banco é o relógio de todos os " +
        `outros escritores.\n  ${infratores.join("\n  ")}`,
    ).toEqual([]);
  });
});
