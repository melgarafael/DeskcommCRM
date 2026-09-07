import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { AgendasConectadas, type CalendarCatalog } from "@/components/agenda/AgendasConectadas";
import {
  SincronizacaoDoCompromisso,
  type SyncDetail,
} from "@/components/agenda/SincronizacaoDoCompromisso";
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
let client: QueryClient;
const connection = (id: string) => ({
  id,
  account_email: `${id}@example.test`,
  status: "healthy",
  last_sync_error: null,
  calendar_selection_revision: "9007199254740993",
});
const calendar = (id: string, conn: string, write = true) => ({
  id,
  connection_id: conn,
  name: id,
  is_destination: id === "Principal",
  counts_for_conflicts: true,
  can_read: true,
  can_write: write,
  available: true,
  access_role: write ? "writer" : "reader",
  last_sync_at: null,
  sync_error: null,
  reading: false,
  sync_coverage: null,
});
const catalog: CalendarCatalog = {
  connections: [connection("one"), connection("two")],
  calendars: [
    calendar("Principal", "one"),
    calendar("Secundária", "two"),
    calendar("Leitura", "two", false),
  ],
};
const shared = {
  starts_at: "2026-09-10T12:00:00Z",
  ends_at: "2026-09-10T13:00:00Z",
  time_zone: "America/Sao_Paulo",
  cancelled: false,
};
const initial: SyncDetail = {
  revision: "17",
  local_revision: "9007199254740993",
  etag: '"v3"',
  synced_at: null,
  error: null,
  pending: true,
  can_resolve: true,
  conflict: {
    reason: "shared",
    local: shared,
    remote: { ...shared, starts_at: "2026-09-10T14:00:00Z", ends_at: "2026-09-10T15:00:00Z" },
    groups: [],
    etag: '"v3"',
    revision: "17",
    local_revision: "9007199254740993",
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  api.get.mockResolvedValue({ data: catalog });
  api.patch.mockResolvedValue({ data: { saved: true } });
  api.post.mockResolvedValue({ data: { pending: true } });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function open(child: React.ReactNode) {
  return render(
    <IdiomaProvider locale="pt-BR">
      <QueryClientProvider client={client}>{child}</QueryClientProvider>
    </IdiomaProvider>,
  );
}
describe("seleção explícita de fontes e destino", () => {
  it("escolha atravessa contas, leitura não recebe destino e envia revisões originais", async () => {
    open(<AgendasConectadas />);
    await screen.findByText("Secundária");
    const secondary = screen.getByText("Secundária").parentElement!;
    const readonly = screen.getByText("Leitura").parentElement!;
    expect(within(readonly).getByRole("radio")).toBeDisabled();
    fireEvent.click(within(secondary).getByRole("radio"));
    fireEvent.click(within(readonly).getByRole("checkbox"));
    act(() =>
      client.setQueryData(["agenda", "calendarios"], {
        ...catalog,
        connections: catalog.connections.map((c) => ({
          ...c,
          calendar_selection_revision: "9007199254740994",
        })),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Salvar agendas" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/agenda/google/calendarios", {
        sources: ["Principal", "Secundária"],
        destination: "Secundária",
        revisions: catalog.connections.map((c) => ({
          connection_id: c.id,
          revision: c.calendar_selection_revision,
        })),
      }),
    );
  });
  it("explica permissão e mantém erro visível na lista", async () => {
    api.get.mockResolvedValue({
      data: {
        ...catalog,
        calendars: [{ ...catalog.calendars[2], sync_error: "Acesso perdido", reading: true }],
      },
    });
    open(<AgendasConectadas />);
    await screen.findByText("Acesso perdido");
    expect(screen.getByText(/Leitura permitida/)).toBeVisible();
    expect(screen.getByText(/Leitura em andamento/)).toBeVisible();
  });
});
describe("decisão de conflito e retry no detalhe", () => {
  it("mostra ambos horários e decide com os valores exatos, sem conversão bigint", async () => {
    const saved = vi.fn();
    open(<SincronizacaoDoCompromisso id="appointment" sync={initial} onSaved={saved} />);
    expect(screen.getByText(/Aqui/)).toBeVisible();
    expect(screen.getByText(/No Google/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Usar horário do Google" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/v1/agenda/agendamentos/appointment/google/resolver",
        {
          choice: "google",
          expected_domain_revision: "17",
          expected_google_local_revision: "9007199254740993",
          etag: '"v3"',
        },
      ),
    );
    expect(saved).toHaveBeenCalled();
  });
  it("campos outbound oferecem preservar sem importar título e sem botão horárioGoogle", () => {
    open(
      <SincronizacaoDoCompromisso
        id="a"
        sync={{
          ...initial,
          conflict: { ...initial.conflict!, reason: "outbound", groups: ["title"] },
        }}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Preservar campos do Google" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Usar horário do Google" })).toBeNull();
  });
  it("presença histórica incompatível e outro dono não ganham autorização", () => {
    open(
      <SincronizacaoDoCompromisso
        id="a"
        sync={{
          ...initial,
          can_resolve: false,
          conflict: { ...initial.conflict!, reason: "outcome" },
        }}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByText(/Preservamos o histórico/)).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("retry envia mesma revisão e aparece junto do erro", async () => {
    open(
      <SincronizacaoDoCompromisso
        id="a"
        sync={{ ...initial, conflict: null, error: "Conexão indisponível" }}
        onSaved={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tentar sincronizar novamente" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/v1/agenda/agendamentos/a/google/retry",
        expect.objectContaining({ choice: "retry", expected_domain_revision: "17" }),
      ),
    );
  });
});
