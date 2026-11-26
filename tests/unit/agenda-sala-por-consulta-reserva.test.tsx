/**
 * A sala é escolhida ao reservar e aparece no compromisso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ReservarServicoNaConversa } from "@/components/agenda/ReservarServicoNaConversa";
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

// O componente abre no dia de HOJE, e a disponibilidade abaixo é de 24/11/2026: sem congelar a data,
// o teste só passava naquele dia (a main ficou vermelha ao virar o dia 25). Só a `Date` é congelada;
// os timers seguem reais, porque o teste espera com `setTimeout`.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T15:00:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const SALA_A = { id: "s-2", name: "Sala A", sector: "Térreo" };
const SALA_B = { id: "s-1", name: "Sala B", sector: null };

const DISPONIBILIDADE = [
  {
    starts_at: "2026-11-24T12:00:00.000Z",
    ends_at: "2026-11-24T13:00:00.000Z",
    available: true,
    free_spaces: [SALA_A, SALA_B],
  },
];

describe("ReservarServicoNaConversa — escolha do lugar", () => {
  it("ao clicar num horário com free_spaces, o Lugar vem com a primeira livre e o POST envia space_id", async () => {
    AC.get
      .mockResolvedValueOnce({ data: [{ id: "t-1", name: "Serviço", service_enabled: true }] })
      .mockResolvedValueOnce({
        data: { fuso_da_regra: "America/Sao_Paulo", servico: { availability: DISPONIBILIDADE } },
      });
    AC.post.mockResolvedValue({ data: {} });

    render(
      <QueryClientProvider client={queryClient}>
        <ReservarServicoNaConversa
          contactId="c-1"
          conversationId="conv-1"
          contactName="Rose"
          aberto={true}
          onAbertoChange={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    fireEvent.click(await screen.findByRole("button", { name: /Consultar horários/ }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Clica no horário (que tem free_spaces) para abrir o select Lugar.
    fireEvent.click(screen.getByRole("button", { name: /09:00/ }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const lugarSelect = (await screen.findByLabelText(/Lugar/)) as HTMLSelectElement;
    expect(lugarSelect.value).toBe("s-2");

    fireEvent.click(screen.getByText(/Reservar o horário escolhido/));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const args = vi.mocked(AC.post).mock.calls.find((c) => String(c[0]).includes("agendamentos"));
    expect(args).toBeDefined();
    expect((args![1] as { space_id?: string }).space_id).toBe("s-2");
  });

  it("o recibo mostra 'Lugar: <nome>' quando o serviço tem service_space_id", async () => {
    AC.get
      .mockResolvedValueOnce({ data: [{ id: "t-1", name: "Serviço", service_enabled: true }] })
      .mockResolvedValueOnce({
        data: { fuso_da_regra: "America/Sao_Paulo", servico: { availability: DISPONIBILIDADE } },
      });
    AC.post.mockResolvedValue({
      data: {
        id: "r-1",
        status: "confirmed",
        starts_at: "2026-11-24T12:00:00.000Z",
        ends_at: "2026-11-24T13:00:00.000Z",
        time_zone: "America/Sao_Paulo",
        participant_name: "Rose",
        google_publication: "not_configured",
        human_confirmation: "not_required",
        service_space_id: "s-2",
        space_name: "Sala A",
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ReservarServicoNaConversa
          contactId="c-1"
          conversationId="conv-1"
          contactName="Rose"
          aberto={true}
          onAbertoChange={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    fireEvent.click(await screen.findByRole("button", { name: /Consultar horários/ }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    fireEvent.click(screen.getByRole("button", { name: /09:00/ }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    fireEvent.click(screen.getByText(/Reservar o horário escolhido/));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(await screen.findByText("Lugar")).toBeInTheDocument();
    expect(await screen.findByText("Sala A")).toBeInTheDocument();
  });
});
