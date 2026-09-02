"use client";

import { useState, useEffect } from "react";
import { MOTION } from "../lib/tokens";

export function SectionMotion() {
  const [modal, setModal] = useState(false);
  const [toast, setToast] = useState(false);
  const [staggerKey, setStaggerKey] = useState(0);
  const [pageKey, setPageKey] = useState(0);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(false), 2400);
      return () => clearTimeout(t);
    }
  }, [toast]);

  return (
    <div className="ds-section">
      <h2 className="ds-display">Motion</h2>
      <p className="ds-lede">
        Motion serve à legibilidade do estado, não ao show. Quatro durações canônicas (
        <span className="ds-mono">120 / 200 / 320 / 420ms</span>) com curvas distintas para distintos
        propósitos. Easing nunca linear — sempre cubic-bezier intencional.
      </p>

      <div className="ds-card" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        {Object.entries(MOTION).map(([k, m]) => (
          <div key={k}>
            <div className="ds-key">motion-{k}</div>
            <div className="ds-val">{m.duration}</div>
            <div style={{ fontSize: 10, color: "var(--ds-text-muted)" }}>{m.easing}</div>
          </div>
        ))}
      </div>

      <h3>Page transition (fade + slide)</h3>
      <div className="ds-card">
        <button className="ds-btn ds-btn--secondary" onClick={() => setPageKey((k) => k + 1)}>Trocar página</button>
        <div
          key={pageKey}
          style={{
            marginTop: 14,
            padding: 24,
            background: "var(--ds-surface-elevated)",
            borderRadius: 8,
            animation: "ds-page-in 320ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <div className="ds-display" style={{ fontSize: 20, fontWeight: 600 }}>Página {pageKey + 1}</div>
          <p style={{ fontSize: 13, color: "var(--ds-text-muted)", marginTop: 6 }}>
            Sem flicker. Fade em opacidade + 6px de subida. 320ms · ease-out exponencial.
          </p>
        </div>
        <style jsx>{`
          @keyframes ds-page-in {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        `}</style>
      </div>

      <h3>Modal · enter/exit</h3>
      <div className="ds-card">
        <button className="ds-btn ds-btn--primary" onClick={() => setModal(true)}>Abrir</button>
        {modal && (
          <div className="ds-modal-backdrop" onClick={() => setModal(false)}>
            <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
              <div className="ds-display" style={{ fontSize: 18, fontWeight: 600 }}>Confirma envio?</div>
              <p style={{ fontSize: 13, color: "var(--ds-text-muted)", margin: "8px 0 16px" }}>
                Backdrop · 200ms fade. Modal · 320ms slide-up + scale 0.985→1.
              </p>
              <button className="ds-btn ds-btn--primary" onClick={() => setModal(false)}>Fechar</button>
            </div>
          </div>
        )}
      </div>

      <h3>Toast · slide-in</h3>
      <div className="ds-card">
        <button className="ds-btn ds-btn--secondary" onClick={() => setToast(true)}>Disparar toast</button>
        {toast && (
          <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 60 }}>
            <div className="ds-toast">
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ds-info)", marginTop: 6 }} />
              <div>
                <div style={{ fontWeight: 500, fontSize: 13.5 }}>Pedido marcado como pago</div>
                <div style={{ fontSize: 12, color: "var(--ds-text-muted)" }}>#12.443 · sincronizando…</div>
              </div>
            </div>
          </div>
        )}
      </div>

      <h3>Hover states</h3>
      <div className="ds-grid-3">
        <div className="ds-card ds-card--interactive">
          <div className="ds-key">Card hover</div>
          <p style={{ fontSize: 12, color: "var(--ds-text-muted)", marginTop: 6 }}>border + translateY(-1px) + shadow.</p>
        </div>
        <div className="ds-card">
          <div className="ds-key">Button hover</div>
          <button className="ds-btn ds-btn--primary" style={{ marginTop: 8 }}>Hover me</button>
        </div>
        <div className="ds-card">
          <div className="ds-key">List item hover</div>
          <div className="ds-list-item" style={{ marginTop: 8 }}>
            <div className="ds-avatar ds-avatar--sm">MS</div>
            <div className="body"><div className="title">Maria Silva</div><div className="preview">Hover para destacar…</div></div>
            <div className="meta"><span className="ts">14h32</span></div>
          </div>
        </div>
      </div>

      <h3>Drag & drop preview (kanban)</h3>
      <div className="ds-card">
        <button className="ds-btn ds-btn--secondary" onClick={() => setDrag((d) => !d)}>
          {drag ? "Soltar" : "Simular drag"}
        </button>
        <div
          className="ds-kanban-card"
          style={{
            marginTop: 12,
            transform: drag ? "rotate(-1.5deg) translateY(-3px) scale(1.02)" : "rotate(0) translateY(0) scale(1)",
            boxShadow: drag ? "0 12px 32px -6px rgba(20,18,14,0.18)" : "none",
            transition: "transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 200ms",
            cursor: drag ? "grabbing" : "grab",
            maxWidth: 280,
          }}
        >
          <div className="row">
            <span className="title">Pedido #12.443</span>
            <span className="value">MT 1.234,56</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--ds-text-muted)" }}>Maria Silva · pix</div>
        </div>
      </div>

      <h3>Skeleton shimmer</h3>
      <div className="ds-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="ds-skel" style={{ width: "60%", height: 14 }} />
        <div className="ds-skel" style={{ width: "85%", height: 12 }} />
        <div className="ds-skel" style={{ width: "40%", height: 12 }} />
      </div>

      <h3>Stagger reveal</h3>
      <div className="ds-card">
        <button className="ds-btn ds-btn--secondary" onClick={() => setStaggerKey((k) => k + 1)}>Replay stagger</button>
        <div className="ds-stagger" key={staggerKey} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {["Maria Silva", "João Pereira", "Ana Beatriz", "Carlos Lima", "Fernanda Reis"].map((n) => (
            <div key={n} className="ds-list-item">
              <div className="ds-avatar ds-avatar--sm">{n.split(" ").map((p) => p[0]).join("")}</div>
              <div className="body">
                <div className="title">{n}</div>
                <div className="preview">Mensagem de exemplo…</div>
              </div>
              <div className="meta"><span className="ts">14h32</span></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
