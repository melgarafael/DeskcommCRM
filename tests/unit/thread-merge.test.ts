import { describe, expect, it } from "vitest";
import { mergeThreadItems } from "@/components/inbox/ChatThread";

describe("mergeThreadItems", () => {
  it("intercala mensagens e notas por tempo", () => {
    const msgs = [
      { id: "m1", sent_at: "2026-07-23T10:00:00Z" },
      { id: "m2", sent_at: "2026-07-23T10:02:00Z" },
    ] as never;
    const notes = [{ id: "n1", created_at: "2026-07-23T10:01:00Z" }] as never;
    const out = mergeThreadItems(msgs, notes);
    expect(out.map((i) => i.data.id)).toEqual(["m1", "n1", "m2"]);
    expect(out[1]!.kind).toBe("note");
  });

  it("sem notas → só mensagens", () => {
    const msgs = [{ id: "m1", sent_at: "2026-07-23T10:00:00Z" }] as never;
    expect(mergeThreadItems(msgs, []).every((i) => i.kind === "message")).toBe(true);
  });

  it("empate de timestamp mantém ordem estável (mensagem antes da nota)", () => {
    const msgs = [{ id: "m1", sent_at: "2026-07-23T10:00:00Z" }] as never;
    const notes = [{ id: "n1", created_at: "2026-07-23T10:00:00Z" }] as never;
    const out = mergeThreadItems(msgs, notes);
    expect(out.map((i) => i.data.id)).toEqual(["m1", "n1"]);
  });

  it("array vazio de ambos retorna vazio", () => {
    expect(mergeThreadItems([], [])).toEqual([]);
  });
});
