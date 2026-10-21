import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readUiThemeState, readInitialUiThemeState } from "./server";
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

describe("leitura global sem identidade de tenant artificial", () => {
  it("filtra somente o singleton e devolve opções/revisão sem organização", async () => {
    const state = { theme_id: "padrao", installation_id: "builtin-padrao-v1", revision: 2,
      configurations: { padrao: { version: 1, values: {} } } };
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: state, error: null }) }));
    const from = vi.fn(() => ({ select: () => ({ eq }) }));
    expect(await readInitialUiThemeState({ from } as unknown as SupabaseClient)).toEqual({ state, error: null });
    expect(from).toHaveBeenCalledWith("platform_ui_theme_defaults");expect(eq).toHaveBeenCalledWith("id", 1);
  });
  it("ausência é default Padrão; falha e forma inválida não viram configuração pronta para sobrescrever", async () => {
    for (const [data, error, expected] of [[null, null, null], [null, { code: "08006" }, "configuration_unavailable"], [{ revision: "old" }, null, "configuration_invalid"]]) {
      const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) } as unknown as SupabaseClient;
      expect((await readInitialUiThemeState(db)).error).toBe(expected);
    }
  });
});
