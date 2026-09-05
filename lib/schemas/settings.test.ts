import { describe, it, expect } from "vitest";

import {
  profileSchema,
  tenantSchema,
  notificationPrefsSchema,
  pipelineConfigPatchSchema,
} from "./settings";

describe("profileSchema", () => {
  it("accepts pt-BR locale + valid timezone", () => {
    const r = profileSchema.safeParse({
      full_name: "Rafael",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
      avatar_url: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown locale", () => {
    const r = profileSchema.safeParse({
      full_name: "x",
      locale: "fr-FR",
      timezone: "America/Sao_Paulo",
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid avatar_url", () => {
    const r = profileSchema.safeParse({
      locale: "pt-BR",
      timezone: "UTC",
      avatar_url: "not a url",
    });
    expect(r.success).toBe(false);
  });

  it("coerces empty avatar_url to null", () => {
    const r = profileSchema.safeParse({
      locale: "pt-BR",
      timezone: "UTC",
      avatar_url: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.avatar_url).toBeNull();
  });
});

describe("tenantSchema", () => {
  it("accepts a minimal valid tenant payload", () => {
    const r = tenantSchema.safeParse({
      display_name: "Acme",
      legal_name: "Acme LTDA",
      cnpj: "12345678000190",
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      currency: "BRL",
      media_retention_days: 90,
      dpo_email: "dpo@acme.com",
      privacy_policy_url: "https://acme.com/privacy",
      lost_reasons_extra: ["Sem orçamento"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects too-low retention", () => {
    const r = tenantSchema.safeParse({
      display_name: "Acme",
      legal_name: "Acme",
      timezone: "UTC",
      locale: "pt-BR",
      media_retention_days: 5,
      lost_reasons_extra: [],
    });
    expect(r.success).toBe(false);
  });

  it("defaults lost_reasons_extra to empty array", () => {
    const r = tenantSchema.safeParse({
      display_name: "Acme",
      legal_name: "Acme",
      timezone: "UTC",
      locale: "pt-BR",
      currency: "BRL",
      media_retention_days: 90,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lost_reasons_extra).toEqual([]);
  });

  /**
   * ⚠️ `currency` e OBRIGATORIA de proposito, e o contrario seria pior.
   *
   * Com `.default("BRL")`, qualquer salvamento que omitisse o campo — um
   * chamador novo, um payload montado a mao — PISARIA a moeda de uma
   * organizacao mexicana em silencio, porque a action grava a linha inteira.
   * Sao dois chamadores conhecidos (o formulario e a propria action), os dois
   * mandam o campo, e quem esquecer falha ALTO em vez de trocar a unidade do
   * catalogo sem avisar.
   */
  it("exige a moeda em vez de assumir uma", () => {
    const r = tenantSchema.safeParse({
      display_name: "Acme",
      legal_name: "Acme",
      timezone: "UTC",
      locale: "pt-BR",
      media_retention_days: 90,
    });
    expect(r.success).toBe(false);
  });
});

describe("notificationPrefsSchema", () => {
  it("accepts a list of category/channel/enabled tuples", () => {
    const r = notificationPrefsSchema.safeParse({
      prefs: [{ category: "lead_assigned", channel: "email", enabled: true }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown category", () => {
    const r = notificationPrefsSchema.safeParse({
      prefs: [{ category: "bogus", channel: "email", enabled: true }],
    });
    expect(r.success).toBe(false);
  });
});

describe("pipelineConfigPatchSchema", () => {
  it("accepts partial vocabulary patch", () => {
    const r = pipelineConfigPatchSchema.safeParse({
      vocabulary: { lead: "Cliente", won: "Pago" },
    });
    expect(r.success).toBe(true);
  });

  it("validates field key shape", () => {
    const r = pipelineConfigPatchSchema.safeParse({
      fields: [{ key: "1bad", label: "x", type: "text" }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts well-formed fields", () => {
    const r = pipelineConfigPatchSchema.safeParse({
      fields: [{ key: "size", label: "Tamanho", type: "text" }],
      lost_reasons: ["Concorrente", "Preço"],
    });
    expect(r.success).toBe(true);
  });
});
