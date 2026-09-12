"use client";

import * as React from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

// Exportada para o teste reusar em vez de duplicar o literal — duplicar
// acionaria `tests/unit/branding.test.ts` (a mesma marca hardcoded, fora da
// lista congelada, num segundo arquivo).
export const STORAGE_KEY = "deskcomm-theme";

type ThemeContextValue = {
  /** User preference: light, dark, or system. */
  theme: Theme;
  /** Effective theme applied to the DOM (system collapsed to light/dark). */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage indisponível (modo privado, sandbox) — segue com default.
  }
  return "system";
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
}

/**
 * ═══ POR QUE ISTO É UM EXTERNAL STORE, E NÃO `useState` + `useEffect` ═══
 *
 * A primeira renderização do CLIENTE é a renderização de hidratação — a
 * mesma que o React compara contra o HTML que o servidor mandou. O servidor
 * roda com `window === undefined`, então `readStoredTheme()`/`getSystemTheme()`
 * sempre devolvem "system"/"light" lá. Um `useState(() => readStoredTheme())`
 * reexecuta esse inicializador na hidratação — agora com `window` de verdade
 * — e um usuário com tema salvo "dark" produzia, nesse instante, uma
 * primeira renderização do cliente dizendo "dark" contra o "system" que o
 * servidor mandou. Como `ThemeToggle` deriva o ícone e o `aria-label` de
 * `theme`, a divergência aparecia literalmente no atributo: o hydration
 * mismatch relatado (aria-label "Tema: dark" batendo contra "Tema: system",
 * ícone Moon contra MonitorPlay).
 *
 * A saída não é "ler depois, num `useEffect`": `setState` dentro de um
 * `useEffect` sem dependência externa real é exatamente o padrão que
 * `react-hooks/set-state-in-effect` está certo em recusar (cascata de
 * renders por engano). A saída certa — e já em uso neste repo para a mesma
 * classe de defeito, ver `components/branding/CampoDeLogo.tsx` — é
 * `useSyncExternalStore`: `getServerSnapshot` devolve o valor determinístico
 * que o servidor viu (idêntico ao que a primeira renderização do cliente
 * também usa, ANTES de qualquer inscrição rodar), e só depois do commit o
 * React troca para `getSnapshot` (o valor real) — sem cascata, sem aviso, e
 * sem hydration mismatch, porque a COMPARAÇÃO de hidratação nunca vê o valor
 * real: ela vê `getServerSnapshot` dos dois lados.
 */
type Ouvinte = () => void;
const ouvintesDeTema = new Set<Ouvinte>();
let temaEmCache: Theme | null = null;

function getTemaSnapshot(): Theme {
  if (temaEmCache === null) temaEmCache = readStoredTheme();
  return temaEmCache;
}
function getTemaSnapshotDoServidor(): Theme {
  return "system";
}
function inscreverEmTema(ouvinte: Ouvinte): () => void {
  ouvintesDeTema.add(ouvinte);
  return () => ouvintesDeTema.delete(ouvinte);
}
function gravarTema(next: Theme) {
  temaEmCache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Persistência opcional — falha silenciosamente.
  }
  ouvintesDeTema.forEach((ouvinte) => ouvinte());
}

const ouvintesDeSistema = new Set<Ouvinte>();
let sistemaEmCache: ResolvedTheme | null = null;

function getSistemaSnapshot(): ResolvedTheme {
  if (sistemaEmCache === null) sistemaEmCache = getSystemTheme();
  return sistemaEmCache;
}
function getSistemaSnapshotDoServidor(): ResolvedTheme {
  return "light";
}
function inscreverEmSistema(ouvinte: Ouvinte): () => void {
  if (ouvintesDeSistema.size === 0 && typeof window !== "undefined") {
    // Só liga UM listener nativo, mesmo com N componentes inscritos — o
    // fan-out para os `ouvinte()` é responsabilidade deste módulo.
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      sistemaEmCache = e.matches ? "dark" : "light";
      ouvintesDeSistema.forEach((o) => o());
    };
    mql.addEventListener("change", onChange);
  }
  ouvintesDeSistema.add(ouvinte);
  return () => ouvintesDeSistema.delete(ouvinte);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = React.useSyncExternalStore(inscreverEmTema, getTemaSnapshot, getTemaSnapshotDoServidor);
  const systemTheme = React.useSyncExternalStore(
    inscreverEmSistema,
    getSistemaSnapshot,
    getSistemaSnapshotDoServidor,
  );

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  // Aplica no DOM sempre que o tema efetivo muda. Isto não é "ler estado
  // externo" (o que o external store acima já cobre) — é o único jeito de
  // fazer um EFEITO COLATERAL (mutar `data-theme` no `<html>`) a partir de um
  // valor computado, e por isso continua em `useEffect`, sem aviso: aqui não
  // há `setState`, só uma chamada de DOM.
  React.useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = React.useCallback((next: Theme) => {
    gravarTema(next);
  }, []);

  const toggle = React.useCallback(() => {
    const atual = getTemaSnapshot();
    const resolvidoAtual = atual === "system" ? getSistemaSnapshot() : atual;
    gravarTema(resolvidoAtual === "dark" ? "light" : "dark");
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggle }),
    [theme, resolvedTheme, setTheme, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within <ThemeProvider>");
  }
  return ctx;
}
