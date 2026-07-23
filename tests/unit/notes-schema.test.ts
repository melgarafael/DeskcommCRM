import { describe, expect, it } from "vitest";

import { createNoteSchema } from "@/lib/schemas/notes";

describe("createNoteSchema", () => {
  it("aceita body válido", () => {
    expect(createNoteSchema.safeParse({ body: "oi" }).success).toBe(true);
  });
  it("rejeita body vazio", () => {
    expect(createNoteSchema.safeParse({ body: "" }).success).toBe(false);
  });
  it("rejeita body gigante (>4096)", () => {
    expect(createNoteSchema.safeParse({ body: "a".repeat(4097) }).success).toBe(false);
  });
});
