/**
 * O seletor "Tipo de fluxo" da ação Iniciar fluxo de mensagem (#2647) segue o
 * módulo opcional Fluxos de atendimento, como o QueueTab e o roteador já fazem:
 * desligado na instalação, a opção "Atendimento" não aparece — salvo numa regra
 * que já a grava, para a tela não esconder o que está salvo.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(async () => ({ data: [] })) },
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: vi.fn() }));

import { useAuth } from "@/hooks/auth/AuthProvider";
import { ActionConfigForm, type ActionItem } from "@/app/app/webhooks/_components/ActionConfigForm";

afterEach(() => cleanup());

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

function abrirTipoDeFluxo(modulos: string[], surface: "followup" | "atendimento") {
  vi.mocked(useAuth).mockReturnValue({
    activeOrg: { modulos_ligados: modulos },
  } as unknown as ReturnType<typeof useAuth>);
  const action: ActionItem = { type: "start_message_flow", config: { flow_pointer_id: "", surface } };
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={cliente}>
      <ActionConfigForm action={action} onChange={vi.fn()} />
    </QueryClientProvider>,
  );
  // O primeiro gatilho é o "Tipo de fluxo" (o segundo, o fluxo, nasce desabilitado).
  fireEvent.click(container.querySelector("button")!);
}

describe("Iniciar fluxo de mensagem: a opção Atendimento segue o módulo", () => {
  it("módulo ligado: Atendimento aparece", async () => {
    abrirTipoDeFluxo(["fluxos_atendimento"], "followup");
    expect(await screen.findByRole("option", { name: "Atendimento" })).toBeInTheDocument();
  });

  it("módulo desligado: só Follow-up", async () => {
    abrirTipoDeFluxo([], "followup");
    expect(await screen.findByRole("option", { name: "Follow-up" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Atendimento" })).toBeNull();
  });

  it("módulo desligado numa regra que já grava Atendimento: a tela não esconde o salvo", async () => {
    abrirTipoDeFluxo([], "atendimento");
    expect(await screen.findByRole("option", { name: "Atendimento" })).toBeInTheDocument();
  });
});
