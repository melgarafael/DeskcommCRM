import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cerca de CLASSE, não de instância.
 *
 * O `install.sh` do kit gera `INTERNAL_SECRET` e `INTERNAL_CRON_SECRET` com
 * valores DIFERENTES e grava os dois no `.env`; o `crond` do serviço `scheduler`
 * chama as rotas com `Bearer $INTERNAL_SECRET` (`docker/scheduler/entrypoint.sh`).
 * Uma rota que aceite só o PRIMEIRO segredo definido responde 401 em toda
 * instalação — e o `curl` do crontab descarta a saída, então o 401 diário não
 * aparece em log nenhum. Foi o que aconteceu com `sync-model-catalog`, que ficou
 * um ano assim porque o único lugar que registrava a divergência era um arquivo
 * de configuração de plataforma, depois apagado.
 *
 * Este teste não confere a rota consertada: confere que NENHUMA rota volta ao
 * padrão. Para ver o portão compartilhado: `lib/auth/cron-auth.ts`.
 */
const DIR_CRON = join(__dirname, "..", "..", "app", "api", "v1", "cron");

/** `INTERNAL_CRON_SECRET || INTERNAL_SECRET` e parentes: aceita só o primeiro. */
const SO_O_PRIMEIRO = /INTERNAL_CRON_SECRET\s*(\|\||\?\?)\s*env\.INTERNAL_SECRET/;

function rotasDeCron(): { nome: string; fonte: string }[] {
  return readdirSync(DIR_CRON, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ nome: e.name, fonte: readFileSync(join(DIR_CRON, e.name, "route.ts"), "utf8") }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

describe("autenticação das rotas de cron", () => {
  it("nenhuma rota aceita só o primeiro dos dois segredos", () => {
    const culpadas = rotasDeCron()
      .filter((r) => SO_O_PRIMEIRO.test(r.fonte))
      .map((r) => r.nome);

    expect(
      culpadas,
      "Rota(s) que só aceitam o primeiro segredo definido: " +
        `${culpadas.join(", ")}. O scheduler manda Bearer $INTERNAL_SECRET e elas ` +
        "responderiam 401 em silêncio. Use autorizaCron() de lib/auth/cron-auth.ts.",
    ).toEqual([]);
  });

  it("toda rota confere o Bearer contra os DOIS segredos", () => {
    // Exige o padrão no CÓDIGO, não em comentário: ou a rota chama o portão
    // compartilhado, ou os dois segredos aparecem com o prefixo `env.` na mesma
    // expressão. A primeira versão desta asserção pedia só as duas PALAVRAS em
    // qualquer lugar do arquivo — e uma sabotagem que trocou a auth por uma
    // string literal passou, porque as palavras sobraram no comentário de cima.
    const DOIS_NO_CODIGO = /env\.INTERNAL_CRON_SECRET[\s\S]{0,300}env\.INTERNAL_SECRET/;
    const semOsDois = rotasDeCron()
      .filter((r) => !r.fonte.includes("autorizaCron(") && !DOIS_NO_CODIGO.test(r.fonte))
      .map((r) => r.nome);

    expect(
      semOsDois,
      `Rota(s) de cron sem os dois segredos no caminho de auth: ${semOsDois.join(", ")}.`,
    ).toEqual([]);
  });

  it("toda rota autoriza pelo portão compartilhado — autorizaCron(), em tempo constante", () => {
    // `includes(provided)` e `=== \`Bearer ${s}\`` comparam byte a byte e param no
    // primeiro que difere: o tempo de resposta vaza quantos bytes do segredo
    // estão certos. `autorizaCron()` passa por `timingSafeStringEqual()`, que
    // compara hashes de tamanho fixo. A asserção é POSITIVA de propósito — exige
    // o helper, em vez de procurar `===` — para que nenhuma outra forma de
    // comparação manual volte no futuro (#1327).
    const semHelper = rotasDeCron()
      .filter((r) => !r.fonte.includes("autorizaCron("))
      .map((r) => r.nome);

    expect(
      semHelper,
      `Rota(s) de cron sem autorizaCron() de lib/auth/cron-auth.ts: ${semHelper.join(", ")}.`,
    ).toEqual([]);
  });

  it("o inventário não está vazio — senão os dois casos acima passam por vacuidade", () => {
    expect(rotasDeCron().length).toBeGreaterThan(20);
  });
});
