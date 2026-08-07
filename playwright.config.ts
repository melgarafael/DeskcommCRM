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

// Porta do dev server sob teste. Default 3001; sobrescreva com E2E_PORT quando
// a 3001 já estiver ocupada por outro checkout/worktree.
const PORT = process.env.E2E_PORT ?? "3001";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
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
    trace: "on-first-retry",
  },
  webServer: {
    // Produção (`next build` antes!): dev-server compila por rota (40-80s) e
    // Turbopack dev quebra cookies() fora do request scope — inviável p/ e2e.
    command: `pnpm exec next start --port ${PORT}`,
    // O ambiente do servidor sob teste vem do `.env.e2e`, INJETADO aqui — e não
    // do `.env.local`, que num checkout de trabalho aponta para PRODUÇÃO.
    // Variável de ambiente real tem precedência sobre os arquivos `.env*` que o
    // Next carrega sozinho, e é isto que impede a suíte de escrever no banco
    // real (medido em 2026-08-06: sem esta injeção, ela escrevia).
    //
    // ⚠️ Isto cobre o SERVIDOR. Os scripts de seed que as specs chamam sozinhas
    // liam `.env.local` direto do disco e escapavam daqui — o conserto do outro
    // lado é `scripts/lib/env-de-teste.ts`.
    env: envDoE2E(),
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
