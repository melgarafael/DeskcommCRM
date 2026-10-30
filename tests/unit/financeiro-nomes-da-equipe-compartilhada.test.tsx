import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get } }));

import { Faturamento } from "@/app/app/faturamento/_client";
import { CatalogoFinanceiro } from "@/app/app/settings/tenant/financeiro/_client";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";

// O contrato real não oferece e-mail: o nome permitido vem em full_name.
const equipe = [
  { user_id: "pessoa-azul", full_name: "Técnica Azul", role: "agent" },
  { user_id: "pessoa-sem-nome", full_name: null, role: "agent" },
];
const responsaveis = ["pessoa-azul", "pessoa-sem-nome", "pessoa-desconhecida", null];

function InboxComEquipe() {
  const membros = useAssignableMembers(true);
  return <p>{membros.isSuccess ? "Equipe carregada no atendimento" : "Carregando equipe"}</p>;
}

async function atendimentoNoMesmoCache() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = render(<InboxComEquipe />, { wrapper });
  await screen.findByText("Equipe carregada no atendimento");
  return view;
}

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url === "/api/v1/team/assignable") return { data: equipe };
    if (url.endsWith("/regras_de_comissao"))
      return {
        data: responsaveis
          .filter((id) => id !== null)
          .map((id, i) => ({
            id: `regra-${i}`,
            name: "Rótulo anterior",
            attendant_user_id: id,
            event_type_id: null,
            percent: 10,
          })),
      };
    if (url.startsWith("/api/v1/reports/financeiro?"))
      return {
        data: {
          de: "2026-10-01",
          ate: "2026-10-27",
          entradas_cents: 0,
          saidas_cents: 0,
          saldo_cents: 0,
          comandas_finalizadas: 0,
          comandas_estornadas: 0,
          faturado_cents: 0,
          ticket_medio_cents: 0,
          por_forma: [],
          por_servico: [],
          por_cliente: [],
          por_profissional: responsaveis.map((id) => ({
            attendant_user_id: id,
            itens: 1,
            comissao_cents: 100,
          })),
        },
      };
    return { data: [] };
  });
});

describe("nomes financeiros no contrato compartilhado com o atendimento", () => {
  it("Comissão mostra full_name nas opções e regras, com a régua única para quem não tem nome (#3023)", async () => {
    const view = await atendimentoNoMesmoCache();
    view.rerender(<CatalogoFinanceiro podeEditar comissaoDisponivel />);
    const pessoas = await screen.findByRole("combobox", { name: "Pessoa" });
    expect(await within(pessoas).findByRole("option", { name: "Técnica Azul" })).toHaveValue(
      "pessoa-azul",
    );
    // Membro conhecido sem nome não vira "Sem nome": a régua do #3023 dá
    // `Atendente <sufixo do hash do id>` — estável e sem uuid na tela.
    expect(within(pessoas).getByRole("option", { name: "Atendente CIHS" })).toHaveValue(
      "pessoa-sem-nome",
    );
    const titulo = screen.getByRole("heading", { name: "Comissão", level: 2 });
    const secao = titulo.closest("section")!;
    expect(
      await within(secao).findByText("Técnica Azul · 10%", { selector: "span" }),
    ).toBeVisible();
    // A regra da pessoa sem nome mostra o rótulo do helper; só o id DESCONHECIDO
    // (que não está na equipe) cai em "alguém".
    expect(within(secao).getAllByText("alguém · 10%")).toHaveLength(1);
    expect(within(secao).getAllByText("Atendente CIHS · 10%")).toHaveLength(1);
  });

  it("Faturamento nomeia a pessoa pelo full_name; null e desconhecido seguem «Sem responsável»", async () => {
    const view = await atendimentoNoMesmoCache();
    view.rerender(<Faturamento podeLancar={false} moedaDaOrg="BRL" />);
    const nome = await screen.findByRole("cell", { name: /^Técnica Azul$/ });
    const tabela = nome.closest("table")!;
    // `null` e id fora da equipe continuam "Sem responsável" (2 linhas); a
    // pessoa CONHECIDA sem nome ganha o rótulo do helper, não o genérico.
    expect(
      within(tabela).getAllByRole("cell", { name: /^Sem responsável$/ }),
    ).toHaveLength(2);
    expect(
      within(tabela).getAllByRole("cell", { name: /^Atendente CIHS$/ }),
    ).toHaveLength(1);
  });
});
