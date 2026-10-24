import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * BLOCO CARTEIRA NO PAINEL DO CONTATO DO INBOX (issue #3026).
 *
 * ─── O que a issue mede, e por que é no PAINEL ──────────────────────────────
 *
 * A carteira do cliente (#2591) só aparecia no Inbox como FAIXA DE AVISO, e só
 * quando o dono era OUTRA pessoa. Quem atende mora no Inbox: para pôr o cliente
 * na própria carteira (ou na de um colega) era preciso sair da conversa, abrir
 * o contato e voltar. Este arquivo prende o que a issue pede, caso a caso:
 *
 *   1. o bloco Carteira existe no painel e mostra o RESPONSÁVEL (nome) — o
 *      mesmo `CartaoDaCarteira` da ficha, não um segundo componente;
 *   2. sem dono, o bloco mostra o estado vazio do cartão — e NÃO inventamos
 *      "sem dono" quando a leitura FALHOU (é o defeito que o #2591 pagou na
 *      ficha; aqui ele não pode voltar pela porta do Inbox);
 *   3. com permissão (`manager`+), definir/trocar grava pela MESMA porta da
 *      ficha — a URL do `PATCH` é a mesma `/api/v1/contacts/[id]/carteira`, nada
 *      de rota nova;
 *   4. CONTROLE: sem permissão (`agent` não vê o botão; `viewer` não vê o
 *      bloco) — o gate de verdade é o `requireRole("manager")` da rota, e aqui
 *      só se mede que a tela não oferece o que o servidor recusaria.
 *
 * O `CartaoDaCarteira` é o componente REAL neste arquivo: é exatamente o reuso
 * que a issue pede ("com o mesmo componente da ficha"), então um dublê aqui
 * mediria o dublê, não a entrega.
 */

const ORG = "00000000-0000-4000-8000-0000000005aa";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
const CONVERSA = "cv-1";
const MARIA = "d0000000-0000-4000-8000-00000000000a";

/** O papel da sessão muda por caso: `manager` (define) / `agent` / `viewer`. */
const cenario = vi.hoisted(() => ({
  papel: "manager" as string,
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-eu", role: cenario.papel, support: null, is_platform_admin: false },
    activeOrg: { orgId: "00000000-0000-4000-8000-0000000005aa", name: "Org", role: cenario.papel },
  }),
  usePermission: () => true,
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => cenario.get(...args),
    patch: (...args: unknown[]) => cenario.patch(...args),
    post: vi.fn(),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
// As irmãs do painel não são o alvo e trazem fetch próprio: ficam de fora da conta.
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));

import { CRMSidePanel } from "./CRMSidePanel";

const conversa = {
  id: CONVERSA,
  organization_id: ORG,
  contact_id: CONTATO,
  channel_session_id: "cs-1",
  status: "open",
  tags: [],
  assigned_to_user_id: null,
  bot_silenced_until: null,
  service_revision: 1,
  current_demanda_id: null,
  last_inbound_at: "2026-09-15T12:00:00Z",
  unread_count_for_assignee: 0,
  channel_sessions: null,
  contacts: {
    id: CONTATO,
    display_name: "Fulana",
    name: null,
    phone_number: "5511999",
    tags: [],
    is_anonymized: false,
  },
} as unknown as ConversationWithContact;

const resumo = {
  data: { leads: [], orders: [], activities: [], demandas: [], fatos: [], historico: [] },
};

/** Os membros vêm da MESMA lista da ficha (`/team/assignable`). */
const MEMBROS = { data: [{ user_id: MARIA, role: "agent", full_name: "Maria Vendas" }] };

/**
 * A carteira do contato, como o servidor devolve. `falhaDeLeitura` força uma
 * FALHA de leitura: é o caso que não pode virar "sem dono".
 */
let donoNaCarteira: string | null = MARIA;
let falhaDeLeitura = false;

cenario.get.mockImplementation(async (url?: string) => {
  const bruto = url ?? "";
  if (bruto.includes("/carteira")) {
    if (falhaDeLeitura) throw new Error("rede fora");
    return { data: { contact_id: CONTATO, dono_user_id: donoNaCarteira, qualificado: true } };
  }
  if (bruto.includes("team/assignable")) return MEMBROS;
  if (bruto.includes("crm-summary")) return resumo;
  return { data: [] };
});
cenario.patch.mockImplementation(async () => ({ data: { contact_id: CONTATO, carteira_user_id: MARIA } }));

beforeEach(() => {
  cenario.papel = "manager";
  cenario.get.mockClear();
  cenario.patch.mockClear();
  donoNaCarteira = MARIA;
  falhaDeLeitura = false;
});

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CRMSidePanel conversation={conversa} />
    </QueryClientProvider>,
  );
}

/** O bloco no painel — o `<section>` que o #3026 entrega. */
const bloco = () => screen.getByTestId("inbox-bloco-carteira");

const urlsPedidas = () => cenario.get.mock.calls.map((c) => String(c[0]));

describe("#3026 — o bloco Carteira no painel do contato do Inbox", () => {
  it("mostra o RESPONSÁVEL da carteira, pelo mesmo cartão da ficha", async () => {
    montar();

    // O bloco existe no painel (não só a faixa do cabeçalho) e traz o cartão.
    const secao = await screen.findByTestId("inbox-bloco-carteira");
    expect(within(secao).getByTestId("carteira-do-contato")).toBeInTheDocument();
    // O NOME do dono — a pergunta que o atendente precisa responder.
    await waitFor(() =>
      expect(within(secao).getByTestId("carteira-dono").textContent).toContain("Maria Vendas"),
    );
  });

  it("contato sem dono: o bloco mostra o estado vazio, e nada é gravado sozinho", async () => {
    donoNaCarteira = null;
    montar();

    const secao = await screen.findByTestId("inbox-bloco-carteira");
    await waitFor(() => expect(within(secao).getByTestId("carteira-vazio")).toBeInTheDocument());
    expect(within(secao).queryByTestId("carteira-dono")).toBeNull();
    // Sem dono é o comportamento de hoje: nenhum backfill na abertura da tela.
    expect(cenario.patch).not.toHaveBeenCalled();
  });

  it("CONTROLE: falha de leitura NÃO vira 'sem carteira'", async () => {
    falhaDeLeitura = true;
    montar();

    // A seção pode existir vazia — o que não pode existir é a AFIRMAÇÃO de
    // ausência de dono em cima de um erro de leitura (defeito do #2591).
    await waitFor(() => expect(screen.queryByTestId("carteira-do-contato")).toBeNull());
    expect(screen.queryByTestId("carteira-vazio")).toBeNull();
    expect(screen.queryByTestId("carteira-dono")).toBeNull();
  });
});

describe("#3026 — definir a carteira pela MESMA porta da ficha", () => {
  it("com permissão, o botão grava na rota da carteira (mesma porta, nada de rota nova)", async () => {
    const u = userEvent.setup();
    montar();

    const secao = await screen.findByTestId("inbox-bloco-carteira");
    const seletor = (await within(secao).findByTestId("carteira-seletor")) as HTMLSelectElement;
    // O seletor acompanha o dono atual depois do efeito de montagem.
    await waitFor(() => expect(seletor.value).toBe(MARIA));

    await u.selectOptions(seletor, "__sem_dono__");
    const salvar = within(secao).getByTestId("carteira-salvar") as HTMLButtonElement;
    await waitFor(() => expect(salvar.disabled).toBe(false));
    await u.click(salvar);

    await waitFor(() => expect(cenario.patch).toHaveBeenCalledTimes(1));
    // A PORTA: exatamente a mesma URL que `useDefinirCarteira` usa na ficha.
    expect(cenario.patch.mock.calls[0]![0]).toBe(`/api/v1/contacts/${CONTATO}/carteira`);
    expect(cenario.patch.mock.calls[0]![1]).toEqual({ dono_user_id: null, origem: "manual" });
  });

  it("CONTROLE: 'agent' vê o bloco (a carteira é informação de quem atende), sem o botão", async () => {
    cenario.papel = "agent";
    montar();

    const secao = await screen.findByTestId("inbox-bloco-carteira");
    await waitFor(() => expect(within(secao).getByTestId("carteira-dono")).toBeInTheDocument());
    expect(within(secao).queryByTestId("carteira-seletor")).toBeNull();
    expect(within(secao).queryByTestId("carteira-salvar")).toBeNull();
  });

  it("CONTROLE: 'viewer' não vê o bloco — o GET da carteira cobra agent+", async () => {
    cenario.papel = "viewer";
    montar();

    await screen.findByTestId("inbox-demandas");
    expect(screen.queryByTestId("inbox-bloco-carteira")).toBeNull();
    expect(screen.queryByTestId("carteira-do-contato")).toBeNull();
    // Nada é pedido ao servidor: o bloco não oferece o que levaria 403.
    expect(urlsPedidas().some((u) => u.includes("/carteira"))).toBe(false);
  });
});
