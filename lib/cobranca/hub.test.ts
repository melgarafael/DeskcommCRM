import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ler: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/cobranca/painel", () => ({ lerPainelDaAssinatura: h.ler }));
vi.mock("@/lib/logger", () => ({ logger: { error: h.logError } }));

import { lerPainelDoHub, oQueOHubMostra } from "./hub";

describe("o que o hub da conta suspensa mostra", () => {
  it.each([
    [{ administra: true, tipo: "cobranca", cobrancaLigada: true, temAssinatura: true }, "pagamento"],
    [{ administra: false, tipo: "cobranca", cobrancaLigada: true, temAssinatura: true }, "avise_o_admin"],
    [{ administra: true, tipo: "administrativa", cobrancaLigada: true, temAssinatura: true }, "contato"],
    [{ administra: true, tipo: "cobranca", cobrancaLigada: false, temAssinatura: true }, "contato"],
    [{ administra: true, tipo: "cobranca", cobrancaLigada: true, temAssinatura: false }, "contato"],
    [{ administra: false, tipo: "administrativa", cobrancaLigada: false, temAssinatura: false }, "avise_o_admin"],
  ] as const)("%j → %s", (entrada, esperado) => {
    expect(oQueOHubMostra(entrada)).toBe(esperado);
  });
});

describe("lerPainelDoHub — a falha da leitura do painel não derruba o hub", () => {
  const admin = {} as SupabaseClient;

  it("⭐ leitura que lança: devolve null (o hub cai para 'contato', sem botão de pagar) e loga o erro", async () => {
    h.ler.mockRejectedValue(new Error("cobranca: uso ilegível"));
    const painel = await lerPainelDoHub(admin, "org-1");
    expect(painel).toBeNull();
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(oQueOHubMostra({ administra: true, tipo: "cobranca", cobrancaLigada: true, temAssinatura: painel?.assinatura != null })).toBe("contato");
  });

  it("leitura que funciona: devolve o painel", async () => {
    h.ler.mockResolvedValue({ assinatura: null });
    expect(await lerPainelDoHub(admin, "org-1")).toEqual({ assinatura: null });
  });
});
