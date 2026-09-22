import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

/**
 * VOLTAR DO CONSENTIMENTO NÃO DESLOGA — e o teste segue o DESFECHO, não o header.
 *
 * ═══ O que o dono do produto relatou, palavra por palavra ════════════════════
 * "Clico em Conectar Google → seleciono minha conta → ELE DESLOGA DA MINHA CONTA
 * (do CRM) → quando logo de novo ele avisa que minha conta está conectada."
 *
 * ═══ A sessão nunca foi destruída ════════════════════════════════════════════
 * Medido: não há `signOut` em caminho nenhum do callback, e o cookie de sessão
 * tem `maxAge` de 400 dias. O que acontece é o SEGUNDO SALTO:
 *
 *   1. o callback é público, faz o trabalho, e responde 307 para `/app/agenda`;
 *   2. essa navegação ainda pertence à cadeia iniciada em `accounts.google.com`;
 *   3. o cookie de sessão é `SameSite=Strict` — com initiator cross-site ele não
 *      viaja;
 *   4. o `proxy.ts` não enxerga usuário e manda para `/login`.
 *
 * A pessoa lê isso como "o sistema me deslogou". Ela nem foi deslogada: o
 * navegador é que não apresentou o crachá naquele salto.
 *
 * ═══ POR QUE ESTA SPEC EXISTE, e a crítica dói ═══════════════════════════════
 * A hipótese do segundo salto foi levantada pelo PRÓPRIO autor do conserto
 * anterior, marcada NÃO MEDIDA, e não tratada. E a spec daquele PR
 * (`agenda-google-volta-do-consentimento`) usa `maxRedirects: 0` e assere apenas
 * o header `Location` — ela **para exatamente onde a objeção foi deixada**.
 *
 * Quando uma hipótese fica "não medida", o teste escrito naquele PR herda o
 * mesmo ponto cego, e daí em diante o CI verde confirma o RECORTE, não o
 * comportamento. Esta spec existe para seguir o desfecho: navega de verdade e
 * pergunta onde a pessoa PAROU.
 *
 * ═══ Como o cross-site é reproduzido sem o Google ════════════════════════════
 * Não é preciso o `accounts.google.com`: o que produz o defeito é o INITIATOR da
 * navegação ser de outro site. A spec sobe um servidor em `127.0.0.1` enquanto o
 * app roda em `localhost` (é o `baseURL` do `playwright.config`) — para o
 * navegador são **sites diferentes**, e vale a mesma regra de SameSite do Google.
 *
 * ⚠️ A PRIMEIRA VERSÃO DESTA SPEC ERRAVA AQUI, e o erro é instrutivo: eu subi o
 * site "de fora" em `localhost`, o MESMO host do app. Não havia cross-site
 * nenhum, e o teste não media o que dizia medir — teria dado o veredito certo
 * pelo motivo errado. Porta não entra no cálculo de SameSite; host entra.
 *
 * E usa uma saída de ERRO do callback (`erro=retorno_nao_verificavel`), que passa
 * pela MESMA função `voltar()` que a saída de sucesso: as 14 saídas herdam o
 * comportamento dela. Medir o salto não exige consentimento real — exige que a
 * volta venha de fora.
 */
const RAIZ = path.resolve(__dirname, "../..");
const PORTA_DO_SITE_DE_FORA = 4599;

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
}

async function entrar(page: Page, creds: Creds) {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

/**
 * Um site DE FORA que dispara a navegação de volta — o papel do
 * `accounts.google.com` no fluxo real.
 */
function subirSiteDeFora(destino: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const servidor = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // `location.href` numa navegação top-level, exatamente como o Google faz
      // ao devolver o usuário para o `redirect_uri`.
      res.end(`<!doctype html><meta charset="utf-8"><body>
        <a id="voltar" href="${destino}">voltar</a>
        <script>document.getElementById("voltar").click()</script>
      </body>`);
    });
    servidor.listen(PORTA_DO_SITE_DE_FORA, "127.0.0.1", () => resolve(servidor));
  });
}

test("voltar do consentimento não manda a pessoa para o /login", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const creds = lerCreds();
  await entrar(page, creds);

  // A sessão existe ANTES do salto — o controle positivo. Sem ele, um /login no
  // fim poderia significar "nunca esteve logado" em vez de "perdeu no salto".
  await page.goto("/app/agenda");
  await expect(page, "não cheguei logado na Agenda — o cenário não está montado").toHaveURL(
    /\/app\/agenda/,
    { timeout: 20_000 },
  );

  const base = (baseURL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
  const destino = `${base}/api/v1/agenda/google/callback?state=invalido&code=invalido`;
  const servidor = await subirSiteDeFora(destino);

  try {
    // A navegação parte de OUTRO SITE (`127.0.0.1`) para o nosso (`localhost`)
    // — o mesmo initiator cross-site do retorno do Google.
    //
    // MEDIDO contra o código sem o conserto: a pessoa para em
    // `/login?next=%2Fapp%2Fagenda%3Ferro%3Dretorno_nao_verificavel`. Estava
    // logada um passo antes (o controle acima), e nada destruiu a sessão. A
    // dúvida que o briefing marcava como NÃO MEDIDA — "o cookie Strict é mesmo
    // retido neste salto?" — está respondida: é, e em Chromium.
    await page.goto(`http://127.0.0.1:${PORTA_DO_SITE_DE_FORA}/`);
    await page.waitForURL(/\/(app\/agenda|login)/, { timeout: 30_000 });

    const url = page.url();
    expect(
      url,
      `depois de voltar de um site externo, a pessoa parou em ${url}. Ela ESTAVA logada ` +
        "(o controle acima provou) e o callback não destrói sessão nenhuma — o que " +
        "acontece é o cookie SameSite=Strict não viajar num salto iniciado de fora. " +
        "Para quem usa, isso se lê como 'o sistema me deslogou'.",
    ).not.toContain("/login");
    expect(url).toContain("/app/agenda");

    // E continua logada de verdade, não só na URL: a Agenda é rota protegida, e
    // renderizá-la já prova a sessão — mas asserto um elemento dela para o caso
    // de a página virar um shell vazio no futuro.
    await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 20_000 });
  } finally {
    await new Promise<void>((r) => servidor.close(() => r()));
  }
});
