"use client";

import { useState } from "react";
import { Switcher } from "./components/Switcher";
import { SectionTokens } from "./sections/SectionTokens";
import { SectionPalettes } from "./sections/SectionPalettes";
import { SectionTypography } from "./sections/SectionTypography";
import { SectionDensity } from "./sections/SectionDensity";
import { SectionComponents } from "./sections/SectionComponents";
import { SectionPatterns } from "./sections/SectionPatterns";
import { SectionMotion } from "./sections/SectionMotion";
import { SectionIcons } from "./sections/SectionIcons";
import { useVariant } from "./lib/variant-context";
import { PALETTES, TYPOS, DENSITIES } from "./lib/tokens";

type SectionId =
  | "tokens" | "paletas" | "tipografia" | "densidade"
  | "componentes" | "padroes" | "motion" | "icones";

const NAV: Array<{ id: SectionId; label: string }> = [
  { id: "tokens",      label: "Tokens" },
  { id: "paletas",     label: "Paletas" },
  { id: "tipografia",  label: "Tipografia" },
  { id: "densidade",   label: "Densidade" },
  { id: "componentes", label: "Componentes" },
  { id: "padroes",     label: "Padrões" },
  { id: "motion",      label: "Motion" },
  { id: "icones",      label: "Iconografia" },
];

export default function DesignShowcasePage() {
  const [active, setActive] = useState<SectionId>("tokens");
  const v = useVariant();

  const content = (() => {
    switch (active) {
      case "tokens":      return <SectionTokens />;
      case "paletas":     return <SectionPalettes />;
      case "tipografia":  return <SectionTypography />;
      case "densidade":   return <SectionDensity />;
      case "componentes": return <SectionComponents />;
      case "padroes":     return <SectionPatterns />;
      case "motion":      return <SectionMotion />;
      case "icones":      return <SectionIcons />;
    }
  })();

  return (
    <div className="ds-shell">
      <aside className="ds-sidebar">
        <h1>CarlosCostaPrev – Sistema Integrado de Gestão</h1>
        <div className="ds-sub">design system · v0.1</div>

        <div className="ds-nav-section">Foundation</div>
        {NAV.slice(0, 4).map((n) => (
          <button
            key={n.id}
            className="ds-nav-link"
            data-active={active === n.id}
            onClick={() => setActive(n.id)}
          >
            {n.label}
          </button>
        ))}

        <div className="ds-nav-section">Componentes</div>
        {NAV.slice(4, 6).map((n) => (
          <button
            key={n.id}
            className="ds-nav-link"
            data-active={active === n.id}
            onClick={() => setActive(n.id)}
          >
            {n.label}
          </button>
        ))}

        <div className="ds-nav-section">Sensação</div>
        {NAV.slice(6).map((n) => (
          <button
            key={n.id}
            className="ds-nav-link"
            data-active={active === n.id}
            onClick={() => setActive(n.id)}
          >
            {n.label}
          </button>
        ))}

        <div style={{ marginTop: 32, padding: 12, border: "1px solid var(--ds-border)", borderRadius: 8, fontSize: 11, color: "var(--ds-text-muted)", lineHeight: 1.55 }}>
          <div style={{ color: "var(--ds-accent)", fontFamily: "var(--ds-font-mono)", marginBottom: 6 }}>SELECIONADO</div>
          <div>Paleta · <span style={{ color: "var(--ds-text)" }}>{PALETTES[v.palette].name}</span></div>
          <div>Tipo · <span style={{ color: "var(--ds-text)" }}>{TYPOS[v.typo].name}</span></div>
          <div>Densidade · <span style={{ color: "var(--ds-text)" }}>{DENSITIES[v.density].label}</span></div>
          <div>Tema · <span style={{ color: "var(--ds-text)" }}>{v.theme}</span></div>
        </div>
      </aside>

      <main className="ds-canvas">
        <div className="ds-topbar">
          <div className="ds-topbar-title">
            Showcase de Design System
            <small>navegue pela sidebar · troque variantes acima</small>
          </div>
          <Switcher />
        </div>

        <div className="ds-scroll">
          <div className="ds-banner">
            <h1>Showcase de Design System — CarlosCostaPrev – Sistema Integrado de Gestão</h1>
            <p>
              Use a sidebar pra navegar pelas seções. Use o switcher (canto superior direito) pra trocar
              <strong> paleta · tipografia · densidade · tema</strong> em runtime — escolhas persistem em localStorage.
              Quando bater o ponto certo, me diga: <em>paleta X + tipo Y + densidade Z</em>.
            </p>
          </div>
          {content}
        </div>
      </main>
    </div>
  );
}
