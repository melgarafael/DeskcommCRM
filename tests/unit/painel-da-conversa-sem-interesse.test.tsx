import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * "MARCAR SEM INTERESSE" NO PAINEL DA CONVERSA (decisão D3).
 *
 * O "não" chega por áudio, ligação ou outra conversa, e quem atende mora no Inbox: sem o
 * botão no painel, era preciso sair da conversa, abrir a ficha e voltar. O painel lê a
 * recusa do `crm-summary` (decidida no servidor, nunca o `consent` cru) e prova:
 *
 *  1. sem recusa, quem atende vê o botão; marcar CONFIRMA antes, grava na MESMA rota da
 *     ficha e relê o resumo (o negócio foi para Perdido);
 *  2. com a recusa "sem interesse", o selo aparece e o botão some;
 *  3. com recusa de OUTRA origem, o botão também some (gravar por cima apagaria a
 *     primeira);
 *  4. com o resumo em erro, o botão não aparece: a tela não viu a recusa;
 *  5. leitor (viewer) e suporte somente leitura não veem o botão.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * Trocar `recusaDeOfertas === null` por `true` no gate do botão em `CRMSidePanel.tsx`:
 * os casos 2 e 3 ficam vermelhos (2 de 6, medido), e só eles. O caso 4 não cai: sem resumo
 * lido o painel também não tem o contato do resumo, e o botão segue escondido.
 */

const ORG = "00000000-0000-4000-8000-0000000005bb";
const CONTATO = "c0000000-0000-4000-8000-0000000000b1";

const cenario = vi.hoisted(() => ({
  papel: "agent" as string,
  suporte: null as null | { access_mode: string },
  recusa: null as "sem_interesse" | "outra" | null,
  resumoFalha: false,
  get: vi.fn(),
  post: vi.fn(),
}));

// A seção de tarefas do contato (#4630) monta sempre e lê `useUser`; os outros testes
// do painel a desligam da mesma forma.
vi.mock("@/components/inbox/TarefasDaDemanda", () => ({ TarefasDaDemanda: () => null }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-eu", role: cenario.papel, support: cenario.suporte, is_platform_admin: false },
    activeOrg: { orgId: "00000000-0000-4000-8000-0000000005bb", name: "Org", role: cenario.papel },
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => cenario.get(...args),
    post: (...args: unknown[]) => cenario.post(...args),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
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
vi.mock("@/components/contacts/CartaoDaCarteira", () => ({ CartaoDaCarteira: () => null }));

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

const conversa = {
  id: "cv-1",
  organization_id: ORG,
  contact_id: CONTATO,
  channel_session_id: "cs-1",
  status: "open",
  tags: [],
  assigned_to_user_id: null,
  bot_silenced_until: null,
  service_revision: 1,
  current_demanda_id: null,
  last_inbound_at: "2026-11-14T12:00:00Z",
  unread_count_for_assignee: 0,
  channel_sessions: null,
  contacts: {
    id: CONTATO,
    display_name: "Oficina do Zé",
    name: null,
    phone_number: "5585999998888",
    tags: [],
    is_anonymized: false,
  },
} as unknown as ConversationWithContact;

cenario.get.mockImplementation(async (url?: string) => {
  if (String(url ?? "").includes("crm-summary")) {
    if (cenario.resumoFalha) throw new Error("rede fora");
    return {
      data: {
        leads: [],
        orders: [],
        activities: [],
        demandas: [],
        fatos: [],
        historico: [],
        recusa_de_ofertas: cenario.recusa,
      },
    };
  }
  return { data: [] };
});
cenario.post.mockImplementation(async () => ({
  data: { gravado: true, negocios_fechados: 1, followups_encerrados: 1 },
}));

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CRMSidePanel conversation={conversa} />
    </QueryClientProvider>,
  );
}

const leiturasDoResumo = () =>
  cenario.get.mock.calls.filter((c) => String(c[0]).includes("crm-summary")).length;

/**
 * Espera o resumo ser APLICADO na tela, não só pedido: a recusa entra no mesmo lote de
 * estado que a lista de negócios (ou que o aviso de erro). Sem isto, os casos de "o botão
 * não aparece" passariam antes de a resposta chegar e não provariam nada.
 */
async function esperarResumo() {
  if (cenario.resumoFalha) await screen.findAllByText("Não consegui ler estes dados.");
  else await screen.findByText("Sem negócios.");
}

beforeEach(() => {
  cenario.papel = "agent";
  cenario.suporte = null;
  cenario.recusa = null;
  cenario.resumoFalha = false;
  cenario.get.mockClear();
  cenario.post.mockClear();
});

describe("painel da conversa · sem interesse", () => {
  it("sem recusa: o botão aparece, confirma antes, grava na rota da ficha e relê o resumo", async () => {
    const u = userEvent.setup();
    montar();
    const botao = await screen.findByTestId("marcar-sem-interesse");
    const antes = leiturasDoResumo();

    await u.click(botao);
    expect(cenario.post).not.toHaveBeenCalled();
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText(/Só um administrador desfaz, na aba LGPD/)).toBeInTheDocument();
    await u.click(within(dialogo).getByRole("button", { name: "Marcar sem interesse" }));

    await waitFor(() => expect(cenario.post).toHaveBeenCalledTimes(1));
    expect(String(cenario.post.mock.calls[0]?.[0])).toBe(`/api/v1/contacts/${CONTATO}/sem-interesse`);
    await waitFor(() => expect(leiturasDoResumo()).toBeGreaterThan(antes));
  });

  it("com a recusa 'sem interesse': o selo aparece e o botão some", async () => {
    cenario.recusa = "sem_interesse";
    montar();
    await esperarResumo();
    expect(within(screen.getByTestId("inbox-contato")).getByText("Sem interesse em ofertas")).toBeInTheDocument();
    expect(screen.queryByTestId("marcar-sem-interesse")).toBeNull();
  });

  it("com recusa de outra origem: nem selo nem botão por cima", async () => {
    cenario.recusa = "outra";
    montar();
    await esperarResumo();
    expect(screen.queryByTestId("marcar-sem-interesse")).toBeNull();
    expect(screen.queryByText("Sem interesse em ofertas")).toBeNull();
  });

  it("resumo em erro: o botão não aparece (a tela não conseguiu ver a recusa)", async () => {
    cenario.resumoFalha = true;
    montar();
    await esperarResumo();
    expect(screen.queryByTestId("marcar-sem-interesse")).toBeNull();
  });

  it("leitor (viewer) não vê o botão", async () => {
    cenario.papel = "viewer";
    montar();
    await esperarResumo();
    expect(screen.queryByTestId("marcar-sem-interesse")).toBeNull();
  });

  it("suporte somente leitura não vê o botão", async () => {
    cenario.papel = "admin";
    cenario.suporte = { access_mode: "support_readonly" };
    montar();
    await esperarResumo();
    expect(screen.queryByTestId("marcar-sem-interesse")).toBeNull();
  });
});
