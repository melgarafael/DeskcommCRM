/**
 * O VETO `followup_cap` ADIA O TURNO, COMO OS OUTROS TETOS DO DIA (#4063).
 *
 * O defeito que este arquivo vigia: o código novo só nasce num follow-up (chave
 * "Teto do dia só na abordagem" ligada, `abordagem: false`), e o turno reagendava
 * só `warmup_cap`/`daily_cap`. No 201º follow-up do dia o job terminava sem
 * mensagem e sem ser adiado, o mesmo buraco medido em produção em 2026-08-29.
 *
 * Prova as três pontas: o motor emite o código com `nextAllowedAt`; `eTetoDoDia`
 * o reconhece, e é ela que o turno consulta; a tela o lê como ritmo e diz que a
 * mensagem volta amanhã, em pt e es.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { grupoDoAdiamento } from "@/lib/followup/adiamento-legivel";
import { traduzir } from "@/lib/i18n/dicionario";
import { retentionCopy } from "@/lib/inbox/retention-copy";

import { PACING_DEFAULTS } from "./defaults";
import { decidePacing, eTetoDoDia } from "./engine";

// Terça, 10h em São Paulo.
const AGORA = new Date("2026-11-10T13:00:00Z");

describe("o motor emite followup_cap com hora de volta", () => {
  it("200 follow-ups no dia, chave ligada: o 201º é vetado com nextAllowedAt no futuro", () => {
    const d = decidePacing({
      now: AGORA,
      knobs: { ...PACING_DEFAULTS, tetoSoAbordagem: true },
      state: { lastSentAt: null, sentToday: 200, abordagensToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
      abordagem: false,
      rng: () => 0,
    });
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.code).toBe("followup_cap");
    expect(d.nextAllowedAt.getTime()).toBeGreaterThan(AGORA.getTime());
    expect(eTetoDoDia(d.code)).toBe(true);
  });
});

describe("eTetoDoDia — quais vetos adiam o turno", () => {
  it("os três tetos do dia adiam; a janela tem caminho próprio; código alheio não", () => {
    expect(eTetoDoDia("warmup_cap")).toBe(true);
    expect(eTetoDoDia("daily_cap")).toBe(true);
    expect(eTetoDoDia("followup_cap")).toBe(true);
    expect(eTetoDoDia("outside_window")).toBe(false);
    expect(eTetoDoDia("mass_identical")).toBe(false);
    expect(eTetoDoDia("toString")).toBe(false);
  });

  it("o turno guarda o veto para reagendar pela MESMA função", () => {
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
      "utf8",
    );
    const i = fonte.indexOf("pacingCapVeto = { code: chain.code, nextAllowedAt: chain.nextAllowedAt }");
    expect(i, "não achei onde o turno guarda o veto de teto").toBeGreaterThan(0);
    const condicao = fonte.slice(Math.max(0, i - 200), i);
    expect(condicao).toMatch(/eTetoDoDia\(chain\.code\)\s*&&\s*chain\.nextAllowedAt !== undefined/);
  });
});

describe("a tela lê followup_cap como ritmo e diz quando volta", () => {
  const ctx = { window_start_hour: 8, window_end_hour: 21, allow_sunday: true, timezone: "America/Sao_Paulo" };

  it("o adiamento do follow-up cai em 'ritmo', não em 'generico'", () => {
    expect(grupoDoAdiamento("followup_cap", false)).toBe("ritmo");
  });

  it("pt: proteção, volta amanhã; nunca 'não foi enviada'", () => {
    const r = retentionCopy("followup_cap", ctx);
    expect(r.kind).toBe("protection");
    expect(r.description).toContain("volta amanhã, a partir das 8h");
    expect(r.description).not.toContain("não foi enviada");
  });

  it("es: a frase tem tradução (não cai no pt)", () => {
    const r = retentionCopy("followup_cap", ctx, (texto) => traduzir(texto, "es"));
    expect(r.description).toContain("vuelve mañana");
  });
});
