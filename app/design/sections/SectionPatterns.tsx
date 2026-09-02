"use client";

const inboxList = [
  { name: "Maria Silva",  preview: "Confirma o endereço…", ts: "14h32", initial: "MS", active: true },
  { name: "João Pereira", preview: "Comprovante anexo",     ts: "14h28", initial: "JP" },
  { name: "Ana Beatriz",  preview: "Trocar tamanho?",       ts: "13h51", initial: "AB" },
  { name: "Carlos Lima",  preview: "Produto chegou…",       ts: "12h17", initial: "CL" },
];

export function SectionPatterns() {
  return (
    <div className="ds-section">
      <h2 className="ds-display">Padrões compostos</h2>
      <p className="ds-lede">
        Estruturas que se repetem em telas operacionais. Layouts puros — dados são placeholders.
      </p>

      {/* Inbox 3 colunas */}
      <h3>Inbox · 3 colunas</h3>
      <div
        className="ds-card"
        style={{
          padding: 0,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "260px 1fr 320px",
          height: 420,
        }}
      >
        <div style={{ borderRight: "1px solid var(--ds-border)", padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          <input className="ds-input" placeholder="Buscar…" />
          {inboxList.map((c) => (
            <div
              key={c.name}
              className="ds-list-item"
              style={{
                background: c.active ? "var(--ds-accent-soft)" : undefined,
                borderColor: c.active ? "var(--ds-accent)" : undefined,
              }}
            >
              <div className="ds-avatar ds-avatar--sm">{c.initial}</div>
              <div className="body">
                <div className="title" style={{ fontSize: 12.5 }}>{c.name}</div>
                <div className="preview" style={{ fontSize: 11.5 }}>{c.preview}</div>
              </div>
              <div className="meta"><span className="ts">{c.ts}</span></div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--ds-border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Maria Silva</div>
              <div style={{ fontSize: 12, color: "var(--ds-text-muted)" }}>+55 11 9 9943-1102 · Pedido #12.443</div>
            </div>
            <span className="ds-badge ds-badge--success">resolvendo</span>
          </div>
          <div style={{ flex: 1, padding: 18, display: "flex", flexDirection: "column", gap: 8, overflow: "auto" }}>
            <div className="ds-bubble in">Oi! Confirma o endereço pra mim?</div>
            <div className="ds-bubble out">Rua das Acácias 144 · 14h32 · ✓✓</div>
            <div className="ds-bubble in">Perfeito.</div>
          </div>
          <div style={{ padding: 12, borderTop: "1px solid var(--ds-border)", display: "flex", gap: 8 }}>
            <input className="ds-input" placeholder="Digite…" style={{ flex: 1 }} />
            <button className="ds-btn ds-btn--primary">Enviar</button>
          </div>
        </div>

        <div style={{ borderLeft: "1px solid var(--ds-border)", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div className="ds-avatar ds-avatar--lg">MS<span className="ds-avatar-status" /></div>
            <div style={{ fontWeight: 600 }}>Maria Silva</div>
            <div style={{ fontSize: 12, color: "var(--ds-text-muted)" }}>Cliente desde mar/2024</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="ds-key">LTV</span><span className="ds-display" style={{ fontSize: 22, fontWeight: 600 }}>MT 4.882,40</span>
            <span className="ds-key">Pedidos</span><span style={{ fontSize: 14 }}>12 (3 últimos 90d)</span>
          </div>
        </div>
      </div>

      {/* Kanban */}
      <h3>Kanban · pipeline de pedidos</h3>
      <div className="ds-kanban">
        {[
          { title: "Aguardando pgto", n: 3 },
          { title: "Pago", n: 4 },
          { title: "Em separação", n: 2 },
          { title: "Enviado", n: 5 },
        ].map((col) => (
          <div className="ds-kanban-col" key={col.title}>
            <header><span>{col.title}</span><span>{col.n}</span></header>
            {Array.from({ length: 2 }).map((_, i) => (
              <div className="ds-kanban-card" key={i}>
                <div className="row">
                  <span className="title">Pedido #{(12440 + i + col.n).toString()}</span>
                  <span className="value">MT {(150 + i * 88).toFixed(2).replace(".", ",")}</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--ds-text-muted)" }}>Cliente {i + 1} · pix</div>
                <div className="row">
                  <span className="ds-badge ds-badge--neutral">2 itens</span>
                  <span className="ds-avatar ds-avatar--sm">RM</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Settings page */}
      <h3>Settings · layout sidebar + form</h3>
      <div className="ds-card" style={{ padding: 0, display: "grid", gridTemplateColumns: "200px 1fr" }}>
        <nav style={{ borderRight: "1px solid var(--ds-border)", padding: 16, display: "flex", flexDirection: "column", gap: 2 }}>
          {["Conta", "Time", "Canais", "WhatsApp", "Faturamento", "API & Webhooks"].map((n, i) => (
            <button key={n} className="ds-nav-link" data-active={i === 2}>{n}</button>
          ))}
        </nav>
        <div style={{ padding: 24 }}>
          <h3 style={{ marginTop: 0 }}>Canais conectados</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14, border: "1px solid var(--ds-border)", borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 500 }}>WhatsApp Business · Loja Maud</div>
                <div style={{ fontSize: 12, color: "var(--ds-text-muted)" }}>Conectado há 4 meses · 2.143 mensagens</div>
              </div>
              <span className="ds-badge ds-badge--success">ativo</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14, border: "1px solid var(--ds-border)", borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 500 }}>Instagram Direct</div>
                <div style={{ fontSize: 12, color: "var(--ds-text-muted)" }}>Token expirou — reconecte</div>
              </div>
              <button className="ds-btn ds-btn--secondary">Reconectar</button>
            </div>
          </div>
        </div>
      </div>

      {/* Loading + Error states */}
      <h3>Loading · Error</h3>
      <div className="ds-grid-2">
        <div className="ds-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="ds-skel" style={{ width: "50%", height: 16 }} />
          <div className="ds-skel" style={{ width: "90%", height: 12 }} />
          <div className="ds-skel" style={{ width: "75%", height: 12 }} />
          <div className="ds-skel" style={{ width: "40%", height: 12 }} />
        </div>
        <div className="ds-card" style={{ borderColor: "var(--ds-error)" }}>
          <div className="ds-key" style={{ color: "var(--ds-error)" }}>Erro · 503</div>
          <div className="ds-display" style={{ fontSize: 18, fontWeight: 600, marginTop: 6 }}>WhatsApp fora do ar</div>
          <p style={{ fontSize: 13, color: "var(--ds-text-muted)", marginTop: 8, lineHeight: 1.5 }}>
            Não conseguimos conectar ao WAHA neste momento. Tentaremos novamente em 30s.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="ds-btn ds-btn--secondary">Tentar agora</button>
            <button className="ds-btn ds-btn--ghost">Ver status</button>
          </div>
        </div>
      </div>
    </div>
  );
}
