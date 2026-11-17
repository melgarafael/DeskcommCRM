import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiTokensClient } from "@/app/app/settings/api-tokens/_components/ApiTokensClient";
import { DetalheDoCompromisso } from "@/components/agenda/DetalheDoCompromisso";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
const { Passa } = vi.hoisted(() => ({
  // Sem JSX: o corpo de `vi.hoisted` roda antes dos imports, inclusive o do runtime de JSX.
  Passa: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: Passa,
  SheetContent: Passa,
  SheetHeader: Passa,
  SheetTitle: Passa,
}));
// O diálogo de criação aberto direto: o que se mede é o rótulo da caixa, não o clique.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: Passa,
  DialogContent: Passa,
  DialogDescription: Passa,
  DialogFooter: Passa,
  DialogHeader: Passa,
  DialogTitle: Passa,
}));
vi.mock("@/hooks/team/useApiTokens", () => ({
  useApiTokens: () => ({ data: { data: [] }, isLoading: false }),
  useCreateApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRevokeApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

/**
 * O COMPARECIMENTO POR TOKEN NA TELA (#4515, achados da prova pela tela do #4523).
 *
 * Dois defeitos que a prova pela tela achou e que nenhum teste de rota vê:
 *
 *   1. o detalhe do compromisso dizia "Presença registrada pela equipe" mesmo
 *      quando quem registrou foi uma integração — o carimbo `api_token` do RPC
 *      `fn_appointment_record_attendance` atribuído a uma pessoa;
 *   2. a caixa `agenda:attendance` em Chaves de API não dizia que a rota também
 *      cobra `mcp:write` e o papel de gerente — quem marcava só ela recebia 403.
 *
 * As mutações que este arquivo reprova: voltar o texto fixo "pela equipe" no
 * detalhe; trocar o texto da integração pelo da equipe; tirar do rótulo as duas
 * exigências; e deixar o rótulo novo sem tradução para o espanhol.
 */
const compromisso = {
  id: "appointment",
  title: "Consulta",
  description: null,
  notes: null,
  location_kind: null,
  location_details: null,
  starts_at: "2026-09-02T12:00:00Z",
  ends_at: "2026-09-02T13:00:00Z",
  time_zone: "America/Sao_Paulo",
  status: "completed",
  revision: 2,
  contact_id: null,
  conversation_id: null,
  outcome_source_kind: "user" as string | null,
  outcome_recorded_at: "2026-09-02T13:05:00Z" as string | null,
  recovery: null,
  evidence_messages: [],
};

let client: QueryClient;
beforeEach(() => {
  api.get.mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});

function abrirDetalhe(locale = "pt-BR") {
  render(
    <IdiomaProvider locale={locale}>
      <QueryClientProvider client={client}>
        <DetalheDoCompromisso id="appointment" onClose={() => {}} />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
}

describe("o detalhe do compromisso diz QUEM registrou a presença", () => {
  it("registro de integração por token não aparece como registro da equipe", async () => {
    api.get.mockResolvedValue({ data: { ...compromisso, outcome_source_kind: "api_token" } });
    abrirDetalhe();
    const autoria = await screen.findByTestId("compromisso-autoria-da-presenca");
    expect(autoria.textContent).toContain("Presença registrada por uma integração (token de API)");
    expect(autoria.textContent).not.toContain("pela equipe");
  });

  it("registro feito por pessoa na Agenda continua dizendo que foi a equipe (controle)", async () => {
    api.get.mockResolvedValue({ data: { ...compromisso, outcome_source_kind: "user" } });
    abrirDetalhe();
    const autoria = await screen.findByTestId("compromisso-autoria-da-presenca");
    expect(autoria.textContent).toContain("Presença registrada pela equipe");
    expect(autoria.textContent).not.toContain("integração");
  });

  it("em espanhol, a autoria da integração também é traduzida", async () => {
    api.get.mockResolvedValue({ data: { ...compromisso, outcome_source_kind: "api_token" } });
    abrirDetalhe("es");
    const autoria = await screen.findByTestId("compromisso-autoria-da-presenca");
    expect(autoria.textContent).toContain("Asistencia registrada por una integración (token de API)");
  });
});

describe("a caixa agenda:attendance avisa o que mais a rota exige", () => {
  function caixa(locale: string) {
    render(
      <IdiomaProvider locale={locale}>
        <ApiTokensClient />
      </IdiomaProvider>,
    );
    return screen.getByRole("button", { name: /^agenda:attendance — / });
  }

  it("o rótulo nomeia AGIR no CRM e o papel de gerente", () => {
    const rotulo = caixa("pt-BR").getAttribute("aria-label") ?? "";
    expect(rotulo).toContain("Marcar comparecimento na agenda");
    expect(rotulo).toContain("AGIR no CRM");
    expect(rotulo).toContain("gerente");
  });

  it("em espanhol, o rótulo inteiro sai traduzido", () => {
    const rotulo = caixa("es").getAttribute("aria-label") ?? "";
    expect(rotulo).toContain("Marcar asistencia en la agenda");
    expect(rotulo).toContain("ACTUAR en el CRM");
    expect(rotulo).toContain("gerente");
  });
});
