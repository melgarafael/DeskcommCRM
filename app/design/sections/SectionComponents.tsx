"use client";

import { useState } from "react";

function Stack({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="ds-key" style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10 }}>{label}</div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

export function SectionComponents() {
  const [showModal, setShowModal] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [tab, setTab] = useState("inbox");
  const [loading, setLoading] = useState(false);

  return (
    <div className="ds-section">
      <h2 className="ds-display">Componentes</h2>
      <p className="ds-lede">
        Estados completos: default, hover, focus, active, disabled, loading, error.
        Componentes reagem em runtime ao paleta/tipografia/densidade selecionados.
      </p>

      {/* Buttons */}
      <h3>Buttons</h3>
      <div className="ds-card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <Stack label="Variants">
          <button className="ds-btn ds-btn--primary">Confirmar envio</button>
          <button className="ds-btn ds-btn--secondary">Cancelar</button>
          <button className="ds-btn ds-btn--ghost">Adiar</button>
          <button className="ds-btn ds-btn--destructive">Excluir conversa</button>
          <button className="ds-btn ds-btn--link">ver detalhes</button>
        </Stack>
        <Stack label="Estados">
          <button className="ds-btn ds-btn--primary">Default</button>
          <button className="ds-btn ds-btn--primary" disabled>Disabled</button>
          <button
            className="ds-btn ds-btn--primary"
            onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1400); }}
            disabled={loading}
          >
            {loading ? <span className="ds-spinner" /> : null}
            {loading ? "Enviando…" : "Loading test"}
          </button>
        </Stack>
      </div>

      {/* Inputs */}
      <h3>Inputs</h3>
      <div className="ds-card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <div>
          <label className="ds-label">E-mail do cliente</label>
          <input className="ds-input" placeholder="maria@empresa.com.br" />
        </div>
        <div>
          <label className="ds-label">Nome</label>
          <input className="ds-input" defaultValue="Maria Silva" />
        </div>
        <div>
          <label className="ds-label">Buscar conversa</label>
          <div style={{ position: "relative" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--ds-text-muted)" }}>
              <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
            </svg>
            <input className="ds-input" placeholder="pedido, cliente, telefone…" style={{ paddingLeft: 32 }} />
          </div>
        </div>
        <div>
          <label className="ds-label">NUIT (com erro)</label>
          <input className="ds-input" defaultValue="000.000.000-00" aria-invalid="true" />
          <span style={{ color: "var(--ds-error)", fontSize: 11.5, marginTop: 4, display: "block" }}>NUIT inválido — verifique os dígitos.</span>
        </div>
        <div>
          <label className="ds-label">Disabled</label>
          <input className="ds-input" defaultValue="bloqueado" disabled />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label className="ds-label">Resposta</label>
          <textarea className="ds-input" rows={4} placeholder="Digite sua resposta…" style={{ height: "auto", padding: 12, resize: "vertical" }} />
        </div>
      </div>

      {/* Badges */}
      <h3>Badges (status pill)</h3>
      <div className="ds-card ds-row">
        <span className="ds-badge ds-badge--neutral"><span className="dot" style={{ background: "var(--ds-text-muted)" }} />open</span>
        <span className="ds-badge ds-badge--info"><span className="dot" style={{ background: "var(--ds-info)" }} />pending</span>
        <span className="ds-badge ds-badge--success"><span className="dot" style={{ background: "var(--ds-success)" }} />resolved</span>
        <span className="ds-badge ds-badge--accent"><span className="dot" style={{ background: "var(--ds-accent)" }} />won</span>
        <span className="ds-badge ds-badge--error"><span className="dot" style={{ background: "var(--ds-error)" }} />lost</span>
        <span className="ds-badge ds-badge--warning"><span className="dot" style={{ background: "var(--ds-warning)" }} />SLA</span>
      </div>

      {/* Avatars */}
      <h3>Avatar</h3>
      <div className="ds-card ds-row">
        <span className="ds-avatar ds-avatar--sm">RM</span>
        <span className="ds-avatar">MS<span className="ds-avatar-status" /></span>
        <span className="ds-avatar ds-avatar--lg">JP</span>
        <div className="ds-avatar-group">
          <span className="ds-avatar">MS</span>
          <span className="ds-avatar" style={{ background: "color-mix(in srgb, var(--ds-info) 18%, transparent)", color: "var(--ds-info)" }}>JP</span>
          <span className="ds-avatar" style={{ background: "color-mix(in srgb, var(--ds-warning) 18%, transparent)", color: "var(--ds-warning)" }}>+3</span>
        </div>
      </div>

      {/* Cards */}
      <h3>Cards</h3>
      <div className="ds-grid-3">
        <div className="ds-card">
          <div className="ds-key">Receita do dia</div>
          <div className="ds-display" style={{ fontSize: 28, fontWeight: 600, marginTop: 6 }}>MT 12.443,00</div>
          <div style={{ fontSize: 12, color: "var(--ds-success)", marginTop: 4 }}>+8.4% vs ontem</div>
        </div>
        <div className="ds-card ds-card--interactive">
          <div className="ds-key">Conversas abertas</div>
          <div className="ds-display" style={{ fontSize: 28, fontWeight: 600, marginTop: 6 }}>27</div>
          <div style={{ fontSize: 12, color: "var(--ds-text-muted)", marginTop: 4 }}>hover para abrir →</div>
        </div>
        <div className="ds-card">
          <div className="ds-key">SLA</div>
          <div className="ds-display" style={{ fontSize: 28, fontWeight: 600, marginTop: 6 }}>97.2%</div>
          <div style={{ fontSize: 12, color: "var(--ds-warning)", marginTop: 4 }}>3 conversas próximas do limite</div>
        </div>
      </div>

      {/* ConversationItem + KanbanCard */}
      <h3>ConversationItem · KanbanCard · MessageBubble</h3>
      <div className="ds-grid-2">
        <div>
          <div className="ds-key" style={{ marginBottom: 8 }}>ConversationItem</div>
          <div className="ds-list">
            <div className="ds-list-item">
              <div className="ds-avatar">MS<span className="ds-avatar-status" /></div>
              <div className="body">
                <div className="title">Maria Silva</div>
                <div className="preview">Confirmando o endereço de entrega…</div>
              </div>
              <div className="meta">
                <span className="ts">14h32</span>
                <span className="ds-badge ds-badge--accent">novo</span>
              </div>
            </div>
            <div className="ds-list-item">
              <div className="ds-avatar">JP</div>
              <div className="body">
                <div className="title">João Pereira</div>
                <div className="preview">Já fiz o Mpesa, segue o comprovante…</div>
              </div>
              <div className="meta">
                <span className="ts">14h28</span>
              </div>
            </div>
          </div>
        </div>
        <div>
          <div className="ds-key" style={{ marginBottom: 8 }}>KanbanCard</div>
          <div className="ds-kanban-card" style={{ background: "var(--ds-surface)" }}>
            <div className="row">
              <span className="title">Pedido #12.443</span>
              <span className="value">MT 1.234,56</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--ds-text-muted)" }}>Maria Silva · cliente recorrente</div>
            <div className="row">
              <div className="tags">
                <span className="ds-badge ds-badge--info">pix</span>
                <span className="ds-badge ds-badge--warning">sla&lt;1h</span>
              </div>
              <span className="ds-avatar ds-avatar--sm">RM</span>
            </div>
          </div>
        </div>
      </div>

      <div className="ds-card" style={{ marginTop: 16 }}>
        <div className="ds-key" style={{ marginBottom: 12 }}>MessageBubble</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 480 }}>
          <div className="ds-bubble in">Oi! Confirma pra mim o endereço da entrega? Quero ver se está certo.</div>
          <div className="ds-bubble out">
            Claro Maria, é Rua das Acácias 144, apto 23 — Vila Madalena. Pode confirmar?
            <div className="meta">14h32 · ✓✓</div>
          </div>
          <div className="ds-bubble in">Perfeito! Pode enviar.</div>
        </div>
      </div>

      {/* Tabs */}
      <h3>Tabs</h3>
      <div className="ds-card">
        <div className="ds-tabs">
          {([["inbox", "Inbox"], ["pedidos", "Pedidos"], ["clientes", "Clientes"], ["relatorios", "Relatórios"]] as const).map(([id, label]) => (
            <button key={id} className="ds-tab" data-active={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ padding: "20px 4px", fontSize: 13.5, color: "var(--ds-text-muted)" }}>
          Conteúdo da aba <span className="ds-mono" style={{ color: "var(--ds-accent)" }}>/{tab}</span>.
        </div>
      </div>

      {/* Tooltip + Modal + Toast triggers */}
      <h3>Tooltip · Modal · Toast</h3>
      <div className="ds-card ds-row">
        <span className="ds-tooltip-host">
          <button className="ds-btn ds-btn--secondary">Hover para tooltip</button>
          <span className="ds-tooltip">Atalho: ⌘K</span>
        </span>
        <button className="ds-btn ds-btn--primary" onClick={() => setShowModal(true)}>Abrir modal</button>
        <button className="ds-btn ds-btn--secondary" onClick={() => { setShowToast(true); setTimeout(() => setShowToast(false), 2600); }}>
          Disparar toast
        </button>
      </div>

      {/* Skeleton */}
      <h3>Skeleton</h3>
      <div className="ds-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="ds-skel" style={{ width: "60%", height: 16 }} />
        <div className="ds-skel" style={{ width: "85%", height: 12 }} />
        <div className="ds-skel" style={{ width: "40%", height: 12 }} />
        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <div className="ds-skel" style={{ width: 32, height: 32, borderRadius: "50%" }} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="ds-skel" style={{ width: "30%", height: 14 }} />
            <div className="ds-skel" style={{ width: "70%", height: 12 }} />
          </div>
        </div>
      </div>

      {/* Empty */}
      <h3>Empty state</h3>
      <div className="ds-empty">
        <div className="marker">∅ · sem conversas</div>
        <div className="ds-display" style={{ fontSize: 18, fontWeight: 600 }}>Tudo em dia.</div>
        <div style={{ fontSize: 13, color: "var(--ds-text-muted)", maxWidth: 360 }}>
          Você zerou a inbox. Aproveite o silêncio — ele costuma durar pouco em e-commerce.
        </div>
        <button className="ds-btn ds-btn--ghost" style={{ marginTop: 6 }}>Ver pedidos pendentes</button>
      </div>

      {/* Floating modal */}
      {showModal && (
        <div className="ds-modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ds-display" style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>
              Arquivar conversa?
            </div>
            <p style={{ fontSize: 13.5, color: "var(--ds-text-muted)", marginBottom: 18 }}>
              A conversa com Maria Silva será movida para o histórico. Você pode restaurá-la a qualquer momento.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="ds-btn ds-btn--ghost" onClick={() => setShowModal(false)}>Cancelar</button>
              <button className="ds-btn ds-btn--primary" onClick={() => setShowModal(false)}>Arquivar</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {showToast && (
        <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 50 }}>
          <div className="ds-toast">
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ds-success)", marginTop: 6 }} />
            <div>
              <div style={{ fontWeight: 500, fontSize: 13.5 }}>Mensagem enviada</div>
              <div style={{ fontSize: 12, color: "var(--ds-text-muted)" }}>Maria Silva · WhatsApp</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
