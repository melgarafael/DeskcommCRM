/**
 * A sala é cadastrada, escolhida ao reservar e aparece no compromisso.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ConfiguracaoDoServico } from "@/components/agenda/ConfiguracaoDoServico";
import { apiClient } from "@/lib/api/client";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const AC = vi.mocked(apiClient);
const queryClient = new QueryClient();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const PESSOAS = [{ id: "p-1", nome: "Ana" }];
const RECURSOS = [
  { id: "r-1", name: "Projetor", capacity: 1, is_active: true, revision: 1, kind: "resource" as const, sector: null },
  { id: "s-1", name: "Sala B", capacity: 4, is_active: true, revision: 1, kind: "space" as const, sector: null },
  { id: "s-2", name: "Sala A", capacity: 2, is_active: true, revision: 1, kind: "space" as const, sector: "Térreo" },
];

function serviceData(ligado: boolean, recursos = RECURSOS) {
  return {
    service: {
      event_type_id: "t-1", name: "Serviço", slug: "s", is_active: true, service_enabled: true,
      booking_mode: "individual", service_timezone: "America/Sao_Paulo", duration_minutes: 60,
      slot_interval_minutes: 60, service_revision: 1, requires_confirmation: false,
      destination_calendar_id: null, service_publication_mode: "none", schedule: [],
      professionals: [], resources: [], calendar_sources: [],
    },
    resources: recursos,
    calendars: [], blocks: [], lugares_ligado: ligado, preview: null,
  };
}

describe("tela — cadastrar a sala, escolher ao marcar, ver no compromisso", () => {
  it("com o módulo ligado, cadastrar lugar envia kind space", async () => {
    AC.get.mockResolvedValue({ data: serviceData(true) });

    render(
      <QueryClientProvider client={queryClient}>
        <ConfiguracaoDoServico typeId="t-1" name="Serviço" pessoas={PESSOAS} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(await screen.findByLabelText(/Tipo/)).toBeInTheDocument();

    const tipoSelect = (await screen.findByLabelText(/Tipo/)) as HTMLSelectElement;
    fireEvent.change(tipoSelect, { target: { value: "space" } });

    const form = screen.getByText(/Cadastrar recurso/)!.closest("form")!;
    const nomeInput = form.querySelector('input[name="resource_name"]') as HTMLInputElement;
    const capInput = form.querySelector('input[name="resource_capacity"]') as HTMLInputElement;
    fireEvent.change(nomeInput, { target: { value: "Sala Nova" } });
    fireEvent.change(capInput, { target: { value: "4" } });

    AC.post.mockResolvedValue({ data: { future_reservations: 0 } });
    fireEvent.submit(form);

    expect(AC.post).toHaveBeenCalledWith(
      "/api/v1/agenda/servicos",
      expect.objectContaining({
        action: "resource",
        input: expect.objectContaining({ name: "Sala Nova", capacity: 4, kind: "space" }),
      }),
    );
  });

  it("sem o módulo, o campo Tipo não aparece", async () => {
    AC.get.mockResolvedValue({ data: serviceData(false) });

    render(
      <QueryClientProvider client={queryClient}>
        <ConfiguracaoDoServico typeId="t-1" name="Serviço" pessoas={PESSOAS} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByLabelText(/Tipo/)).not.toBeInTheDocument();
  });

  it("a lista de recursos mostra '· lugar' ao lado do nome dos kind==='space'", async () => {
    AC.get.mockResolvedValue({ data: serviceData(true) });

    render(
      <QueryClientProvider client={queryClient}>
        <ConfiguracaoDoServico typeId="t-1" name="Serviço" pessoas={PESSOAS} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Cada recurso space renderiza nome + " · lugar" em elementos adjacentes.
    const salaA = await screen.findByText("Sala A");
    expect(salaA.parentElement).toHaveTextContent("lugar");
    const salaB = await screen.findByText("Sala B");
    expect(salaB.parentElement).toHaveTextContent("lugar");
    expect(screen.getByText("Projetor")).toBeInTheDocument();
  });

  it("capacidade do lugar usa o rótulo 'Pessoas ao mesmo tempo'", async () => {
    AC.get.mockResolvedValue({ data: serviceData(true) });

    render(
      <QueryClientProvider client={queryClient}>
        <ConfiguracaoDoServico typeId="t-1" name="Serviço" pessoas={PESSOAS} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const tipoSelect = (await screen.findByLabelText(/Tipo/)) as HTMLSelectElement;
    fireEvent.change(tipoSelect, { target: { value: "space" } });
    // O rótulo "Pessoas ao mesmo tempo" aparece como label do input de capacidade do cadastro.
    const labels = screen.getAllByLabelText(/Pessoas ao mesmo tempo/);
    expect(labels.length).toBeGreaterThan(0);
  });
});
