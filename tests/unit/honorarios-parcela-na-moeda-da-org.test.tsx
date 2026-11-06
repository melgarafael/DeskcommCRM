/**
 * A PARCELA DE HONORÁRIOS SE EXIBE NA MOEDA DELA (#3379).
 *
 * A tabela de `app/app/honorarios/_parcelas.tsx` escrevia
 * `formatCents(p.valor_cents, "BRL")` — moeda fixa no código. Numa organização
 * em USD a parcela gravada como 130000 centavos aparecia `R$ 1.300,00`: o número
 * certo com o rótulo de outra unidade, que é o pior dos dois mundos porque
 * parece certo.
 *
 * ─── Por que o dublê é o TRANSPORTE, e não a prop ──────────────────────────
 *
 * O alvo é o que chega ao olho a partir do que a API devolve. Dublar o
 * componente ou injetar a linha por prop provaria só que ele obedece ao campo
 * inventado pelo teste. Aqui `apiClient` (a borda HTTP) devolve duas parcelas —
 * uma em USD, uma em BRL — e a asserção é sobre o texto da linha.
 *
 * O caso em BRL é VERDE antes e depois, de propósito: é a prova de que quem só
 * opera em real não vê diferença.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const espiao = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({ apiClient: { get: espiao.get, post: espiao.post } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
// A régua de DIGITAÇÃO já lê a moeda da organização desde o #3378; aqui o
// assunto é o RÓTULO da linha, então o leitor de sessão só precisa existir.
vi.mock("@/hooks/auth/AuthProvider", () => ({ useMoedaDaOrgAtiva: () => "USD" }));

import { Parcelas } from "@/app/app/honorarios/_parcelas";

const CONTRATO = "55555555-5555-4555-8555-555555555555";

/** O `Intl` separa símbolo e número com espaço inseparável; o teste lê espaço. */
const semNbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

function montar(parcelas: unknown[]) {
  espiao.get.mockImplementation(async (url: string) => {
    if (url.includes("/parcelas")) return { data: parcelas };
    return { data: [] };
  });

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const envolver = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  return render(<Parcelas contratoId={CONTRATO} podeGerenciar={false} />, {
    wrapper: envolver,
  });
}

function parcela(id: string, currency: string, valor_cents: number, vencimento: string) {
  return {
    id,
    contrato_id: CONTRATO,
    numero: 1,
    vencimento,
    valor_cents,
    currency,
    financial_entry_id: null,
    status: "pendente",
  };
}

beforeEach(() => vi.clearAllMocks());

describe("parcelas de honorários na tela", () => {
  it("a parcela em dólar sai em dólar, e não em real", async () => {
    montar([parcela("p-usd", "USD", 130000, "2026-11-10")]);

    const linha = semNbsp((await screen.findByText("$1,300.00", { exact: false })).closest("tr")!.textContent ?? "");
    expect(linha).toContain("$1,300.00");
    expect(linha).not.toContain("R$");
  });

  it("a parcela em real continua saindo em real — nada muda", async () => {
    montar([parcela("p-brl", "BRL", 50000, "2026-11-10")]);

    const linha = semNbsp((await screen.findByText("R$ 500,00", { exact: false })).closest("tr")!.textContent ?? "");
    expect(linha).toContain("R$ 500,00");
  });
});
