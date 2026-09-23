"use client";

import * as React from "react";
import { PALETTES, DENSITIES, TYPOS } from "./tokens";
import type { PaletteId, TypoId, DensityId, ThemeId } from "./tokens";

type State = {
  palette: PaletteId;
  typo: TypoId;
  density: DensityId;
  theme: ThemeId;
};

type Ctx = State & {
  setPalette: (p: PaletteId) => void;
  setTypo: (t: TypoId) => void;
  setDensity: (d: DensityId) => void;
  setTheme: (t: ThemeId) => void;
};

const VariantCtx = React.createContext<Ctx | null>(null);

const STORAGE = "deskcomm.designshowcase.v1";

const TYPO_VAR_MAP: Record<TypoId, { display: string; body: string; mono: string }> = {
  "bricolage-jakarta": {
    display: "var(--font-bricolage)",
    body: "var(--font-jakarta)",
    mono: "var(--font-jetbrains)",
  },
  "fraunces-manrope": {
    display: "var(--font-fraunces)",
    body: "var(--font-manrope)",
    mono: "var(--font-jetbrains)",
  },
  atkinson: {
    display: "var(--font-atkinson)",
    body: "var(--font-atkinson)",
    mono: "var(--font-jetbrains)",
  },
  "source-plex": {
    display: "var(--font-source-serif)",
    body: "var(--font-plex-sans)",
    mono: "var(--font-plex-mono)",
  },
};

function applyToRoot(s: State) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const p = PALETTES[s.palette];
  const surfaces = s.theme === "dark" ? p.surfaces.dark : p.surfaces.light;
  const states = s.theme === "dark" ? p.states.dark : p.states.light;
  const neutral = s.theme === "dark" ? p.neutralDark : p.neutralLight;

  root.dataset.theme = s.theme;
  root.dataset.palette = s.palette;
  root.dataset.density = s.density;

  // accent stops
  Object.entries(p.accent).forEach(([k, v]) => {
    root.style.setProperty(`--accent-${k}`, v);
  });
  Object.entries(neutral).forEach(([k, v]) => {
    root.style.setProperty(`--neutral-${k}`, v);
  });

  // semantic
  root.style.setProperty("--ds-bg", surfaces.bg);
  root.style.setProperty("--ds-surface", surfaces.surface);
  root.style.setProperty("--ds-surface-elevated", surfaces.surfaceElevated);
  root.style.setProperty("--ds-text", surfaces.text);
  root.style.setProperty("--ds-text-muted", surfaces.textMuted);
  root.style.setProperty("--ds-border", surfaces.border);
  root.style.setProperty("--ds-accent", p.accent[s.theme === "dark" ? 400 : 600]);
  root.style.setProperty("--ds-accent-hover", p.accent[s.theme === "dark" ? 300 : 700]);
  root.style.setProperty("--ds-accent-soft", p.accent[s.theme === "dark" ? 800 : 100]);
  root.style.setProperty("--ds-accent-fg", s.theme === "dark" ? "#0c0b08" : "#ffffff");

  root.style.setProperty("--ds-success", states.success);
  root.style.setProperty("--ds-warning", states.warning);
  root.style.setProperty("--ds-error", states.error);
  root.style.setProperty("--ds-info", states.info);

  // density
  const d = DENSITIES[s.density];
  root.style.setProperty("--density-row-h", d.rowH);
  root.style.setProperty("--density-gap", d.gap);
  root.style.setProperty("--density-pad-x", d.padX);
  root.style.setProperty("--density-pad-y", d.padY);

  // typography
  const t = TYPO_VAR_MAP[s.typo];
  root.style.setProperty("--ds-font-display", t.display);
  root.style.setProperty("--ds-font-body", t.body);
  root.style.setProperty("--ds-font-mono", t.mono);
  root.style.setProperty("--ds-typo-scale", String(TYPOS[s.typo].scale));
}

export function VariantProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<State>({
    palette: "oro",
    typo: "bricolage-jakarta",
    density: "equilibrada",
    theme: "light",
  });
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<State>;
        setState((prev) => ({ ...prev, ...parsed }));
      }
    } catch {}
    setHydrated(true);
  }, []);

  React.useEffect(() => {
    if (!hydrated) return;
    applyToRoot(state);
    try {
      localStorage.setItem(STORAGE, JSON.stringify(state));
    } catch {}
  }, [state, hydrated]);

  // First synchronous paint also: apply default tokens immediately.
  React.useEffect(() => {
    applyToRoot(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: Ctx = {
    ...state,
    setPalette: (p) => setState((s) => ({ ...s, palette: p })),
    setTypo: (t) => setState((s) => ({ ...s, typo: t })),
    setDensity: (d) => setState((s) => ({ ...s, density: d })),
    setTheme: (t) => setState((s) => ({ ...s, theme: t })),
  };
  return <VariantCtx.Provider value={value}>{children}</VariantCtx.Provider>;
}

export function useVariant() {
  const ctx = React.useContext(VariantCtx);
  if (!ctx) throw new Error("useVariant must be used inside VariantProvider");
  return ctx;
}
