import { readFileSync } from "node:fs";

import { defineConfig } from "@playwright/test";

/**
 * Lê o `.env.e2e` — o ambiente LOCAL da suíte.
 *
 * Falha ALTO se o arquivo não existir, em vez de deixar o app cair no
 * `.env.local`: o modo de falha silencioso aqui é a suíte rodar contra o banco
 * de PRODUÇÃO, que foi exatamente o que acontecia antes deste arquivo existir
 * (medido em 2026-08-06).
 */
function envDoE2E(): Record<string, string> {
  let bruto: string;
  try {
    bruto = readFileSync(".env.e2e", "utf8");
  } catch {
    throw new Error(
      "Falta o .env.e2e — rode `pnpm e2e:env` (precisa do Supabase local de pé).\n" +
        "Sem ele o app sob teste carregaria o .env.local, que aponta para PRODUÇÃO.",
    );
  }
  const env: Record<string, string> = {};
  for (const linha of bruto.split("\n")) {
    const limpa = linha.trim();
    if (limpa === "" || limpa.startsWith("#")) continue;
    const i = limpa.indexOf("=");
    if (i <= 0) continue;
    env[limpa.slice(0, i)] = limpa.slice(i + 1);
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  // Um `.env.e2e` apontando para fora do localhost é pior que nenhum, porque
  // parece seguro.
  if (!url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
    throw new Error(`.env.e2e aponta para um Supabase que não é local (${url}) — recusado.`);
  }
  return env;
}

/**
 * Publica o `.env.e2e` no ambiente do PROCESSO DE TESTE, não só do servidor.
 *
 * ## O defeito, medido em 2026-08-08 num worktree limpo
 *
 * `pnpm e2e:build && pnpm test:e2e` — o caminho documentado — morria antes do
 * primeiro teste:
 *
 *   Error: Sem credenciais do Supabase: defina NEXT_PUBLIC_SUPABASE_URL e
 *   SUPABASE_SERVICE_ROLE_KEY no ambiente (…) ou no .env.local
 *     at credenciaisSupabaseDeTeste (scripts/lib/env-de-teste.ts)
 *     at scripts/seed-e2e-credentials.ts
 *
 * A cadeia: as specs semeiam a própria precondição com `execFileSync`, o filho
 * herda o ambiente do RUNNER, e o runner não recebia nada — `envDoE2E()`
 * alimentava apenas `webServer.env`. `env-de-teste.ts` cai no `.env.local` como
 * plano B, e num worktree limpo esse arquivo **não existe de propósito**: a
 * ausência dele é o que impede a suíte de escrever em produção.
 *
 * Ou seja as duas proteções se anulavam: a que tira o `.env.local` do disco e a
 * que injeta o ambiente só no servidor deixavam o seed sem nenhuma das duas
 * fontes. O CI não notava porque contorna por dois caminhos — publica o arquivo
 * no `$GITHUB_ENV` e ainda faz `cp .env.e2e .env.local`, recriando justamente o
 * arquivo cuja ausência é a proteção.
 *
 * ## Por que aqui
 *
 * Este é o único ponto que já lê e valida o arquivo (inclusive recusando um
 * `.env.e2e` que aponte para fora do localhost). Resolver no `package.json` com
 * `set -a; . ./.env.e2e` funcionaria para quem usa o script e não para quem
 * chama `playwright test` direto — e é o caminho que a mensagem de erro sugere,
 * o que já prova que alguém teve de descobrir isto na mão.
 *
 * `process.env` VENCE quando a chave já existe: é a mesma precedência de
 * `scripts/lib/env-de-teste.ts`, e é o que mantém de pé o
 * `AUTH_RATE_LIMIT_LOGIN_IP` que o workflow define por fora. Sobrescrever aqui
 * criaria a colisão descrita no comentário do `webServer` abaixo — servidor e
 * processo de teste resolvendo a mesma chave para valores diferentes, que foi
 * como `INTERNAL_SECRET` derrubou 8 specs com 401.
 */
function publicarNoProcesso(env: Record<string, string>): Record<string, string> {
  for (const [chave, valor] of Object.entries(env)) {
    if (process.env[chave] === undefined) process.env[chave] = valor;
  }
  return env;
}

/**
 * O `.env.e2e` é publicado ANTES de a porta ser decidida — e a ordem é o
 * conserto, não estilo.
 *
 * ## O defeito, medido em 2026-09-18 na bancada do épico "casos vivos"
 *
 * `publicarNoProcesso` era chamado lá embaixo, dentro de `webServer.env`, e
 * `PORT` era lido aqui em cima. O Playwright carrega este arquivo DUAS vezes —
 * uma no processo que orquestra (e sobe o `webServer`) e outra em cada worker,
 * que herda o `process.env` já publicado pela primeira. Resultado, com
 * `E2E_PORT=3107` escrito no `.env.e2e` e ausente no shell:
 *
 *   processo principal → PORT 3001 → sobe `next start --port 3001`, checa 3001
 *   worker             → PORT 3107 → `page.goto` em localhost:3107
 *
 * Os dois lados do mesmo arquivo resolvendo a mesma chave para valores
 * diferentes — exatamente o modo de falha que o comentário do `webServer` já
 * documenta para `INTERNAL_SECRET`, aqui aplicado à PORTA. O sintoma é
 * `ERR_CONNECTION_REFUSED` no primeiro `goto` com um servidor saudável no ar,
 * e ele não aponta para lugar nenhum perto daqui.
 *
 * `scripts/gerar-env-e2e.sh` não escreve `E2E_PORT` hoje, então o CI nunca
 * pisou nisto — mas o arquivo já grava `NEXT_PUBLIC_APP_URL` COM a porta
 * dentro, e quem põe as duas juntas (qualquer bancada em porta própria) cai na
 * armadilha. Publicar primeiro faz o `.env.e2e` ser a fonte única também para
 * a porta; o shell continua vencendo, porque `publicarNoProcesso` só preenche
 * chave ausente.
 */
const ENV_DO_E2E = publicarNoProcesso(envDoE2E());

// Porta do dev server sob teste. Default 3001; sobrescreva com E2E_PORT (no
// shell ou no próprio `.env.e2e`) quando a 3001 já estiver ocupada por outro
// checkout/worktree.
const PORT = process.env.E2E_PORT ?? "3001";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  timeout: 30_000,
  fullyParallel: false,
  /**
   * UM worker. `fullyParallel: false` serializa apenas DENTRO de cada arquivo —
   * entre arquivos o Playwright continua abrindo vários workers, e estes specs
   * compartilham a MESMA organização, os MESMOS usuários e o MESMO banco: um
   * spec revoga acesso enquanto outro checa escopo, um cria convite enquanto
   * outro conta membros.
   *
   * Medido em 2026-07-31: rodando a suíte inteira, 10 a 15 specs falhavam com
   * `waitForURL` estourando depois do login e elementos "not found"; os MESMOS
   * specs, rodados isolados, passavam em 18s. Não era lógica nem lentidão: era
   * interferência.
   *
   * O custo é wall-clock no CI. O benefício é que um vermelho volta a significar
   * "quebrou" em vez de "deu azar na ordem" — e suíte que falha por azar ninguém
   * lê, o que na prática desliga o gate inteiro.
   */
  workers: 1,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    // ⚠️ Era `on-first-retry`, e com `retries: 0` logo acima isso significa
    // **trace nunca gravado**. As duas linhas estão certas isoladamente e
    // erradas juntas: uma diz "só no retry", a outra diz "não há retry".
    //
    // O preço apareceu inteiro numa investigação real: um vermelho em
    // `marca-logo.spec.ts` afirmava "a recusa apagou o logo", e responder o que
    // de fato aconteceu com o DOM custou quatro agentes e uma cadeia de
    // eliminação — porque o único artefato do run era um `error-context.md`
    // que fotografou a página do `afterAll`, não a que falhou. Um trace teria
    // dado URL, DOM e rede daquele instante, sem hipótese nenhuma.
    //
    // `retain-on-failure` grava sempre e descarta no verde: custa disco só
    // quando já se está pagando o custo maior, que é ter um vermelho.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Produção (`next build` antes!): dev-server compila por rota (40-80s) e
    // Turbopack dev quebra cookies() fora do request scope — inviável p/ e2e.
    // `--keepAliveTimeout`: o MESMO valor do `KEEP_ALIVE_TIMEOUT` do Dockerfile
    // (lá está o porquê; `tests/unit/keep-alive-do-servidor.test.ts` prende os
    // dois). Com o padrão do Node, o servidor fecha a conexão ociosa aos 6 s
    // (5 s + 1 s de `keepAliveTimeoutBuffer`), e o `page.request` do Playwright
    // — agente keep-alive SEM prazo de ociosidade — reaproveita o socket no
    // instante em que ele morre: `ECONNRESET`/`socket hang up` num GET depois
    // de ~6 s sem chamada de API (medido: 5988 e 5998 ms nas runs 36069450590 e
    // 36188123417).
    command: `pnpm exec next start --port ${PORT} --keepAliveTimeout 125000`,
    // O ambiente do servidor sob teste vem do `.env.e2e`, INJETADO aqui — e não
    // do `.env.local`, que num checkout de trabalho aponta para PRODUÇÃO.
    // Variável de ambiente real tem precedência sobre os arquivos `.env*` que o
    // Next carrega sozinho, e é isto que impede a suíte de escrever no banco
    // real (medido em 2026-08-06: sem esta injeção, ela escrevia).
    //
    // ⚠️ Isto cobre o SERVIDOR. Os scripts de seed que as specs chamam sozinhas
    // liam `.env.local` direto do disco e escapavam daqui — o conserto do outro
    // lado é `scripts/lib/env-de-teste.ts`, que faz `process.env` vencer. E é o
    // `publicarNoProcesso` acima que garante que o `process.env` do runner tenha
    // o que aquele conserto precisa: sem ele, num worktree sem `.env.local`, o
    // seed não tinha NENHUMA das duas fontes.
    env: ENV_DO_E2E,
    url: BASE_URL,
    // false: reusar um server que já ocupa a porta pode ser OUTRO processo
    // (ex.: bundle do Remotion na 3000) — o teste precisa do NOSSO next start.
    reuseExistingServer: false,
    // Sobre a precedência de `env`, MEDIDO (Playwright 1.5x, 2026-08-07) com um
    // webServer que imprime o que recebeu:
    //
    //   var só no process.env        → CHEGA ao servidor (mescla, não substitui)
    //   var só no `env:` do config   → chega
    //   var nos DOIS, valores dif.   → vence a do `env:` do config
    //
    // A primeira linha é o que mantém `AUTH_RATE_LIMIT_LOGIN_IP` funcionando:
    // ele é definido no passo do workflow e quem aplica o teto é o SERVIDOR.
    //
    // A terceira é a armadilha. Uma chave que exista no `.env.e2e` E no ambiente
    // do CI silenciosamente resolve para valores DIFERENTES nos dois lados —
    // servidor com um, processo de teste com outro. Foi assim que
    // `INTERNAL_SECRET` derrubou 8 specs com 401. Por isso o workflow publica o
    // `.env.e2e` inteiro no ambiente do job em vez de redigitar valores: uma
    // fonte não colide consigo mesma.
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
