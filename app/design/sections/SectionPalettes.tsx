"use client";

import { copyToClipboard } from "@/lib/clipboard";

import { PALETTES } from "../lib/tokens";
import type { ColorScale, PaletteId } from "../lib/tokens";
import { useVariant } from "../lib/variant-context";

const STOPS: Array<keyof ColorScale> = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

function Swatches({ scale, onDarkAfter = 600 }: { scale: ColorScale; onDarkAfter?: number }) {
  return (
    <div className="ds-swatch-grid">
      {STOPS.map((stop) => {
        const hex = scale[stop];
        const onDark = Number(stop) >= onDarkAfter;
        return (
          <button
            key={String(stop)}
            type="button"
            className="ds-swatch"
            data-on-dark={onDark}
            style={{ background: hex }}
            onClick={() => void copyToClipboard(hex)}
            title={`${stop} · ${hex} (clique para copiar)`}
          >
            <span>{stop}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SectionPalettes() {
  const v = useVariant();

  return (
    <div className="ds-section">
      <h2 className="ds-display">Paletas</h2>
      <p className="ds-lede">
        Cinco variantes de accent dentro do território &ldquo;soft-tech calmo&rdquo;: nenhuma satura mais
        que ~45% (medido em HSL). Cada uma tem 11 stops do accent, 11 stops de neutro greige (não slate/zinc)
        e versões light/dark <em>definidas separadamente</em>, não invertidas.
      </p>

      {Object.values(PALETTES).map((p) => {
        const active = v.palette === p.id;
        return (
          <div key={p.id} style={{ marginBottom: 36 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0 }}>
                  {p.name}
                  {active && <span className="ds-badge ds-badge--accent" style={{ marginLeft: 10 }}>ativa</span>}
                </h3>
                <p style={{ fontSize: 13, color: "var(--ds-text-muted)", marginTop: 4 }}>{p.description}</p>
              </div>
              <button
                className="ds-btn ds-btn--secondary"
                onClick={() => v.setPalette(p.id as PaletteId)}
                disabled={active}
              >
                Aplicar paleta
              </button>
            </div>

            <div className="ds-card">
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <div>
                  <div className="ds-key" style={{ marginBottom: 6 }}>Accent</div>
                  <Swatches scale={p.accent} />
                </div>
                <div>
                  <div className="ds-key" style={{ marginBottom: 6 }}>Neutro · Light</div>
                  <Swatches scale={p.neutralLight} />
                </div>
                <div>
                  <div className="ds-key" style={{ marginBottom: 6 }}>Neutro · Dark</div>
                  <Swatches scale={p.neutralDark} />
                </div>
                <div>
                  <div className="ds-key" style={{ marginBottom: 6 }}>States · Light / Dark</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6 }}>
                    {(["success", "warning", "error", "info"] as const).map((s) => (
                      <div key={`l-${s}`} style={{ background: p.states.light[s], color: "#fff", padding: "8px 10px", borderRadius: 6, fontSize: 11, fontFamily: "var(--ds-font-mono)" }}>
                        L · {s}
                      </div>
                    ))}
                    {(["success", "warning", "error", "info"] as const).map((s) => (
                      <div key={`d-${s}`} style={{ background: p.states.dark[s], color: "#0a0908", padding: "8px 10px", borderRadius: 6, fontSize: 11, fontFamily: "var(--ds-font-mono)" }}>
                        D · {s}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="ds-light-dark">
                  <div className="ds-preview-light" style={{ background: p.surfaces.light.bg, color: p.surfaces.light.text, border: `1px solid ${p.surfaces.light.border}` }}>
                    <div className="ds-preview-label">Preview · Light</div>
                    <div style={{ background: p.surfaces.light.surface, border: `1px solid ${p.surfaces.light.border}`, borderRadius: 8, padding: 14 }}>
                      <div style={{ fontFamily: "var(--ds-font-display)", fontWeight: 600, marginBottom: 4 }}>Pedido #12.443</div>
                      <div style={{ fontSize: 12, color: p.surfaces.light.textMuted }}>Enviado às 14h32 · cliente respondeu</div>
                      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button style={{ background: p.accent[600], color: "#fff", border: "none", padding: "6px 12px", borderRadius: 4, fontSize: 12, cursor: "pointer" }}>Responder</button>
                        <button style={{ background: "transparent", color: p.accent[600], border: `1px solid ${p.surfaces.light.border}`, padding: "6px 12px", borderRadius: 4, fontSize: 12, cursor: "pointer" }}>Arquivar</button>
                      </div>
                    </div>
                  </div>
                  <div className="ds-preview-dark" style={{ background: p.surfaces.dark.bg, color: p.surfaces.dark.text, border: `1px solid ${p.surfaces.dark.border}` }}>
                    <div className="ds-preview-label">Preview · Dark</div>
                    <div style={{ background: p.surfaces.dark.surface, border: `1px solid ${p.surfaces.dark.border}`, borderRadius: 8, padding: 14 }}>
                      <div style={{ fontFamily: "var(--ds-font-display)", fontWeight: 600, marginBottom: 4 }}>Pedido #12.443</div>
                      <div style={{ fontSize: 12, color: p.surfaces.dark.textMuted }}>Enviado às 14h32 · cliente respondeu</div>
                      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button style={{ background: p.accent[400], color: "#0a0908", border: "none", padding: "6px 12px", borderRadius: 4, fontSize: 12, cursor: "pointer" }}>Responder</button>
                        <button style={{ background: "transparent", color: p.accent[400], border: `1px solid ${p.surfaces.dark.border}`, padding: "6px 12px", borderRadius: 4, fontSize: 12, cursor: "pointer" }}>Arquivar</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
