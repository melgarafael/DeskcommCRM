/**
 * A opção `replace_live_flow` da ação «Iniciar fluxo» tem superfície: a chave
 * aparece na tela, desligada por padrão, e ligar/desligar chega à config da
 * regra sem perder o fluxo escolhido.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActionConfigForm } from "./ActionConfigForm";

const FLUXO = "11111111-1111-4111-8111-111111111111";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(async () => ({ data: [] })) },
}));
// O formulário lê os módulos da empresa (a superfície de atendimento só
// aparece com o módulo ligado). Sem ele, só o follow-up — onde a chave mora.
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { modulos_ligados: [] } }),
}));

function montar(config: { flow_pointer_id: string; replace_live_flow?: boolean }) {
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ActionConfigForm action={{ type: "start_message_flow", config }} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe("ação «Iniciar fluxo» — tirar o contato de outro fluxo", () => {
  it("⭐ desligada por padrão; ligar grava replace_live_flow e mantém o fluxo", () => {
    const onChange = montar({ flow_pointer_id: FLUXO });
    expect(screen.getByText("Tirar o contato de outro fluxo")).toBeInTheDocument();
    const chave = screen.getByRole("switch");
    expect(chave).toHaveAttribute("aria-checked", "false");

    fireEvent.click(chave);
    expect(onChange).toHaveBeenLastCalledWith({
      type: "start_message_flow",
      config: { flow_pointer_id: FLUXO, replace_live_flow: true },
    });
  });

  it("desligar tira a chave da config, em vez de gravar false", () => {
    const onChange = montar({ flow_pointer_id: FLUXO, replace_live_flow: true });
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenLastCalledWith({
      type: "start_message_flow",
      config: { flow_pointer_id: FLUXO, replace_live_flow: undefined },
    });
  });
});
