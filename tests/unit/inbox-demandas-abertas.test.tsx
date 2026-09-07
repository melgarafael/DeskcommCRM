import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

/**
 * O painel monta `ConversationTagsEditor`, que usa react-query. Sem o provider
 * o componente estoura antes de renderizar qualquer seção — e o teste falharia
 * por montagem, não pelo que quer medir.
 */
function renderPainel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <CRMSidePanel conversation={conversation} />
    </QueryClientProvider>,
  );
  return { ...view, mudarConversa: (next: React.ComponentProps<typeof CRMSidePanel>["conversation"]) => view.rerender(
    <QueryClientProvider client={client}><CRMSidePanel conversation={next} /></QueryClientProvider>,
  ) };
}

/**
 * A DEMANDA no painel do inbox — passo 4 do cap. 5 da doutrina.
 *
 * O painel já mostrava negócio, pedido e histórico: três listas sobre o que JÁ
 * aconteceu. Nenhuma responde à pergunta que a pessoa do outro lado está
 * fazendo — o que ela pediu e ainda não foi resolvido. O caso concreto que isto
 * evita: o atendente encerra a conversa, a demanda segue aberta e sem próximo
 * passo, e o vazamento só reaparece depois como número numa métrica que ele não
 * abre.
 *
 * O que estes casos guardam, e por que cada um:
 *
 *  1. **Sem próximo passo é DISTINGUÍVEL** — não basta listar. Se as duas
 *     demandas se parecem, o invariante 4 vira decoração: o atendente lê a lista
 *     e não sabe qual delas está vazando.
 *  2. **A frase existe, não só a cor** — quem enxerga mal cor precisa ler a
 *     mesma informação. Um teste que só checasse a classe CSS aprovaria uma tela
 *     inacessível.
 *  3. **Erro NÃO vira "nenhuma demanda aberta"** — é o defeito que esta rota
 *     inteira veio curar, e a seção nova poderia reintroduzi-lo por um caminho
 *     que a sonda antiga não cobria.
 *  4. **A demanda vem ANTES do negócio** — ordem é a afirmação de qual é a
 *     unidade (cap. 5). Se o lead vier primeiro, a tela diz que a unidade é o
 *     negócio, contradizendo a doutrina que o resto da branch implementa.
 */

const CONTACT = "c0000000-0000-4000-8000-000000000001";

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTACT,
  tags: [],
  // `contacts`, PLURAL — é como o painel deriva o contactId (linha 134). Com
  // `contact` o efeito nunca dispara e as seções ficam no esqueleto para sempre.
  contacts: { id: CONTACT, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

const RESPOSTA = {
  leads: [
    {
      id: "l-1",
      title: "Negócio existente",
      status: "open",
      value_cents: 10_000,
      currency: "BRL",
      updated_at: "2026-08-01T00:00:00Z",
    },
  ],
  orders: [],
  activities: [],
  demandas: [
    {
      id: "d-1",
      aberta_em: new Date(Date.now() - 5 * 3_600_000).toISOString(),
      origem: "inbound",
      estado: "aberta",
      proximo_passo: null,
      proximo_passo_em: null,
      prazo_em: null,
    },
    {
      id: "d-2",
      aberta_em: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      origem: "handoff",
      estado: "em_atendimento",
      proximo_passo: "Ligar amanhã de manhã",
      proximo_passo_em: "2026-08-08T12:00:00Z",
      prazo_em: null,
    },
  ],
};

const get = vi.fn();
const patch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    patch: (...args: unknown[]) => patch(...args),
  },
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Os editores de tag buscam vocabulário por react-query. Sem isto o painel
// estoura em `(vocabulary ?? []).filter` e o teste falharia por MONTAGEM — um
// vermelho que não diz nada sobre demanda.
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  patch.mockResolvedValue({ data: { id: "d-1" } });
});

describe("painel do inbox — demandas abertas", () => {
  it("distingue a demanda SEM próximo passo da que tem", async () => {
    get.mockResolvedValue({ data: RESPOSTA });
    renderPainel();

    await waitFor(() => expect(screen.getByTestId("inbox-demandas")).toBeTruthy());

    // Guarda de vacuidade: as duas precisam estar na tela, senão "distingue"
    // passaria por só uma existir.
    const sem = await screen.findAllByTestId("demanda-sem-proximo-passo");
    const com = screen.getAllByTestId("demanda-com-proximo-passo");
    expect(sem.length).toBe(1);
    expect(com.length).toBe(1);
  });

  it("a ausência do próximo passo é dita por ESCRITO, não só por cor", async () => {
    get.mockResolvedValue({ data: RESPOSTA });
    renderPainel();

    const sem = await screen.findByTestId("demanda-sem-proximo-passo");
    expect(sem.textContent).toMatch(/sem próximo passo definido/i);
    // E a que TEM mostra qual é — listar sem dizer o que foi combinado obrigaria
    // o atendente a abrir outra tela para descobrir.
    const com = await screen.findByTestId("demanda-com-proximo-passo");
    expect(com.textContent).toMatch(/ligar amanhã de manhã/i);
  });

  it("leitura que FALHA não vira 'nenhuma demanda aberta'", async () => {
    get.mockRejectedValue(new Error("500"));
    renderPainel();

    const secao = await screen.findByTestId("inbox-demandas");
    await waitFor(() => expect(secao.textContent).toMatch(/não consegui ler/i));
    // A afirmação sobre o negócio não pode ser feita em cima de um erro de
    // leitura — é o defeito que a rota `crm-summary` inteira veio curar.
    expect(secao.textContent).not.toMatch(/nenhuma demanda aberta/i);
  });

  it("contato SEM demanda aberta diz isso — e não some da tela", async () => {
    get.mockResolvedValue({ data: { ...RESPOSTA, demandas: [] } });
    renderPainel();

    const secao = await screen.findByTestId("inbox-demandas");
    await waitFor(() => expect(secao.textContent).toMatch(/nenhuma demanda aberta/i));
    // Some da tela seria pior que dizer: o atendente não distinguiria "não tem"
    // de "esta versão não mostra".
    expect(screen.queryByTestId("demanda-sem-proximo-passo")).toBeNull();
  });

  it("a demanda SEM próximo passo oferece a saída; a que TEM, não", async () => {
    // O gate dos mapas de arquitetura denunciou que esta seção só recebia: o
    // atendente via o vazamento e tinha de sair da tela. O botão é a segunda
    // aresta — e ele não pode aparecer onde não há o que resolver, senão vira
    // ruído em cima de trabalho já feito.
    get.mockResolvedValue({ data: RESPOSTA });
    renderPainel();
    const sem = await screen.findByTestId("demanda-sem-proximo-passo");
    const com = screen.getByTestId("demanda-com-proximo-passo");
    expect(sem.querySelector('[data-testid="marcar-proximo-passo"]')).toBeTruthy();
    expect(com.querySelector('[data-testid="marcar-proximo-passo"]')).toBeNull();
  });

  it("marcar o próximo passo GRAVA e relê do servidor", async () => {
    get.mockResolvedValue({ data: RESPOSTA });
    renderPainel();
    const sem = await screen.findByTestId("demanda-sem-proximo-passo");

    await userEvent.click(sem.querySelector('[data-testid="marcar-proximo-passo"]')!);
    const campo = await screen.findByTestId("campo-proximo-passo");
    await userEvent.type(campo, "Enviar a segunda via do boleto");
    const chamadasAntes = get.mock.calls.length;
    await userEvent.click(screen.getByTestId("salvar-proximo-passo"));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [rota, corpo] = patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(rota).toBe("/api/v1/demandas/d-1");
    expect(corpo.proximo_passo).toBe("Enviar a segunda via do boleto");
    // RELÊ do servidor em vez de apagar da lista no cliente: escrita que só
    // some da tela é o defeito que este painel inteiro existe para não repetir.
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(chamadasAntes));
  });

  it("falha ao salvar NÃO fecha o campo — o texto não pode evaporar", async () => {
    get.mockResolvedValue({ data: RESPOSTA });
    patch.mockRejectedValueOnce(new Error("500"));
    renderPainel();
    const sem = await screen.findByTestId("demanda-sem-proximo-passo");
    await userEvent.click(sem.querySelector('[data-testid="marcar-proximo-passo"]')!);
    await userEvent.type(await screen.findByTestId("campo-proximo-passo"), "Ligar amanhã");
    await userEvent.click(screen.getByTestId("salvar-proximo-passo"));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    // Fechar devolveria a tela ao estado de sucesso com nada gravado.
    const campo = (await screen.findByTestId("campo-proximo-passo")) as HTMLInputElement;
    expect(campo.value).toBe("Ligar amanhã");
  });

  it("a demanda vem ANTES do negócio — a unidade é ela (cap. 5)", async () => {
    get.mockResolvedValue({ data: RESPOSTA });
    renderPainel();

    const secao = await screen.findByTestId("inbox-demandas");
    const leads = screen.getByText("Leads recentes");
    // `compareDocumentPosition` mede a ordem no documento, não a aparência —
    // medida por ferramenta, nunca a olho.
    const posicao = secao.compareDocumentPosition(leads);
    expect(posicao & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ user: { support: null } }) }));


describe("desfecho — rascunho atravessa somente lacuna transitória do mesmo contexto", () => {
  const resposta = (revision: number) => ({ ...RESPOSTA, demandas: [{ ...RESPOSTA.demandas[0], revision }] });
  it("null→mesma conversa conserva escolha e revisão observada; conflito não renova CAS", async () => {
    get.mockResolvedValue({ data: resposta(1) });
    const view = renderPainel();
    await userEvent.click(await screen.findByRole("button", { name: "Encerrar demanda" }));
    await userEvent.selectOptions(screen.getByLabelText("Desfecho da demanda"), "perdida");
    view.mudarConversa(null);
    expect(screen.queryByLabelText("Desfecho da demanda")).toBeNull();
    get.mockResolvedValue({ data: resposta(2) });
    view.mudarConversa({ ...conversation!, service_revision: 2 });
    expect((await screen.findByLabelText("Desfecho da demanda") as HTMLSelectElement).value).toBe("perdida");
    patch.mockRejectedValueOnce(new Error("409 service_stale"));
    await userEvent.click(screen.getByRole("button", { name: "Confirmar desfecho" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/v1/demandas/d-1", { action: "encerrar", desfecho: "perdida", expected_revision: 1 }));
    expect((screen.getByLabelText("Desfecho da demanda") as HTMLSelectElement).value).toBe("perdida");
    const { toast } = await import("sonner");
    expect(toast.error).toHaveBeenCalledWith("Não foi possível encerrar. Cancele esta edição e abra novamente para revisar o desfecho.");
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await userEvent.click(screen.getByRole("button", { name: "Encerrar demanda" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirmar desfecho" }));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith("/api/v1/demandas/d-1", { action: "encerrar", desfecho: "resolvida", expected_revision: 2 }));
  });
  it.each(["conversa", "contato"])("troca real de %s descarta rascunho, sem exibir nem reutilizar", async (kind) => {
    get.mockResolvedValue({ data: resposta(1) });
    const view = renderPainel();
    await userEvent.click(await screen.findByRole("button", { name: "Encerrar demanda" }));
    await userEvent.selectOptions(screen.getByLabelText("Desfecho da demanda"), "perdida");
    view.mudarConversa(null);
    view.mudarConversa(kind === "conversa" ? { ...conversation!, id: "cv-2" } : { ...conversation!, contact_id: "outro", contacts: { ...conversation!.contacts!, id: "outro" } });
    await screen.findByRole("button", { name: "Encerrar demanda" });
    expect(screen.queryByLabelText("Desfecho da demanda")).toBeNull();
    view.mudarConversa(conversation);
    await screen.findByRole("button", { name: "Encerrar demanda" });
    expect(screen.queryByLabelText("Desfecho da demanda")).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });
});
