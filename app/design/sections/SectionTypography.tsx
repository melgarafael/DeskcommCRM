"use client";

import { TYPOS } from "../lib/tokens";
import type { TypoId } from "../lib/tokens";
import { useVariant } from "../lib/variant-context";

const TYPO_FONTS: Record<TypoId, { display: string; body: string }> = {
  "bricolage-jakarta": {
    display: "var(--font-bricolage)",
    body: "var(--font-jakarta)",
  },
  "fraunces-manrope": {
    display: "var(--font-fraunces)",
    body: "var(--font-manrope)",
  },
  atkinson: {
    display: "var(--font-atkinson)",
    body: "var(--font-atkinson)",
  },
  "source-plex": {
    display: "var(--font-source-serif)",
    body: "var(--font-plex-sans)",
  },
};

const SAMPLE_PROSE =
  "Pedido #12.443 enviado às 14h32 — cliente respondeu pelo WhatsApp confirmando o endereço de entrega. A IA já sugeriu a próxima ação: pedir comprovante de pagamento via Mpesa.";

function PairBlock({ id }: { id: TypoId }) {
  const v = useVariant();
  const fonts = TYPO_FONTS[id];
  const meta = TYPOS[id];
  const active = v.typo === id;

  return (
    <div style={{ marginBottom: 36 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>
            {meta.name}
            {active && <span className="ds-badge ds-badge--accent" style={{ marginLeft: 10 }}>ativa</span>}
          </h3>
          <p style={{ fontSize: 13, color: "var(--ds-text-muted)", marginTop: 4 }}>
            {meta.description} · escala {meta.scale}
          </p>
        </div>
        <button
          className="ds-btn ds-btn--secondary"
          onClick={() => v.setTypo(id)}
          disabled={active}
        >
          Aplicar par
        </button>
      </div>

      <div className="ds-pair-preview" style={{ fontFamily: fonts.body }}>
        <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 56, lineHeight: 1.05, letterSpacing: "-0.03em" }}>
          Atendimento que escala.
        </div>
        <div style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 36, lineHeight: 1.1, letterSpacing: "-0.02em" }}>
          H2 · Inbox de hoje
        </div>
        <div style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 24 }}>H3 · Pedido em aberto</div>
        <div style={{ fontFamily: fonts.display, fontWeight: 500, fontSize: 18 }}>H4 · Conversa #482</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 6 }}>
          <div>
            <div className="ds-key" style={{ marginBottom: 4 }}>Body · regular</div>
            <p style={{ fontFamily: fonts.body, fontSize: 15, lineHeight: 1.55 }}>{SAMPLE_PROSE}</p>
          </div>
          <div>
            <div className="ds-key" style={{ marginBottom: 4 }}>Body · italic + bold</div>
            <p style={{ fontFamily: fonts.body, fontSize: 15, lineHeight: 1.55 }}>
              <strong>Maria Silva</strong> respondeu <em>&ldquo;já paguei via Mpesa&rdquo;</em> às 14h32.
              Aguardando comprovante automático.
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <div className="ds-key" style={{ marginBottom: 4 }}>Numerais tabulares (financeiro)</div>
            <div style={{ fontFamily: fonts.body, fontVariantNumeric: "tabular-nums lining-nums", fontSize: 15 }}>
              <div>MT 1.234,56</div>
              <div>MT 9.998,01</div>
              <div>MT&nbsp;&nbsp;&nbsp;&nbsp;42,00</div>
            </div>
          </div>
          <div>
            <div className="ds-key" style={{ marginBottom: 4 }}>Numerais proporcionais (texto)</div>
            <div style={{ fontFamily: fonts.body, fontVariantNumeric: "proportional-nums", fontSize: 15 }}>
              <div>1.234 conversas hoje</div>
              <div>98% SLA cumprido</div>
              <div>14h32 · 16h05 · 18h11</div>
            </div>
          </div>
        </div>

        <div className="ds-key">Pesos extremos</div>
        <div style={{ display: "flex", gap: 18, alignItems: "baseline", flexWrap: "wrap", fontFamily: fonts.display }}>
          <span style={{ fontWeight: 300, fontSize: 28 }}>Light 300</span>
          <span style={{ fontWeight: 400, fontSize: 28 }}>Regular 400</span>
          <span style={{ fontWeight: 500, fontSize: 28 }}>Medium 500</span>
          <span style={{ fontWeight: 700, fontSize: 28 }}>Bold 700</span>
          <span style={{ fontWeight: 800, fontSize: 28 }}>Extra 800</span>
        </div>

        <div style={{ fontSize: 13, color: "var(--ds-text-muted)", fontFamily: fonts.body }}>
          small · meta · ts · 12.5px
        </div>
        <div style={{ fontSize: 11, color: "var(--ds-text-muted)", fontFamily: fonts.body, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          caption · status · 11px / 0.08em
        </div>
      </div>
    </div>
  );
}

export function SectionTypography() {
  return (
    <div className="ds-section">
      <h2 className="ds-display">Tipografia</h2>
      <p className="ds-lede">
        Quatro pareamentos avaliados. Critério: legibilidade em 8h-shifts, suporte a numerais tabulares,
        peso extremo disponível, italic real (não slanted). Inter / Geist / Space Grotesk foram banidos
        por saturação em training data.
      </p>

      <PairBlock id="bricolage-jakarta" />
      <PairBlock id="fraunces-manrope" />
      <PairBlock id="atkinson" />
      <PairBlock id="source-plex" />
    </div>
  );
}
