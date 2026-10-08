/**
 * /app/settings/billing com a cobrança ligada (spec da cobrança §9): o estado em
 * linguagem simples e o uso contra os limites. Só leitura na PR 2 — pagar,
 * trocar e cancelar chegam com o provedor (PR 3a).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PainelDaAssinatura } from "@/components/cobranca/PainelDaAssinatura";
import type { DadosDoPainel } from "@/lib/cobranca/painel";

afterEach(cleanup);

const PLANO = { nome: "Básico", preco_cents: 4990, intervalo: "mes", max_assentos: 1, max_canais: null, teto_ia_usd_cents: 500 };
const EM_TESTE: DadosDoPainel = {
  assinatura: { estado: "trial", trial_ate: "2026-10-10T12:00:00Z", prazo_extra_ate: null },
  plano: PLANO,
  uso: { assentos: 1, canais: 2 },
  gastoIaUsdCents: 120,
};

describe("PainelDaAssinatura", () => {
  it("isenta: diz que não paga e não tem limites", () => {
    render(<PainelDaAssinatura dados={{ ...EM_TESTE, assinatura: null, plano: null }} idioma="pt-BR" />);
    expect(screen.getByText("Sua empresa não tem plano de cobrança: não paga e não tem limites.")).toBeTruthy();
  });

  it("em teste: o plano, a data do fim do teste e o uso contra os limites", () => {
    const { container } = render(<PainelDaAssinatura dados={EM_TESTE} idioma="pt-BR" />);
    expect(screen.getByRole("heading").textContent).toContain("Básico");
    expect(screen.getByText(/^Teste grátis até /)).toBeTruthy();
    expect(container.querySelector('[data-uso="assentos"]')?.textContent).toBe("1 de 1");
    expect(container.querySelector('[data-uso="canais"]')?.textContent).toBe("2 · sem limite");
    expect(container.querySelector('[data-uso="ia"]')?.textContent).toContain("US$");
  });

  it("em dia: o rótulo do estado, sem data de teste", () => {
    render(<PainelDaAssinatura dados={{ ...EM_TESTE, assinatura: { estado: "ativa", trial_ate: null, prazo_extra_ate: null } }} idioma="pt-BR" />);
    expect(screen.getByText("Em dia")).toBeTruthy();
    expect(screen.queryByText(/Teste grátis até/)).toBeNull();
  });

  it("fala espanhol", () => {
    render(<PainelDaAssinatura dados={{ ...EM_TESTE, assinatura: null, plano: null }} idioma="es" />);
    expect(screen.getByText("Tu empresa no tiene plan de cobro: no paga y no tiene límites.")).toBeTruthy();
  });
});
