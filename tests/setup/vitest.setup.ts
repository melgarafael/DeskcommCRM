import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Remove um par de aspas (simples ou duplas) que envolva o valor inteiro —
 * mesma convenção que `hostgator-setup-kit/install.sh` grava no `.env` de
 * TODA instalação self-host (`NEXT_PUBLIC_APP_URL="https://${DOMAIN}"`).
 * Sem isto, um self-hoster que rode `pnpm test:unit` na própria VPS antes de
 * atualizar vê a suíte inteira falhar com "Variáveis de ambiente inválidas"
 * (a URL vira `"https://…"` — aspas incluídas — e falha a validação Zod de
 * `lib/env.ts`), mesmo com o `.env` real e correto. `.env.example` (o
 * convívio local, sem instalador) não usa aspas — por isso o bug nunca
 * apareceu em desenvolvimento, só em VPS instalada pelo kit.
 */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// Load .env and .env.local before importing any app code that validates env vars
for (const envFile of [".env", ".env.local"]) {
  try {
    const path = resolve(process.cwd(), envFile);
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...rest] = trimmed.split("=");
      if (key && !process.env[key]) {
        process.env[key] = stripQuotes(rest.join("=").trim());
      }
    }
  } catch {
    // File doesn't exist, skip
  }
}

/**
 * Placeholders para as vars que `lib/env.ts` exige na IMPORTAÇÃO.
 *
 * Sem isto, qualquer arquivo de teste que importe (mesmo transitivamente) um
 * módulo que toque `@/lib/env` **não carrega** onde não há `.env` — e o CI é
 * exatamente esse lugar. O sintoma é cruel: some o arquivo inteiro em vez de
 * falhar um teste, então a contagem cai e ninguém vê que a cobertura evaporou.
 * Foi o que aconteceu no PR #58: 4 arquivos com 0 testes rodados, e o número
 * verde de 1322 escondendo que 3 deles eram novos.
 *
 * É o mesmo remédio que `lib/env.ts:155` já aplica na fase de build da imagem
 * ("semeia placeholders pras vars que faltam e revalida"), aqui restrito ao
 * setup de teste — a lógica de produção não é tocada.
 *
 * `??=` de propósito: valor real de `.env`/`.env.local` SEMPRE vence, então
 * localmente nada muda. E o host `.invalid` é reservado por RFC 2606: se algum
 * teste tentar usar isto como URL de verdade, a chamada falha alto em vez de
 * bater em algum lugar existente.
 */
const URL_DO_PLACEHOLDER = "https://test-placeholder.invalid";
const PLACEHOLDERS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: URL_DO_PLACEHOLDER,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-placeholder-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-placeholder-service-role-key",
};
for (const [chave, valor] of Object.entries(PLACEHOLDERS)) {
  process.env[chave] ??= valor;
}

/**
 * O placeholder falha NA HORA — sem perguntar ao DNS.
 *
 * "Falha alto" (acima) valia para o resultado, não para o RELÓGIO: `.invalid`
 * reprova, mas só quando o resolvedor responde, e isso é tempo de rede. Quem
 * chega aqui por um caminho fire-and-forget — `void audit(...)` nos handlers —
 * não é esperado por teste nenhum: o arquivo termina, e o `console.error` do
 * `reportAuditFailure` (lib/audit/index.ts) cai depois, às vezes BEM na hora em
 * que o vitest fecha o canal do worker. Aí a suíte inteira reprova com todos os
 * arquivos verdes:
 *
 *     EnvironmentTeardownError: [vitest-worker]: Closing rpc while
 *     "onUserConsoleLog" was pending
 *     This error originated in "tests/unit/desfecho-de-agenda-e-sobre-o-passado.test.ts"
 *
 * Medido de 15 a 22/09/2026: 10 runs vermelhos assim, em 8 PRs e 2 pushes da
 * `main` (ex.: runs 35111447270, 35165421158), sempre no FIM da suíte unitária —
 * o `verify` que "falha depois de 10 min" sem teste nenhum vermelho.
 *
 * Recusar aqui, sem rede, é a mesma resposta que o DNS daria (`TypeError: fetch
 * failed`), só que decidida no mesmo tique: o trabalho solto termina enquanto o
 * teste que o disparou ainda está vivo, e não sobra nada em voo no teardown.
 * Só o host do placeholder é recusado; com `.env` de verdade ele nem é usado.
 */
const HOST_DO_PLACEHOLDER = new URL(URL_DO_PLACEHOLDER).host;
const fetchDoAmbiente = globalThis.fetch;
globalThis.fetch = async (entrada, init) => {
  const url = entrada instanceof Request ? entrada.url : String(entrada);
  if (URL.canParse(url) && new URL(url).host === HOST_DO_PLACEHOLDER) {
    throw new TypeError("fetch failed", {
      cause: new Error(
        `${HOST_DO_PLACEHOLDER} é o placeholder do setup de teste (tests/setup/vitest.setup.ts): nenhum teste unitário fala com um Supabase de verdade`,
      ),
    });
  }
  return fetchDoAmbiente(entrada, init);
};

import "@testing-library/jest-dom/vitest";

// Node 25+ expõe `localStorage`/`sessionStorage` nativos que não servem sem
// `--localstorage-file` (no 26.8 valem `undefined`; no 25.4 são um objeto sem `.clear`),
// e o jsdom não os sobrescreve: `localStorage.clear()` quebrava ~100 testes. A guarda
// testa a capacidade, não o tipo, para cobrir os dois. Quando o global nativo não serve,
// devolve o storage do jsdom do arquivo. Em Node 22 o global já é o do jsdom e este
// bloco não faz nada.
const jsdomDoArquivo = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (jsdomDoArquivo) {
  for (const nome of ["localStorage", "sessionStorage"] as const) {
    if (typeof globalThis[nome]?.clear !== "function") {
      Object.defineProperty(globalThis, nome, {
        configurable: true,
        get: () => jsdomDoArquivo.window[nome],
      });
    }
  }
}

// jsdom não implementa ResizeObserver; Radix (ex.: Switch) usa em layout effects.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/**
 * O timer que o Radix deixa para trás não pode disparar em outro jsdom.
 *
 * Ao desmontar, o `FocusScope` do Radix (Dialog, Popover, Sheet…) agenda um
 * `setTimeout(0)` que faz `new CustomEvent(...)` e `container.dispatchEvent`.
 * Quando o componente é desmontado pela limpeza do ÚLTIMO teste de um arquivo,
 * esse timer pode disparar depois que o ambiente jsdom do arquivo já foi
 * desfeito: o evento nasce de outro `window` e o jsdom recusa com
 * "Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of
 * type 'Event'". O vitest conta isso como erro não tratado e reprova a suíte
 * com todos os arquivos verdes — medido no `verify` do #1163 (run
 * 35336406831), atribuído a `composer-colar-imagem.test.tsx`, e intermitente
 * porque depende do relógio do runner.
 *
 * O conserto é dar ao timer a vez de rodar ENQUANTO o jsdom do arquivo existe:
 * desmonta explicitamente e espera um tique de macrotarefa. Com relógio falso
 * ligado não há o que esperar (o timer também é falso) — e esperar um
 * `setTimeout` falso travaria o hook até o teto do teste.
 */
if (typeof document !== "undefined") {
  const { afterEach, vi } = await import("vitest");
  const { cleanup } = await import("@testing-library/react");
  afterEach(async () => {
    cleanup();
    if (vi.isFakeTimers()) return;
    await new Promise((resolver) => setTimeout(resolver, 0));
  });
}
