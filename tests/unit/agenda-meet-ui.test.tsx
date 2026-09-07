import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { MeetDoCompromisso, type MeetingDetail } from "@/components/agenda/MeetDoCompromisso";
import { copyToClipboard } from "@/lib/clipboard";
import { meetingErrors, meetingDeliveryErrors } from "@/lib/agenda/google/meet";
import { traduzir } from "@/lib/i18n/dicionario";
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));
const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  api.post.mockResolvedValue({ data: { pending: true } });
});
afterEach(() => {
  cleanup();
  client.clear();
});
const initial: MeetingDetail = {
  state: "pending",
  url: null,
  request_id: "request",
  error: null,
  delivery_state: "none",
  can_manage: true,
  destinations: [{ id: "conversation", label: "Maria · +55 11 99999-9999" }],
};
const show = (meeting: MeetingDetail, locale = "pt-BR") =>
  render(
    <QueryClientProvider client={client}>
      <IdiomaProvider locale={locale}>
        <MeetDoCompromisso
          id="appointment"
          revision="9007199254740993"
          meeting={meeting}
          onSaved={vi.fn()}
        />
      </IdiomaProvider>
    </QueryClientProvider>,
  );
it("pending mostra destino e só arma envio depois do clique", async () => {
  show(initial);
  expect(screen.getByText("Criando link do Google Meet")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Abrir reunião" })).not.toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Enviar quando ficar pronto" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/agenda/agendamentos/appointment/google/meet/deliver",
      { revision: "9007199254740993", request_id: "request", conversation_id: "conversation" },
    ),
  );
});
it("ready oferece URL utilizável sem afirmar envio; erro oferece retry separado", () => {
  const view = show({ ...initial, state: "ready", url: "https://meet.google.com/abc-defg-hij" });
  expect(screen.getByRole("link", { name: "Abrir reunião" })).toHaveAttribute(
    "href",
    "https://meet.google.com/abc-defg-hij",
  );
  expect(screen.getByText("O envio do link ainda não foi autorizado.")).toBeInTheDocument();
  view.unmount();
  show({ ...initial, state: "failed", error: "unknown" });
  expect(screen.getByRole("button", { name: "Verificar link novamente" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enviar quando ficar pronto" })).toBeDisabled();
});
it("sem conversa, sem responsável ou cancelado não oferece efeito indevido", () => {
  const view = show({ ...initial, destinations: [] });
  expect(screen.getByRole("button", { name: "Enviar quando ficar pronto" })).toBeDisabled();
  view.unmount();
  const next = show({ ...initial, can_manage: false });
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  next.unmount();
  show({ ...initial, state: "cancelled" });
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("sent só desabilita na fronteira atual; mesmo UUID reaberto aceita novo clique", async () => {
  const sent = {
    ...initial,
    state: "ready",
    delivery_state: "sent",
    delivery_conversation_id: "conversation",
  };
  const view = show({ ...sent, delivery_authorization_current: true });
  expect(screen.getByRole("button", { name: "Link já enviado" })).toBeDisabled();
  view.unmount();
  show({ ...sent, delivery_authorization_current: false });
  fireEvent.click(screen.getByRole("button", { name: "Enviar link ao cliente" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      expect.stringContaining("/deliver"),
      expect.objectContaining({ conversation_id: "conversation" }),
    ),
  );
});
it("bloqueios explicam autonomia versus opt-out sem sugerir repetir a mesma ação", () => {
  const view = show({ ...initial, delivery_state: "blocked", delivery_error: "force_human" });
  expect(screen.getByText(/sem ativar a IA/)).toBeInTheDocument();
  view.unmount();
  show({ ...initial, delivery_state: "blocked", delivery_error: "opt_out" });
  expect(screen.getByText(/respeite essa escolha/)).toBeInTheDocument();
});

it("cópia só anuncia sucesso quando o helper confirma e permite tentar de novo", async () => {
  vi.mocked(copyToClipboard)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  show({ ...initial, state: "ready", url: "https://meet.google.com/abc-defg-hij" });
  fireEvent.click(screen.getByRole("button", { name: "Copiar link" }));
  await screen.findByRole("button", { name: "Link copiado" });
  expect(copyToClipboard).toHaveBeenCalledWith("https://meet.google.com/abc-defg-hij");
  fireEvent.click(screen.getByRole("button", { name: "Link copiado" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Copiar link" })).toBeInTheDocument();
  expect(screen.queryByText("Link copiado")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Copiar link" }));
  await screen.findByRole("button", { name: "Link copiado" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([
  ["not_requested", "Enlace aún no solicitado"],
  ["pending", "Creando enlace de Google Meet"],
  ["ready", "Enlace de Google Meet listo"],
  ["failed", "No se pudo confirmar el enlace"],
  ["cancelled", "Solicitud de enlace cancelada"],
])("estado %s aparece em espanhol", (state, label) => {
  show({ ...initial, state }, "es");
  expect(screen.getByRole("status")).toHaveTextContent(label);
});

it.each(Object.entries(meetingErrors))("erro Google %s tem tradução aplicada", (error, message) => {
  show({ ...initial, state: "failed", error: error as MeetingDetail["error"] }, "es");
  expect(traduzir(message, "es")).not.toBe(message);
  expect(screen.getByRole("alert")).toHaveTextContent(traduzir(message, "es"));
});

it.each(Object.entries(meetingDeliveryErrors))(
  "erro de entrega %s tem tradução aplicada",
  (error, message) => {
    show({ ...initial, delivery_state: "blocked", delivery_error: error }, "es");
    expect(traduzir(message, "es")).not.toBe(message);
    expect(screen.getByText(traduzir(message, "es"))).toBeInTheDocument();
  },
);

it("ações e falha de cópia em espanhol não caem no português", async () => {
  vi.mocked(copyToClipboard).mockResolvedValue(false);
  show(
    { ...initial, state: "ready", url: "https://meet.google.com/abc-defg-hij", destinations: [] },
    "es",
  );
  expect(screen.getByRole("link", { name: "Abrir reunión" })).toBeInTheDocument();
  expect(screen.getByLabelText("Conversación que recibirá el enlace")).toBeInTheDocument();
  expect(
    screen.getByText("No hay ninguna atención abierta para este contacto"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enviar enlace al cliente" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Copiar enlace" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo copiar.");
});
