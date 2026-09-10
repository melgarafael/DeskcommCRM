"use client";

import * as React from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "deskcomm-theme";

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
  // Fallback "dark", não "system": esta instalação tem tema padrão escuro
  // ("dark neon purple", pedido do dono). Sem isto, quem nunca tocou no
  // seletor de tema caía em "system" e, com o SO em modo claro, o efeito de
  // hidratação abaixo sobrescrevia o `data-theme="dark"` que o script inline
  // do `layout.tsx` já tinha pintado — mesmo defeito, duas fontes, precisa
  // corrigir as duas (ver THEME_INIT_SCRIPT). Quem ESCOLHE "Seguir o sistema"
  // explicitamente continua funcionando normal: `setTheme("system")` grava a
  // escolha e este fallback nunca entra em jogo pra essa pessoa.
  if (typeof window === "undefined") return "dark";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage indisponível (modo privado, sandbox) — segue com default.
  }
  return "dark";
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Lê do storage no primeiro render do client (não causa hydration mismatch
  // porque o inline script no layout já setou o data-theme antes do paint).
  const [theme, setThemeState] = React.useState<Theme>(() => readStoredTheme());
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>(() =>
    getSystemTheme(),
  );

  // Listener pra mudanças do prefers-color-scheme.
  React.useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  // Aplica no DOM sempre que o tema efetivo muda.
  React.useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistência opcional — falha silenciosamente.
    }
  }, []);

  const toggle = React.useCallback(() => {
    setThemeState((current) => {
      const currentResolved =
        current === "system" ? getSystemTheme() : current;
      const next: Theme = currentResolved === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore
      }
      return next;
    });
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
