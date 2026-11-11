/**
 * VINCULAR UM CONTATO A UM NEGÓCIO QUE JÁ EXISTE (#852, fatia S3).
 *
 * ─── O DEFEITO QUE ESTE ARQUIVO PRENDE ──────────────────────────────────────
 *
 * O dossiê mostrava, para negócio sem contato, um parágrafo passivo — "Este
 * negócio não tem contato vinculado." — e nada mais. Quem entrava pelo funil e
 * criava o negócio sem contato (ou cujo contato foi apagado depois) não tinha
 * NENHUM caminho de tela para consertar: a ficha só sabia LER o vínculo.
 *
 * O backend nunca foi o obstáculo: `updateLeadSchema` já aceita `contact_id`
 * (`lib/schemas/leads.ts`) e `updateLeadHandler` já grava o campo
 * (`app/api/v1/leads/_handler.ts`). O que faltava era a tela.
 *
 * ─── O QUE ESTE ARQUIVO PROVA, E O QUE NÃO PROVA ────────────────────────────
 *
 * O PATCH aqui é o de VERDADE: `useEditLead` não é dublado, e o `apiClient` é —
 * então a asserção `api.patch("/api/v1/leads/l-1", { contact_id: "c-2" })` é a
 * requisição que sai do navegador, não o argumento de um dublê. Dublar o hook
 * deixaria passar justamente o defeito que importa: um `contact_id` montado no
 * lugar errado do corpo, ou um PATCH em outra rota.
 *
 * O que NÃO é provado aqui: o handler do servidor (o campo já era aceito antes
 * desta fatia) e a busca de contatos por telefone (é a rota de contatos que já
 * existe; aqui só se confere que a MESMA fonte é usada, com o termo digitado).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useContact = vi.hoisted(() => vi.fn());
const useContactList = vi.hoisted(() => vi.fn());
const useContatosRelacionados = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const showApiError = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
// O cliente HTTP é dublado e o HOOK de edição é o real: é assim que a asserção
// do PATCH vira a requisição de verdade (ver o cabeçalho).
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError }));
vi.mock("@/hooks/contacts/useContact", () => ({ useContact }));
vi.mock("@/hooks/contacts/useContactList", () => ({ useContactList }));
// A CHAVE vem do módulo REAL: é ela que prende a leitura e a escrita ao mesmo
// `queryKey`. Escrever a chave à mão aqui deixaria o teste feliz com uma chave
// que a tela não usa — o defeito de "salvei e não mudou nada".
type ModuloDeRelacionados = {
  chaveDosContatosRelacionados: (leadId: string | null) => readonly string[];
};
vi.mock("@/hooks/leads/useContatosRelacionados", async () => {
  const real = await vi.importActual<ModuloDeRelacionados>("@/hooks/leads/useContatosRelacionados");
  return { ...real, useContatosRelacionados };
});
vi.mock("@/hooks/leads/useParticipantesDoNegocio", () => ({
  useAdicionarParticipante: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoverParticipante: () => ({ mutate: vi.fn(), isPending: false }),
  useAdicionarPeloTelefone: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  chaveDoQuadro: (pipelineId: string | null) => ["kanban-board", pipelineId],
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));

import { ApiError } from "@/lib/api/types";
import { ContatoDoNegocio } from "@/components/kanban/ContatoDoNegocio";

/** O que cada id de contato devolve na ficha — a mesma fonte da aba "Dados". */
const PESSOAS: Record<string, unknown> = {
  "c-1": {
    id: "c-1",
    name: "Ana Souza",
    display_name: null,
    email: "ana@exemplo.com",
    phone_number: "+551****8888",
    updated_at: "2026-09-19T10:00:00Z",
    custom_fields: {},
  },
  "c-2": {
    id: "c-2",
    name: "João Souza",
    display_name: null,
    email: null,
    phone_number: "+551****7777",
    updated_at: "2026-09-19T10:00:00Z",
    custom_fields: {},
  },
};

/** O resultado da busca de contatos: é o que o seletor oferece para vincular. */
const ACHADO = {
  id: "c-2",
  name: "João Souza",
  display_name: null,
  phone_number: "+551****7777",
  is_anonymized: false,
};

function montar(props: { contactId?: string | null; leadId?: string | null } = {}) {
  const cliente = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidar = vi.spyOn(cliente, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={cliente}>
      <ContatoDoNegocio
        contactId={props.contactId === undefined ? null : props.contactId}
        pipelineId="p-1"
        leadId={props.leadId === undefined ? "l-1" : props.leadId}
      />
    </QueryClientProvider>,
  );
  return { ...utils, cliente, invalidar };
}

beforeEach(() => {
  vi.clearAllMocks();
  useContact.mockImplementation((id: string) => ({
    data: PESSOAS[id] ? { data: PESSOAS[id] } : undefined,
    isLoading: false,
    isError: false,
  }));
  useContactList.mockReturnValue({ data: { pages: [{ data: [ACHADO] }] }, isLoading: false });
  useContatosRelacionados.mockReturnValue({ data: { data: [] }, isLoading: false, isError: false });
  api.patch.mockResolvedValue({ data: { id: "l-1", contact_id: "c-2" } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("dossiê — vincular contato a um negócio que já existe (#852)", () => {
  it("⭐ sem contato: o bloco oferece 'Vincular contato' em vez de só o aviso", () => {
    montar();

    // O aviso continua — ele é a explicação do bloco vazio, não o defeito.
    expect(screen.getByText("Este negócio não tem contato vinculado.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vincular contato" })).toBeInTheDocument();
  });

  it("sem a âncora do negócio (card, testes do dossiê) não há o que vincular", () => {
    montar({ leadId: null });

    expect(screen.getByText("Este negócio não tem contato vinculado.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vincular contato" })).toBeNull();
  });

  it("⭐ com contato, o bloco NÃO oferece vincular — já existe um", () => {
    montar({ contactId: "c-1" });

    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vincular contato" })).toBeNull();
  });

  it("⭐ escolher um contato faz PATCH do lead com o contact_id escolhido", async () => {
    const { invalidar } = montar();
    fireEvent.click(screen.getByRole("button", { name: "Vincular contato" }));

    // A busca é a MESMA fonte da tela de contatos (o hook da lista), e o termo
    // digitado é o que a rota recebe — nome ou telefone, quem decide é ela.
    const busca = screen.getByLabelText("Buscar contato");
    fireEvent.change(busca, { target: { value: "joão" } });
    await waitFor(() => expect(useContactList).toHaveBeenCalledWith({ search: "joão", limit: 5 }));

    fireEvent.click(screen.getByRole("button", { name: "Vincular João Souza" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/leads/l-1", { contact_id: "c-2" }),
    );
    // O outro bloco é avisado a reler: o vínculo é do negócio inteiro.
    await waitFor(() =>
      expect(invalidar).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["contatos-relacionados", "l-1"] }),
      ),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Contato vinculado ao negócio."),
    );
  });

  it("⭐ depois de vincular, o dossiê mostra o contato SEM recarregar a página", async () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Vincular contato" }));
    fireEvent.click(screen.getByRole("button", { name: "Vincular João Souza" }));

    // A prova é o bloco do contato: o parágrafo do estado vazio sai e entra a
    // ficha de quem foi vinculado (telefone incluído, que vem do contato).
    await waitFor(() =>
      expect(screen.queryByText("Este negócio não tem contato vinculado.")).toBeNull(),
    );
    // O nome tem de estar na FICHA, não na lista do seletor — a lista também
    // escreve "João Souza", e aceitar qualquer ocorrência provaria só que a
    // busca devolveu alguém.
    const ficha = screen.getByTestId("contato-do-negocio");
    expect(within(ficha).getByText("João Souza")).toBeInTheDocument();
    expect(within(ficha).getByText("+551****7777")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vincular contato" })).toBeNull();
  });

  it("⭐ falha do servidor aparece NO BLOCO, com o motivo que ele mandou", async () => {
    api.patch.mockRejectedValue(
      new ApiError(
        422,
        "validation_error",
        undefined,
        "req-1",
        "O contato é de outra organização.",
      ),
    );
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Vincular contato" }));
    fireEvent.click(screen.getByRole("button", { name: "Vincular João Souza" }));

    const erro = await screen.findByTestId("erro-ao-vincular");
    expect(erro).toHaveTextContent("O contato é de outra organização.");
    // O seletor continua aberto: fechar em cima do erro esconderia a mensagem e
    // a pessoa não saberia o que tentar de novo.
    expect(screen.getByLabelText("Buscar contato")).toBeInTheDocument();
    expect(screen.queryByText("João Souza", { selector: "dd" })).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("erro sem mensagem do servidor não falha em silêncio", async () => {
    api.patch.mockRejectedValue(new Error("boom"));
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Vincular contato" }));
    fireEvent.click(screen.getByRole("button", { name: "Vincular João Souza" }));

    expect(await screen.findByTestId("erro-ao-vincular")).toHaveTextContent(
      "Não foi possível vincular o contato.",
    );
  });

  it("⭐ desvincular um vínculo errado: PATCH com contact_id nulo e o bloco volta ao vazio", async () => {
    montar({ contactId: "c-1" });
    api.patch.mockResolvedValue({ data: { id: "l-1", contact_id: null } });

    fireEvent.click(screen.getByRole("button", { name: "Desvincular contato" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/leads/l-1", { contact_id: null }),
    );
    await waitFor(() =>
      expect(screen.getByText("Este negócio não tem contato vinculado.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Vincular contato" })).toBeInTheDocument();
  });

  it("contato que não carrega ainda pode ser desvinculado — é quando mais precisa", async () => {
    // Contato apagado, fundido ou fora do alcance: a ficha não abre, e o
    // vínculo quebrado continua pendurado no negócio. Sem o botão aqui, o
    // conserto dependeria do banco.
    useContact.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    montar({ contactId: "c-1" });
    api.patch.mockResolvedValue({ data: { id: "l-1", contact_id: null } });

    expect(screen.getByText("Não consegui carregar o contato.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Desvincular contato" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/leads/l-1", { contact_id: null }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Vincular contato" })).toBeInTheDocument(),
    );
  });

  it("falha ao desvincular também aparece no bloco, com o motivo", async () => {
    montar({ contactId: "c-1" });
    api.patch.mockRejectedValue(
      new ApiError(409, "conflict", undefined, "req-2", "O contato é o principal da conversa."),
    );

    fireEvent.click(screen.getByRole("button", { name: "Desvincular contato" }));

    expect(await screen.findByTestId("erro-ao-vincular")).toHaveTextContent(
      "O contato é o principal da conversa.",
    );
    expect(
      within(screen.getByTestId("contato-do-negocio")).getByText("Ana Souza"),
    ).toBeInTheDocument();
  });
});
