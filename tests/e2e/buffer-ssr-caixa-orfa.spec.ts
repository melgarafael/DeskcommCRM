/**
 * A CAIXA DO STREAMING SSR NÃO FICA ÓRFÃ — o experimento da issue #1374 virou porta.
 *
 * ═══ A lei que este arquivo encodeia ═════════════════════════════════════════
 *
 * Num stream correto do React, TODO `<div hidden id="S:N">` vem acompanhado de
 * um revelador no próprio documento que move o conteúdo e DRENA a caixa:
 * `$RC("B:N","S:N")` (boundary), `$RR("B:N","S:N",[…])` (boundary com folhas de
 * estilo) ou `$RS("S:N","P:N")` (segmento) — as três instruções do `react-dom`
 * servidor do Next 16.3.5 (regra em `helpers/caixa-ssr.ts`). No HTML gravado dos runs vermelhos,
 * o documento fechava com a caixa pendurada no `<body>`, com uma cópia inteira
 * da página dentro, e `$RC` ZERO: todo `getByTestId` passava a casar dois
 * (issue #1374, "O invariante quebrado").
 *
 * ═══ Os DOIS experimentos que a issue pede, e que antes não rodavam ═══════════
 *
 * 1. "O experimento que fecha" (issue, seção homônima): separar "o servidor
 *    mandou dois" de "o cliente criou o segundo". Aqui ele roda SEM JavaScript
 *    — o navegador não executa nenhum script, então o documento fica EXATAMENTE
 *    como o servidor o mandou:
 *      · 2 testids sem JS ⇒ o SERVIDOR mandou dois (a hidratação não tem parte);
 *      · caixa `S:N` sem revelador ⇒ o stream terminou antes dele —
 *        o defeito medido na issue, agora reprova aqui.
 *    Com JS desligado os reveladores também não correm, então as caixas FICAM — e é
 *    por isso que dá para ler a relação caixa↔revelador em repouso, sem corrida.
 *
 * 2. "Instrumento que falta" (issue, seção homônima): nenhuma spec escuta o
 *    console do navegador. `instalarInstrumento` liga `pageerror` + `console`
 *    e a spec ANEXA ao relatório — nos dois testes, também quando verdes. Ele
 *    anexa e não afirma: afirmar `pageerror` vazio na página viva sem histórico
 *    medido seria inventir régua; o `pageerror` do teste sem JS é o único
 *    afirmado, porque sem scripts executando ele é deterministicamente zero.
 *
 * 3. A guarda do sintoma (teste 2): com JS ligado e a página carregada, nenhum
 *    `div[hidden][id^="S:"]` sobra e o testid alvo casa UM — o "todo getBy casa
 *    dois" da issue vira vermelho nominal.
 *
 * ═══ Por que este alvo ═══════════════════════════════════════════════════════
 *
 * `/app/settings/atendimento` é a tela que a própria issue escolheu para o
 * experimento ("contexto com javaScriptEnabled: false, goto('/app/settings/
 * atendimento') logado"), é a dona dos testids citados (`opcao-modo-manual`,
 * `form-atendimento`) e o seu boundary é o raiz (`app/app/loading.tsx`) — um
 * dos seis `loading.tsx` que a issue mediu em `origin/main`.
 *
 * A causa, medida depois (cabeçalho de `helpers/test.ts`): a caixa não era
 * órfã — o React ENFILEIRA a revelação para depois do `load`, e o teste lia o
 * documento no meio dela. O `page.goto` do `test` da suíte agora espera a
 * revelação; se a caixa nunca sair, é ele quem reprova, com o nome da issue.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

import { caixasSemRevelador, REVELADOR_DE_CAIXA } from "./helpers/caixa-ssr";
import { instalarInstrumento } from "./helpers/instrumento-da-pagina";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const TELA = "/app/settings/atendimento";

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
}

function lerCreds(): Creds {
  const precisa = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (precisa()) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

/** Mesmo caminho das irmãs (`distribuicao-atendimento`, `agenda-portao-de-hidratacao`). */
async function entrar(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

interface EstadoDoSsr {
  /** Caixas de revelação ainda no documento (`<div hidden id="S:N">`). */
  staged: string[];
  /** Caixas cujo id NÃO aparece em nenhum `$RC`/`$RR`/`$RS` do documento. */
  stagedSemRevelador: string[];
  /** Quantas cópias do testid alvo existem — 2 é o sintoma da issue. */
  alvo: number;
  /** Quantos scripts do documento carregam `$RC(`, `$RR(` ou `$RS(`. */
  scriptsReveladores: number;
}

/** O estado da caixa, lido do DOM como ele está — sem esperar, sem interferir. */
async function medirEstado(pagina: Page): Promise<EstadoDoSsr> {
  const { staged, reveladores, alvo } = await pagina.evaluate((fonte) => {
    const revelador = new RegExp(fonte);
    return {
      staged: Array.from(document.querySelectorAll('div[hidden][id^="S:"]'), (el) => el.id),
      // Só os scripts reveladores saem do navegador: o payload RSC é grande.
      reveladores: Array.from(document.scripts, (s) => s.textContent ?? "").filter((t) => revelador.test(t)),
      alvo: document.querySelectorAll('[data-testid="opcao-modo-manual"]').length,
    };
  }, REVELADOR_DE_CAIXA.source);
  return {
    staged,
    stagedSemRevelador: caixasSemRevelador(staged, reveladores),
    alvo,
    scriptsReveladores: reveladores.length,
  };
}

test.describe("a caixa do streaming SSR não fica órfã (issue #1374)", () => {
  test("sem JavaScript: o servidor manda UM, e toda caixa S:N vem com o seu revelador", async ({ page, context, browser }, testInfo) => {
    const creds = lerCreds();
    // O login É JavaScript (formulário que autentica); o estado dele é que
    // viaja para o contexto sem JS — a navegação medida é a da issue.
    await entrar(page, creds.users.manager!.email, creds.password);
    const estado = await context.storageState();

    const semJs = await browser.newContext({
      javaScriptEnabled: false,
      storageState: estado,
      baseURL: testInfo.project.use.baseURL as string | undefined,
    });
    try {
      const pagina = await semJs.newPage();
      const instrumento = instalarInstrumento(pagina);
      try {
        await pagina.goto(TELA);
        const estadoSsr = await medirEstado(pagina);

        await testInfo.attach("estado-ssr-sem-js", {
          body: JSON.stringify(estadoSsr, null, 2),
          contentType: "application/json",
        });
        await testInfo.attach("instrumento-da-pagina-sem-js", {
          body: JSON.stringify({ erros: instrumento.erros, console: instrumento.console }, null, 2),
          contentType: "application/json",
        });

        expect(
          estadoSsr.alvo,
          "o servidor mandou DOIS o testid alvo sem nenhum script ter rodado — " +
            "é o ramo '2 sem JS → o servidor mandou dois' do experimento da issue #1374: " +
            `estados medidos: ${JSON.stringify(estadoSsr)}`,
        ).toBeLessThanOrEqual(1);
        expect(
          estadoSsr.stagedSemRevelador,
          "caixa S:N SEM revelador ($RC/$RR/$RS) no documento — o invariante quebrado da issue #1374: " +
            "a caixa nunca seria revelada nem drenada. Caixas e reveladores medidos: " +
            `${JSON.stringify({ staged: estadoSsr.staged, scriptsReveladores: estadoSsr.scriptsReveladores })}`,
        ).toEqual([]);
        expect(
          instrumento.erros,
          "pageerror com JavaScript DESLIGADO — nenhum script da página rodou, " +
            "então este erro não vem da página medida: " + JSON.stringify(instrumento.erros),
        ).toEqual([]);
      } finally {
        instrumento.encerrar();
        await pagina.close();
      }
    } finally {
      await semJs.close();
    }
  });

  test("com JavaScript: a caixa drenou — nenhuma sobra e o testid alvo casa UM", async ({ page }, testInfo) => {
    const creds = lerCreds();
    const instrumento = instalarInstrumento(page);
    try {
      await entrar(page, creds.users.manager!.email, creds.password);
      await page.goto(TELA);
      // Espera o alvo existir ANTES de contar: `.first()` não mascara o defeito
      // (a contagem é do DOM inteiro, caixa órfã inclusive) — só garante que a
      // página chegou, para o vermelho de contagem ser do COUNT, não do timeout.
      await page.getByTestId("opcao-modo-manual").first().waitFor({ timeout: 30_000 });
      const estadoSsr = await medirEstado(page);

      await testInfo.attach("estado-ssr-com-js", {
        body: JSON.stringify(estadoSsr, null, 2),
        contentType: "application/json",
      });
      await testInfo.attach("instrumento-da-pagina-com-js", {
        body: JSON.stringify({ erros: instrumento.erros, console: instrumento.console }, null, 2),
        contentType: "application/json",
      });

      expect(
        estadoSsr.staged,
        "caixa <div hidden id=\"S:N\"> sobrou depois da carga — ela ficaria órfã no " +
          `<body> para sempre, com uma cópia da página dentro (issue #1374). Estado: ` +
          `${JSON.stringify(estadoSsr)}`,
      ).toEqual([]);
      expect(
        estadoSsr.alvo,
        "o testid alvo casa MAIS DE UM — é exatamente o sintoma da issue #1374 " +
          "(todo getByTestId casa dois). Estado: " + JSON.stringify(estadoSsr),
      ).toBe(1);
    } finally {
      // O instrumento libera os ouvintes mesmo quando o teste falha no meio —
      // contrato com teste de vazamento em
      // tests/unit/instrumento-de-pagina-nao-vaza.test.ts.
      instrumento.encerrar();
    }
  });
});
