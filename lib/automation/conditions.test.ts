import { describe, it, expect } from "vitest";
import { evaluateConditions, resolveField } from "@/lib/automation/conditions";

const ctx = {
  event: { to_stage_id: "s2", added_tags: ["vip", "novo"] },
  lead: { title: "Ana", custom_fields: { utm_source: "instagram" }, value_cents: 5000 },
};

describe("resolveField", () => {
  it("path aninhado", () => expect(resolveField(ctx, "lead.custom_fields.utm_source")).toBe("instagram"));
  it("path ausente → undefined", () => expect(resolveField(ctx, "lead.nope.x")).toBeUndefined());
});

describe("evaluateConditions", () => {
  it("lista vazia → true (regra sem condição dispara sempre)", () =>
    expect(evaluateConditions([], ctx)).toBe(true));
  it("eq string", () =>
    expect(evaluateConditions([{ field: "event.to_stage_id", op: "eq", value: "s2" }], ctx)).toBe(true));
  it("eq com coerção numérica (valor sempre chega como string da UI)", () =>
    expect(evaluateConditions([{ field: "lead.value_cents", op: "eq", value: "5000" }], ctx)).toBe(true));
  it("neq", () =>
    expect(evaluateConditions([{ field: "event.to_stage_id", op: "neq", value: "s1" }], ctx)).toBe(true));
  it("contains em array", () =>
    expect(evaluateConditions([{ field: "event.added_tags", op: "contains", value: "vip" }], ctx)).toBe(true));
  it("contains em string (case-insensitive)", () =>
    expect(evaluateConditions([{ field: "lead.custom_fields.utm_source", op: "contains", value: "INSTA" }], ctx)).toBe(true));
  it("E entre múltiplas: uma falsa derruba", () =>
    expect(
      evaluateConditions(
        [
          { field: "event.to_stage_id", op: "eq", value: "s2" },
          { field: "lead.title", op: "eq", value: "Bia" },
        ],
        ctx,
      ),
    ).toBe(false));
  it("campo ausente → condição falsa, não erro", () =>
    expect(evaluateConditions([{ field: "lead.ghost", op: "eq", value: "x" }], ctx)).toBe(false));
  it("campo ausente com neq → true (ausente ≠ valor)", () =>
    expect(evaluateConditions([{ field: "lead.ghost", op: "neq", value: "x" }], ctx)).toBe(true));
});
