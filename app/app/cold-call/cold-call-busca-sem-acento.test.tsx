import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";

import { ColdCall } from "./_client";

/**
 * A BUSCA DA FILA DO COLD CALL IGNORA ACENTO (#4167).
 *
 * O negócio se chama "Padaria São João". A busca da fila comparava
 * `titulo.toLowerCase().includes(termo)` — caixa sim, acento não: digitar
 * `sao joao` devolvia a fila vazia, e o atendente procurava o lead rolando a
 * lista inteira.
 *
 * A busca por TELEFONE já funcionava e continua igual: dígito não tem acento,
 * e o piso é o mesmo `termoSemAcento` agora aplicado ao termo digitado.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", name: "Clínica", role: "admin" }),
  useUser: () => ({ id: "u", email: "u@x.com" }),
}));
vi.mock("@/hooks/team/useTeamMembers", () => ({ useTeamMembers: () => ({ data: { data: [] } }) }));
vi.mock("./_guia", () => ({ GuiaDoColdCall: () => null, guiaJaVisto: () => true }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock("@/hooks/voice/useVoiceSessionStatus", () => ({
  useVoiceSessionStatus: () => ({ data: undefined, refetch: vi.fn() }),
}));
vi.mock("@/components/voice/VoiceCallContext", () => ({
  useVoiceCall: () => ({ call: null, startCall: vi.fn(), hangUp: vi.fn(), ultimoFim: null }),
}));
vi.mock("@/app/app/kanban/_components/ImportarLeads", () => ({ ImportarLeads: () => null }));

const FUNIL = {
  id: "funil",
  name: "Cold Call",
  slug: "cold-call",
  description: null,
  position: 1,
  is_default: false,
};

function lead(id: string, titulo: string, telefone: string) {
  return {
    id,
    titulo,
    descricao: null,
    tags: [],
    contato_id: `contato-${id}`,
    tem_foto: false,
    nao_ligar: null,
    contato_nome: titulo,
    telefone,
    email: null,
    endereco: null,
    conversa_id: null,
    responsavel_id: null,
    etapa: "na-fila",
    etapa_nome: "Na fila",
    tentativas: 0,
    ultima_tentativa_em: null,
    ultimo_resultado: null,
    historico: [],
    criado_em: "2026-11-01T00:00:00Z",
  };
}

const LEADS = [
  lead("lead-1", "Padaria São João", "+5511999990001"),
  lead("lead-2", "Mercado Central", "+5511999990002"),
];

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockResolvedValue({ data: { funil: FUNIL, roteiro: "", leads: LEADS } });
});

afterEach(() => vi.mocked(apiClient.get).mockReset());

function campoDaBusca() {
  return screen.getByLabelText("Buscar por nome ou telefone");
}

describe("busca da fila do cold call", () => {
  it("acha o negócio acentuado digitando sem acento (#4167)", async () => {
    const user = userEvent.setup();
    render(comQuery(<ColdCall />));
    await screen.findByText("Mercado Central");

    await user.type(campoDaBusca(), "sao joao");

    expect(screen.getByText("Padaria São João")).toBeTruthy();
    expect(screen.queryByText("Mercado Central")).toBeNull();
  });

  it("controle negativo: termo que não casa continua não achando", async () => {
    const user = userEvent.setup();
    render(comQuery(<ColdCall />));
    await screen.findByText("Mercado Central");

    await user.type(campoDaBusca(), "zzz");

    expect(screen.queryByText("Padaria São João")).toBeNull();
    expect(screen.queryByText("Mercado Central")).toBeNull();
  });

  it("a busca por TELEFONE segue green", async () => {
    const user = userEvent.setup();
    render(comQuery(<ColdCall />));
    await screen.findByText("Mercado Central");

    await user.type(campoDaBusca(), "999990002");

    expect(screen.getByText("Mercado Central")).toBeTruthy();
    expect(screen.queryByText("Padaria São João")).toBeNull();
  });
});
