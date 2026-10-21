import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readUiThemeState } from "./server";
describe("leitura scoped e falha explícita de configuração", () => {
  it("filtra a organização confiável mesmo quando recebe cliente privilegiado", async () => {
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: null, error: null }) }));
    const from = vi.fn(() => ({ select: () => ({ eq }) }));
    const db = { from } as unknown as SupabaseClient;
    expect(await readUiThemeState(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toEqual({
      state: null,
      error: null,
    });
    expect(from).toHaveBeenCalledWith("organization_ui_themes");
    expect(eq).toHaveBeenCalledWith("organization_id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
  it("erro de transporte não vira configuração vazia pronta para sobrescrever", async () => {
    const db = {
      from: () => {
        throw new Error("transport");
      },
    } as unknown as SupabaseClient;
    expect(await readUiThemeState(db, "tenant")).toEqual({
      state: null,
      error: "configuration_unavailable",
    });
  });
  it("revisão ou envelope malformado têm erro e não são aceitos como primeira gravação", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { revision: "old" }, error: null }) }),
        }),
      }),
    } as unknown as SupabaseClient;
    expect(await readUiThemeState(db, "tenant")).toEqual({
      state: null,
      error: "configuration_invalid",
    });
  });
});
