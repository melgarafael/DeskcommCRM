/**
 * O TEMA DA PRIMEIRA RENDERIZAÇÃO DO CLIENTE É O MESMO QUE O SERVIDOR MANDOU.
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR ═══
 *
 * `ThemeProvider` inicializava `theme`/`systemTheme` com
 * `useState(() => readStoredTheme())` / `useState(() => getSystemTheme())`.
 * Essas funções checam `typeof window === "undefined"` para decidir a fonte:
 * no servidor (sem `window`) sempre devolvem "system"/"light"; no navegador,
 * leem `localStorage`/`matchMedia` de verdade.
 *
 * O problema: o inicializador de `useState` roda de novo na hidratação — que
 * É a primeira renderização do cliente, a mesma que o React compara contra o
 * HTML que o servidor mandou. Um usuário com tema salvo "dark" produzia,
 * nessa comparação, um servidor dizendo "system" e um cliente dizendo "dark"
 * — e como `ThemeToggle` deriva o ícone e o `aria-label` de `theme`, a
 * divergência aparecia literalmente no atributo, reproduzindo byte a byte o
 * "Runtime Error: hydration mismatch" relatado (aria-label "Tema: dark" no
 * cliente contra "Tema: system" no servidor, ícone Moon contra MonitorPlay).
 *
 * O comentário que o código tinha ("não causa hydration mismatch porque o
 * inline script no layout já setou o data-theme antes do paint") confundia
 * duas coisas: o script inline manipula o ATRIBUTO `data-theme` do `<html>`
 * diretamente, fora do React — isso evita o flash visual de CSS, mas é cego
 * para a árvore React em si, que continua sendo comparada por conteúdo.
 *
 * ═══ POR QUE A RECEITA ABAIXO É FIEL, E NÃO UM TRUQUE DE jsdom ═══
 *
 * `renderToStaticMarkup` nunca roda `useEffect` — é o mesmo motivo que
 * `tests/unit/marca-sem-divergencia-de-hidratacao.test.tsx` usa para testar
 * hydration mismatch de marca. Isso o torna um substituto fiel tanto da
 * saída REAL do servidor quanto da saída da PRIMEIRA renderização do
 * cliente (a que a hidratação compara) — porque nos dois casos nenhum
 * efeito rodou ainda, só o corpo síncrono do componente.
 *
 * Em jsdom `window` sempre existe, então "renderizar como servidor" exige
 * apagá-lo de propósito do escopo global durante a chamada — `renderToStaticMarkup`
 * não toca em nenhuma API de DOM, então isso é seguro. "Renderizar como a
 * primeira passada do cliente" é a MESMA chamada com `window` de volta e
 * `localStorage` populado como o de um usuário retornando.
 *
 * ═══ SABOTAGEM QUE ESTE ARQUIVO JÁ REPROVOU ═══
 *
 * Voltar `useState<Theme>(() => readStoredTheme())` /
 * `useState<ResolvedTheme>(() => getSystemTheme())` (o defeito de volta, com
 * o conserto no lugar): as duas asserções de igualdade ficam vermelhas —
 * `doPrimeiraRenderCliente` passa a dizer "Tema: dark" enquanto `doServidor`
 * continua dizendo "Tema: system".
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEY as CHAVE } from "@/lib/theme";
import type { ThemeProvider as ThemeProviderType } from "@/lib/theme";
import type { ThemeToggle as ThemeToggleType } from "@/components/theme/theme-toggle";

vi.mock("react-hotkeys-hook", () => ({ useHotkeys: () => {} }));

function stubMatchMedia(prefersDark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("dark") && prefersDark,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

let ThemeProvider: typeof ThemeProviderType;
let ThemeToggle: typeof ThemeToggleType;
let ARVORE: React.ReactElement;

beforeEach(async () => {
  window.localStorage.clear();
  stubMatchMedia(false);
  // O cache do external store (`temaEmCache`/`sistemaEmCache`) mora no MÓDULO,
  // não no componente — de propósito, é o que faz `toggle()` funcionar sem
  // reler o storage a cada chamada. Mas isso faz um teste que rodasse antes
  // vazar cache para o de depois. `resetModules` + reimportar dá a cada `it`
  // um módulo (e um cache) genuinamente zerado, igual a uma aba nova.
  vi.resetModules();
  ({ ThemeProvider } = await import("@/lib/theme"));
  ({ ThemeToggle } = await import("@/components/theme/theme-toggle"));
  ARVORE = (
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** O que o servidor Node (sem `window`) produz — `renderToStaticMarkup` nunca roda efeito. */
function renderizarComoServidor(): string {
  const janelaReal = globalThis.window;
  // @ts-expect-error — apagar de propósito para `typeof window === "undefined"` ser verdade.
  delete globalThis.window;
  try {
    return renderToStaticMarkup(ARVORE);
  } finally {
    globalThis.window = janelaReal;
  }
}

/** O que a PRIMEIRA renderização do cliente produz — mesma chamada, `window` de verdade. */
function renderizarComoPrimeiraPassadaDoCliente(): string {
  return renderToStaticMarkup(ARVORE);
}

describe("o tema não diverge entre o SSR e a primeira renderização do cliente", () => {
  it("com tema salvo 'dark', a primeira passada do cliente bate com o servidor", () => {
    window.localStorage.setItem(CHAVE, "dark");

    const doServidor = renderizarComoServidor();
    const doCliente = renderizarComoPrimeiraPassadaDoCliente();

    // Os dois precisam dizer "system" — é o valor que `readStoredTheme()`
    // devolve sem `window`, e é o que a hidratação tem de bater ANTES do
    // efeito que sincroniza com o localStorage rodar.
    expect(doServidor).toContain("Tema: system");
    expect(
      doCliente,
      "A primeira renderização do cliente leu o localStorage direto no " +
        "inicializador do useState, produzindo 'Tema: dark' — diferente do " +
        "que o servidor mandou ('Tema: system'). É o hydration mismatch.",
    ).toContain("Tema: system");
    expect(doCliente).toBe(doServidor);
  });

  it("com tema salvo 'light', a primeira passada do cliente também bate", () => {
    window.localStorage.setItem(CHAVE, "light");

    const doServidor = renderizarComoServidor();
    const doCliente = renderizarComoPrimeiraPassadaDoCliente();

    expect(doCliente).toBe(doServidor);
  });

  it("GUARDA DE VACUIDADE: depois do efeito, o tema real aparece", () => {
    // Sem este caso, os dois de cima passariam num componente que nunca
    // reflete o tema salvo — "sempre system" bateria com "sempre system"
    // para sempre, e o defeito oposto (a preferência do usuário nunca é
    // lida) passaria despercebido.
    window.localStorage.setItem(CHAVE, "dark");
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(ARVORE);
    });
    expect(container.innerHTML).toContain("Tema: dark");
  });
});
