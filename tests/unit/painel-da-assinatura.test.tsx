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

const PLANO = { id: "plano-a", nome: "Básico", preco_cents: 4990, intervalo: "mes", max_assentos: 1, max_canais: null, teto_ia_usd_cents: 500 };
const ASSINATURA_EM_TESTE: NonNullable<DadosDoPainel["assinatura"]> = {
  estado: "trial", trial_ate: "2026-10-10T12:00:00Z", prazo_extra_ate: null, proximo_vencimento: null, vencida_desde: null,
  cancela_no_fim: false, modo: null, provedor: null, link_de_pagamento: null, assinaturas_vivas: 0, plano_agendado: null,
};
const EM_TESTE: DadosDoPainel = {
  assinatura: ASSINATURA_EM_TESTE,
  plano: PLANO,
  uso: { assentos: 1, canais: 2 },
  gastoIaUsdCents: 120,
  planosParaTroca: [],
  fuso: null,
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
    render(<PainelDaAssinatura dados={{ ...EM_TESTE, assinatura: { ...ASSINATURA_EM_TESTE, estado: "ativa", trial_ate: null } }} idioma="pt-BR" />);
    expect(screen.getByText("Em dia")).toBeTruthy();
    expect(screen.queryByText(/Teste grátis até/)).toBeNull();
  });

  it("fala espanhol", () => {
    render(<PainelDaAssinatura dados={{ ...EM_TESTE, assinatura: null, plano: null }} idioma="es" />);
    expect(screen.getByText("Tu empresa no tiene plan de cobro: no paga y no tiene límites.")).toBeTruthy();
  });

  it("a virada de dia é a da empresa: 23h em São Paulo (02h UTC) continua no mesmo dia", () => {
    const dados = { ...EM_TESTE, assinatura: { ...ASSINATURA_EM_TESTE, trial_ate: "2026-10-11T02:00:00Z" } };
    const { unmount } = render(<PainelDaAssinatura dados={dados} idioma="pt-BR" />);
    expect(screen.getByText(/^Teste grátis até 10\/10\/2026/)).toBeTruthy();
    unmount();
    // fuso gravado ilegível cai no padrão em vez de derrubar a tela
    render(<PainelDaAssinatura dados={{ ...dados, fuso: "Marte/Olimpo" }} idioma="pt-BR" />);
    expect(screen.getByText(/^Teste grátis até 10\/10\/2026/)).toBeTruthy();
  });
});
