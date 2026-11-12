import { describe, expect, it } from "vitest";

import { atualizarAgendamentoSchema, criarAgendamentoSchema } from "./schemas";

const UNIT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("criarAgendamentoSchema", () => {
  it("aceita payload válido com cliente novo", () => {
    const r = criarAgendamentoSchema.safeParse({
      unit_id: UNIT,
      scheduled_at: "2026-11-12T12:00:00.000Z",
      duration_minutes: 20,
      client_name: "Maria",
      client_phone: "11999998888",
      consultant_auto: true,
    });
    expect(r.success).toBe(true);
  });

  it("recusa sem contato e sem nome/telefone", () => {
    const r = criarAgendamentoSchema.safeParse({
      unit_id: UNIT,
      scheduled_at: "2026-11-12T12:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("recusa scheduled_at sem offset", () => {
    const r = criarAgendamentoSchema.safeParse({
      unit_id: UNIT,
      scheduled_at: "2026-11-12T12:00:00",
      client_name: "Maria",
      client_phone: "11999998888",
    });
    expect(r.success).toBe(false);
  });
});

describe("atualizarAgendamentoSchema", () => {
  it("descarta client_name/client_phone/consultant_auto — não são colunas da tabela", () => {
    const r = atualizarAgendamentoSchema.safeParse({
      unit_id: UNIT,
      scheduled_at: "2026-11-12T12:00:00.000Z",
      duration_minutes: 20,
      client_name: "Maria",
      client_phone: "11999998888",
      consultant_auto: true,
      notes: "ok",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).not.toHaveProperty("client_name");
    expect(r.data).not.toHaveProperty("client_phone");
    expect(r.data).not.toHaveProperty("consultant_auto");
    expect(r.data.notes).toBe("ok");
    expect(r.data.unit_id).toBe(UNIT);
  });

  it("recusa corpo vazio", () => {
    const r = atualizarAgendamentoSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});
