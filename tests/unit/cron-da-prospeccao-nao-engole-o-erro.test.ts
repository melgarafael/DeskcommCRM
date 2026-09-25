import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * UM CRON QUE FALHA EM SILÊNCIO PARA A INSTALAÇÃO INTEIRA.
 *
 * ## O defeito (issue #1311)
 *
 * A rota de cron da prospecção tinha `catch` **sem parâmetro**:
 *
 * ```ts
 * } catch {
 *   return fail("internal_error", "Falha ao processar a prospecção.", 500, { requestId });
 * }
 * ```
 *
 * O objeto do erro não era só deixado de fora do log — ele era **descartado**,
 * não existia em variável nenhuma. E cron roda sozinho: se `tickProspecting`
 * quebrasse, toda organização da instalação parava de prospectar e a única
 * evidência era um 500 numa resposta que ninguém lê.
 *
 * ## O segundo defeito, que a issue não citava
 *
 * O worker JÁ tinha `logger.error("[prospecting] rodada falhou", ...)` — e
 * gravava `error: "prospecting_tick_failed"`, uma **constante**. O erro estava
 * capturado na variável e descartado na hora de escrever.
 *
 * Isso é pior que não logar, e a razão importa: um log que existe e não diz nada
 * PARECE cobertura. Quem audita o arquivo vê `logger.error` e segue em frente;
 * quem investiga um incidente encontra a linha e continua sem saber a causa.
 *
 * ## Por que teste de estrutura
 *
 * O que se quer travar é "o erro chega ao log". Montar um duplo que force
 * `tickProspecting` a lançar mediria o duplo; o que fixa o defeito é a forma do
 * `catch` e o que vai no campo, e é isso que este arquivo lê.
 */

const RAIZ = path.resolve(__dirname, "../..");
const ROTA = path.join(RAIZ, "app/api/v1/cron/prospecting/route.ts");
const WORKER = path.join(RAIZ, "lib/prospecting/worker.ts");

describe("a rota do cron", () => {
  const fonte = fs.readFileSync(ROTA, "utf8");

  it("não tem `catch` sem parâmetro", () => {
    // A forma exata do defeito. `catch {` descarta o erro no nível da sintaxe.
    expect(
      /\}\s*catch\s*\{/.test(fonte),
      "voltou o `catch` sem parâmetro: o objeto do erro é descartado, não existe em variável",
    ).toBe(false);
  });

  it("liga o erro a uma variável e manda ao log", () => {
    expect(fonte).toMatch(/catch\s*\(\s*err\s*\)/);
    expect(fonte).toMatch(/logger\.error\("\[prospecting\.cron\]/);
    // Com o requestId, que é o que costura a linha do log à resposta.
    expect(fonte).toMatch(/requestId/);
  });

  it("a mensagem do log é a CAUSA, não uma frase fixa", () => {
    const bloco = fonte.slice(fonte.indexOf("catch (err)"));
    expect(bloco).toMatch(/err instanceof Error \? err\.message/);
  });
});

describe("o worker", () => {
  const fonte = fs.readFileSync(WORKER, "utf8");

  it("não grava uma constante no lugar da causa", () => {
    // Este era o segundo defeito, e o mais sorrateiro dos dois.
    expect(
      fonte.includes('error: "prospecting_tick_failed"'),
      "o log da rodada voltou a gravar uma constante em vez da mensagem do erro",
    ).toBe(false);
  });

  it("o log da rodada carrega a mensagem do erro capturado", () => {
    const i = fonte.indexOf('logger.error("[prospecting] rodada falhou"');
    expect(i, "o log da rodada sumiu").toBeGreaterThan(-1);
    const bloco = fonte.slice(i, fonte.indexOf("});", i) + 3);
    expect(bloco).toMatch(/error instanceof Error \? error\.message/);
    // E o ponteiro que permite achar de quem é a rodada.
    expect(bloco).toMatch(/organization_id:/);
  });
});
