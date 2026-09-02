"use client";

import { DENSITIES } from "../lib/tokens";
import type { DensityId } from "../lib/tokens";
import { useVariant } from "../lib/variant-context";

const MOCK = [
  { name: "Maria Silva",   preview: "Confirmando o endereço de entrega para o pedido #12.443", ts: "14h32", initial: "MS", badge: "novo" },
  { name: "João Pereira",  preview: "Já fiz o Mpesa, segue o comprovante em anexo agora",        ts: "14h28", initial: "JP", badge: null },
  { name: "Ana Beatriz",   preview: "Posso trocar o tamanho? G ficou apertado",                ts: "13h51", initial: "AB", badge: null },
  { name: "Carlos Lima",   preview: "Pedido chegou quebrado, mandei foto pelo Insta",          ts: "12h17", initial: "CL", badge: "urg" },
  { name: "Fernanda Reis", preview: "Obrigada pelo atendimento ontem, super rápido!",          ts: "11h44", initial: "FR", badge: null },
];

function DensityList({ id }: { id: DensityId }) {
  const d = DENSITIES[id];
  return (
    <div
      className="ds-list"
      style={{
        // Override CSS vars locally so each panel shows its own density.
        ["--density-row-h" as string]: d.rowH,
        ["--density-gap" as string]: d.gap,
        ["--density-pad-x" as string]: d.padX,
        ["--density-pad-y" as string]: d.padY,
      } as React.CSSProperties}
    >
      {MOCK.map((m) => (
        <div className="ds-list-item" key={m.name}>
          <div className="ds-avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
            {m.initial}
            <span className="ds-avatar-status" />
          </div>
          <div className="body">
            <div className="title">{m.name}</div>
            <div className="preview">{m.preview}</div>
          </div>
          <div className="meta">
            <span className="ts">{m.ts}</span>
            {m.badge && (
              <span className={`ds-badge ${m.badge === "urg" ? "ds-badge--error" : "ds-badge--accent"}`}>
                {m.badge}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SectionDensity() {
  const v = useVariant();
  return (
    <div className="ds-section">
      <h2 className="ds-display">Densidade</h2>
      <p className="ds-lede">
        Atendentes em jornada de 8h precisam de uma densidade que reduza scroll mas mantenha
        respiração visual. Três modos, com row-height + gap como tokens primários.
        Aplicado a uma lista de inbox mock.
      </p>

      {(Object.keys(DENSITIES) as DensityId[]).map((id) => {
        const d = DENSITIES[id];
        const active = v.density === id;
        return (
          <div key={id} style={{ marginBottom: 32 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>
                <h3 style={{ margin: 0 }}>
                  {d.label}
                  {active && <span className="ds-badge ds-badge--accent" style={{ marginLeft: 10 }}>ativa</span>}
                </h3>
                <p style={{ fontSize: 12.5, color: "var(--ds-text-muted)", marginTop: 4 }}>
                  row-height <span className="ds-mono">{d.rowH}</span> · gap <span className="ds-mono">{d.gap}</span>
                  {" · "}padding <span className="ds-mono">{d.padY} {d.padX}</span>
                </p>
              </div>
              <button className="ds-btn ds-btn--secondary" onClick={() => v.setDensity(id)} disabled={active}>
                Aplicar
              </button>
            </div>
            <DensityList id={id} />
          </div>
        );
      })}
    </div>
  );
}
