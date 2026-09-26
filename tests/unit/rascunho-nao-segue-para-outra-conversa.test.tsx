import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as ReactNS from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O TEXTO SUGERIDO PARA UM CLIENTE NÃO SEGUE PARA O CAMPO DE OUTRO (#1611).
 *
 * O `Composer` guarda o texto em `useState(initialDraft)`: trocar a prop não
 * limpa o campo. Sem remontar, abrir a conversa A por `?rascunho=` e depois
 * clicar na B deixava o texto escrito para A no campo de B, já sem a faixa de
 * origem — um clique em "enviar" e a mensagem ia para a pessoa errada.
 *
 * O composer aqui é uma SONDA com o mesmo mecanismo do real (`useState` do
 * valor inicial), para o teste medir a remontagem e não a prop.
 */

const { ORG, CONV_A, CONV_B, DRAFT, linha } = vi.hoisted(() => {
  const ORG = "00000000-0000-4000-8000-0000000004aa";
  const CONV_A = "00000000-0000-4000-8000-0000000004a1";
  const CONV_B = "00000000-0000-4000-8000-0000000004b1";
  const DRAFT = "00000000-0000-4000-8000-0000000004d1";
  const linha = (id: string) => ({
    id,
    organization_id: ORG,
    contact_id: `${id.slice(0, -2)}c1`,
    status: "open",
    tags: [],
    contacts: { id: `${id.slice(0, -2)}c1`, display_name: id, name: null, phone_number: "+5511900000000", tags: [] },
  });
  return { ORG, CONV_A, CONV_B, DRAFT, linha };
});

const get = vi.fn(async (bruta?: string): Promise<unknown> => {
  const url = bruta ?? "";
  if (url.startsWith("/api/v1/conversations?")) return new Promise(() => {});
  if (url === `/api/v1/conversations/${CONV_A}`) return { data: linha(CONV_A) };
  if (url === `/api/v1/conversations/${CONV_B}`) return { data: linha(CONV_B) };
  if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));
// As duas conversas JÁ estão na lista, como no uso real: a troca é instantânea
// e o composer não desmonta entre uma e outra. Com a lista vazia, a busca por id
// desmontaria o composer no meio da troca e o caso passaria sem a correção.
const LISTA = { data: { pages: [{ data: [linha(CONV_A), linha(CONV_B)] }] }, realtimeStatus: "ok" };
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({ useConversationsRealtime: () => LISTA }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin" }, activeOrg: { orgId: ORG } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/ConversationList", () => ({
  ConversationList: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <>
      <button onClick={() => onSelect(CONV_A)}>Abrir A</button>
      <button onClick={() => onSelect(CONV_B)}>Abrir B</button>
    </>
  ),
}));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", async () => {
  const { useState } = await vi.importActual<typeof ReactNS>("react");
  function Composer({
    conversationId,
    initialDraft = "",
    rascunho = null,
  }: {
    conversationId: string;
    initialDraft?: string;
    rascunho?: unknown;
  }) {
    const [texto] = useState(initialDraft);
    return (
      <div data-testid="composer" data-conversa={conversationId} data-faixa={rascunho ? "sim" : "nao"}>
        {texto}
      </div>
    );
  }
  return { Composer };
});
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";
import type { AvisoDeRascunho } from "@/lib/inbox/rascunho-sugerido";

const TEXTO = "Oi Maria, seu boleto venceu hoje.";
const rascunho: AvisoDeRascunho = {
  conversationId: CONV_A,
  leitura: { estado: "sugerido", draftId: DRAFT, conversationId: CONV_A, texto: TEXTO, origem: "erp" },
};

describe("rascunho sugerido ao trocar de conversa", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", `/app/inbox?id=${CONV_A}&rascunho=${DRAFT}`);
  });

  it("A abre com o texto e a faixa; ao ir para B o campo fica vazio, sem faixa, e o ?rascunho= sai da URL", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <InboxLayout initialSelectedId={CONV_A} rascunho={rascunho} />
      </QueryClientProvider>,
    );

    // Controle positivo: sem ele, um composer que nunca recebesse o texto
    // deixaria o caso de baixo verde por não medir nada.
    await waitFor(() => expect(screen.getByTestId("composer")).toHaveAttribute("data-conversa", CONV_A));
    expect(screen.getByTestId("composer")).toHaveTextContent(TEXTO);
    expect(screen.getByTestId("composer")).toHaveAttribute("data-faixa", "sim");

    fireEvent.click(screen.getByRole("button", { name: "Abrir B" }));
    await waitFor(() => expect(screen.getByTestId("composer")).toHaveAttribute("data-conversa", CONV_B));
    expect(screen.getByTestId("composer")).toBeEmptyDOMElement();
    expect(screen.getByTestId("composer")).not.toHaveTextContent(TEXTO);
    expect(screen.getByTestId("composer")).toHaveAttribute("data-faixa", "nao");
    expect(window.location.search).toBe(`?id=${CONV_B}`);

    // Voltar para A dentro da inbox não ressuscita o texto: o rascunho foi
    // descartado ao sair, e só o link (que o servidor relê) o traz de novo.
    fireEvent.click(screen.getByRole("button", { name: "Abrir A" }));
    await waitFor(() => expect(screen.getByTestId("composer")).toHaveAttribute("data-conversa", CONV_A));
    expect(screen.getByTestId("composer")).not.toHaveTextContent(TEXTO);
    expect(screen.getByTestId("composer")).toHaveAttribute("data-faixa", "nao");
  });
});
