"use client";

import * as React from "react";

/**
 * Light-only (DESIGN.md). A API (ThemeProvider/useTheme/setTheme/toggle) foi
 * mantida para não quebrar os consumidores — `branding.test.ts` chega a exigir
 * a ordem `MarcaDosClientComponents > ThemeProvider` no layout — mas tudo
 * resolve para `light`: `setTheme`/`toggle` gravam `light` e o DOM nunca sai
 * dele. O bloco `[data-theme="dark"]` do globals.css segue morto de pé para a
 * derivação de marca de revendedor (ver cabeçalho dos tokens).
 */

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "deskcomm-theme";

type ThemeContextValue = {
  /** User preference: sempre `light` (escrita normaliza para `light`). */
  theme: Theme;
  /** Effective theme applied to the DOM: sempre `light`. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function applyTheme() {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", "light");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const setTheme = React.useCallback((_next: Theme) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "light");
    } catch {
      // Persistência opcional — falha silenciosamente.
    }
  }, []);

  const toggle = React.useCallback(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "light");
    } catch {
      // ignore
    }
  }, []);

  // Aplica no DOM uma vez, no cliente (o script inline do layout já pintou
  // `light` antes do primeiro paint; isto é só a garantia local).
  React.useEffect(() => {
    applyTheme();
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme: "light", resolvedTheme: "light", setTheme, toggle }),
    [setTheme, toggle],
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
