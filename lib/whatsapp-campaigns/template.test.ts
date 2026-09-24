import { describe, expect, it } from "vitest";

import {
  extractTemplateTokens,
  renderCampaignTemplate,
  validateCampaignTemplate,
} from "@/lib/whatsapp-campaigns/template";
import {
  CAMPAIGN_MIN_INTERVAL_FLOOR_SEC,
  isInsideSendWindow,
  nextSendAtIso,
  randomIntervalMs,
} from "@/lib/whatsapp-campaigns/pacing";
import { classifySendError } from "@/lib/whatsapp-campaigns/eligibility";

describe("campaign template", () => {
  it("aceita variáveis conhecidas", () => {
    const r = validateCampaignTemplate("Oi {{first_name}} da {{company_name}}");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens).toEqual(["first_name", "company_name"]);
  });

  it("rejeita token inválido", () => {
    const r = validateCampaignTemplate("Oi {{nome}}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unknown).toContain("nome");
  });

  it("renderiza com snapshot", () => {
    const out = renderCampaignTemplate(
      "Olá, {{first_name}}. Sobre a {{company_name}}.",
      { full_name: "José Silva", company_name: "Globo" },
    );
    expect(out).toBe("Olá, José. Sobre a Globo.");
  });

  it("extrai tokens únicos", () => {
    expect(extractTemplateTokens("{{a}} {{a}} {{full_name}}")).toEqual(["a", "full_name"]);
  });
});

describe("campaign pacing", () => {
  it("respeita piso de intervalo", () => {
    expect(CAMPAIGN_MIN_INTERVAL_FLOOR_SEC).toBe(5);
    const ms = randomIntervalMs(1, 2, () => 0);
    expect(ms).toBeGreaterThanOrEqual(5_000);
  });

  it("nextSendAt fica entre min e max", () => {
    const from = new Date("2026-01-01T12:00:00.000Z");
    const iso = nextSendAtIso(20, 20, from, () => 0);
    expect(new Date(iso).getTime() - from.getTime()).toBe(20_000);
  });

  it("janela de horário no timezone", () => {
    // 12:00 America/Sao_Paulo ≈ 15:00 UTC (sem DST extremo)
    const noonUtcAsSp = new Date("2026-06-15T15:00:00.000Z");
    expect(isInsideSendWindow(noonUtcAsSp, "08:00", "18:00", "America/Sao_Paulo")).toBe(true);
    const night = new Date("2026-06-15T03:00:00.000Z");
    expect(isInsideSendWindow(night, "08:00", "18:00", "America/Sao_Paulo")).toBe(false);
  });
});

describe("classifySendError", () => {
  it("marca opt-out/blocked como permanente", () => {
    expect(classifySendError(new Error("contact blocked")).permanent).toBe(true);
    expect(classifySendError(new Error("opt_out detected")).permanent).toBe(true);
    expect(classifySendError(new Error("invalid phone")).permanent).toBe(true);
  });

  it("timeout como uncertain; 5xx como transitório", () => {
    expect(classifySendError(new Error("WAHA_timeout")).uncertain).toBe(true);
    expect(classifySendError(new Error("waha_503")).permanent).toBe(false);
    expect(classifySendError(new Error("waha_503")).uncertain).toBe(false);
  });
});
