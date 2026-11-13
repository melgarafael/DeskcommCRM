import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

/**
 * O VALOR DO NEGÓCIO NO BLOCO DO CARD, DENTRO DO INBOX (issue #4546).
 *
 * O painel já mostrava o valor — em "Negócios recentes" e no negócio único —,
 * mas SEMPRE para leitura. Corrigir ou preencher exigia sair da conversa, abrir
 * o card no funil e voltar; na prática o valor ficava em branco e a previsão do
 * funil, as metas por vendedor e o Faturamento (que leem o `value_cents`
 * oficial) mentiam.
 *
 * Esta fatia acrescenta o campo logo abaixo de "Etapa do funil", gravando pelo
 * MESMO caminho do quadro (`PATCH /api/v1/leads/[id]` via `useEditLead`), com a
 * MESMA régua de moeda (`parseReaisToCents`, `lib/money.ts`) e a MESMA
 * permissão de editar o card (`agent`+, o piso que a rota de escrita exige).
 *
 * Os casos, um a um:
 *  1) o campo aparece ABAIXO de "Etapa do funil", aceita «1.234,56» e grava
 *     `value_cents: 123456` — inteiro de centavos, não float;
 *  2) quem está abaixo do piso (viewer) VÊ o valor e NÃO recebe input;
 *  3) campo vazio não apaga o valor existente em silêncio: nada é enviado;
 *  4) texto inválido também não apaga: nada é enviado e o aviso aparece.
 */

// O piso de escrita do card é `agent` (`PATCH /api/v1/leads/[id]`,
// `resolveAuthDual({ role: "agent" })`). O dublê devolve o PAPEL da organização
// ativa, que é o que a régua `roleAtLeast` do painel resolve; `viewer` cai
// para fora dele.
const estado = vi.hoisted(() => ({ papel: "agent" as "agent" | "viewer" }));
const get = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: (...args: unknown[]) => patch(...args),
  },
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
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
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { support: null, is_platform_admin: false },
    activeOrg: { orgId: "org-1", name: "Org", role: estado.papel, currency: "BRL" },
  }),
}));
// Busca o acervo por conta própria e não é o alvo desta fatia.
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));
// O bloco Carteira busca a própria rota; o dublê de `get` deste arquivo devolve
// o resumo do painel para TODA URL, então o cartão sai da cena aqui.
vi.mock("@/components/contacts/CartaoDaCarteira", () => ({ CartaoDaCarteira: () => null }));

// O Select do Radix pede estas APIs do navegador, que o jsdom não implementa.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const CONTATO = "c0000000-0000-4000-8000-000000000001";

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTATO,
  tags: [],
  contacts: { id: CONTATO, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

const NEGOCIO = {
  id: "l-1",
  title: "Felipe",
  status: "open",
  value_cents: 50000,
  currency: "BRL",
  updated_at: "2026-09-15T12:00:00Z",
  pipeline_id: "p-1",
  stage_id: "s-1",
  custom_fields: {},
  field_defs: [],
  funil_nome: "Origem",
  etapa_nome: "Novo",
  etapas_do_funil: [{ id: "s-1", name: "Novo", is_won: false, is_lost: false }],
};

function resumo(leads: unknown[]) {
  return { data: { leads, orders: [], activities: [], demandas: [], fatos: [], historico: [] } };
}

function renderPainel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CRMSidePanel conversation={conversation} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  estado.papel = "agent";
  get.mockReset();
  patch.mockReset();
  post.mockReset();
  get.mockResolvedValue(resumo([NEGOCIO]));
  patch.mockResolvedValue({ data: { ...NEGOCIO, value_cents: 123456 } });
});

describe("painel do inbox — valor do negócio editável", () => {
  it("1. o campo aparece abaixo de 'Etapa do funil' e grava «1.234,56» como 123456 centavos", async () => {
    renderPainel();
    const user = userEvent.setup();

    const etapa = await screen.findByTestId("inbox-etapa-do-negocio");
    const bloco = await screen.findByTestId("inbox-valor-do-negocio");
    // "logo abaixo de Etapa do funil": o bloco do valor vem DEPOIS do Select.
    expect(
      etapa.compareDocumentPosition(bloco) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const campo = screen.getByTestId("inbox-valor-input") as HTMLInputElement;
    await user.clear(campo);
    await user.type(campo, "1.234,56");
    await user.click(screen.getByTestId("inbox-valor-salvar"));

    // O MESMO caminho do quadro: `PATCH /api/v1/leads/[id]` via `useEditLead`.
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/leads/l-1", { value_cents: 123456 }),
    );
    const enviado = patch.mock.calls[0]![1] as { value_cents: number };
    // Inteiro de centavos — nunca float (float no `int` do banco é 422).
    expect(Number.isInteger(enviado.value_cents)).toBe(true);
    expect(enviado.value_cents).toBe(123456);
  });

  it("2. quem está abaixo do piso vê o valor e NÃO recebe input", async () => {
    estado.papel = "viewer";
    renderPainel();

    // Controle de vacuidade: o bloco desenhou, e mostra o valor do negócio.
    const bloco = await screen.findByTestId("inbox-valor-do-negocio");
    expect(bloco.textContent).toContain("R$");
    expect(bloco.textContent).toContain("500,00");
    // A leitura existe; o input, não.
    expect(screen.queryByTestId("inbox-valor-input")).toBeNull();
    expect(screen.queryByTestId("inbox-valor-salvar")).toBeNull();
  });

  it("3. campo vazio não apaga o valor existente em silêncio", async () => {
    renderPainel();
    const user = userEvent.setup();

    const campo = (await screen.findByTestId("inbox-valor-input")) as HTMLInputElement;
    await user.clear(campo);
    await user.click(screen.getByTestId("inbox-valor-salvar"));

    // Nada é enviado: apagar exige um pedido explícito, e este não é um.
    await new Promise((r) => setTimeout(r, 50));
    expect(patch).not.toHaveBeenCalled();
  });

  it("4. texto inválido não apaga o valor existente nem envia requisição", async () => {
    renderPainel();
    const user = userEvent.setup();

    const campo = (await screen.findByTestId("inbox-valor-input")) as HTMLInputElement;
    await user.clear(campo);
    await user.type(campo, "abc");
    await user.click(screen.getByTestId("inbox-valor-salvar"));

    await new Promise((r) => setTimeout(r, 50));
    expect(patch).not.toHaveBeenCalled();
  });
});
