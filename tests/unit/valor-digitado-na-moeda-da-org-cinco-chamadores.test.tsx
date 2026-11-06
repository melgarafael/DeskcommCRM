/**
 * O VALOR DIGITADO NOS CINCO CHAMADORES É LIDO PELA MOEDA DA ORGANIZAÇÃO (#3367).
 *
 * ⚠️ ESTES TESTES EXISTEM PORQUE O DO PARSER NÃO PROVA O CHAMADOR.
 *
 * `lib/money.test.ts` prova que `parseReaisToCents("1,300", "USD")` devolve
 * 130000; não prova que a TELA passa a moeda — um `parseReaisToCents(valor)` sem
 * segundo argumento continuava verde lá, e é exatamente o defeito medido na
 * instalação real (#3331, continuação #3367): organização com `currency = USD`,
 * a pessoa digitava `1,300` e o sistema gravava **1,30** — cem vezes menos — em
 * item de comanda, lançamento avulso, parcela de honorários, preço padrão da
 * agenda e lançamento recorrente.
 *
 * Cada `describe` mede UM chamador pela ponta que ele próprio controla: o corpo
 * que sai para a API. Sem o conserto, todos os cinco caem para 130 — o caso
 * vermelho é `1,300` em dólar; e o de real (`1,30` → 130) fica verde antes e
 * depois, que é a outra metade do acordo: quem opera só em real não vê
 * diferença.
 *
 * A régua vem de duas pontas, e as duas são `organizations.currency`:
 *   - comandas e faturamento RECEBEM a moeda do componente pai (que a leu no
 *     servidor via `moedaDaOrganizacao`);
 *   - honorários, agenda e recorrências leem `useMoedaDaOrgAtiva()`, o leitor
 *     de sessão da mesma coluna.
 * Por isso o dublê do provider aparece só onde o hook existe.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render as renderRTL, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `organizations.currency` na sessão — o que `useMoedaDaOrgAtiva` devolve. */
const sessao = vi.hoisted(() => ({ moeda: "USD" as string }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({
  useTagDeIdioma: () => "pt-BR",
  useLocaleDeData: () => "pt-BR",
}));
// Fora do provider o hook real devolve `null`; aqui ele devolve a moeda do caso.
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useMoedaDaOrgAtiva: () => sessao.moeda,
  useActiveOrg: () => null,
  useAuth: () => ({ activeOrg: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// A agenda renderiza mais módulos que o assunto: o dublê tira os pesados do
// caminho (mesma lista do teste de layout da edição de tipo).
vi.mock("@/components/agenda/AgendasConectadas", () => ({ AgendasConectadas: () => null }));
vi.mock("@/components/agenda/PrazosDePresenca", () => ({ PrazosDePresenca: () => null }));
vi.mock("@/components/agenda/ClientePelaAgenda", () => ({ ClientePelaAgenda: () => null }));
vi.mock("@/components/agenda/DiasBloqueados", () => ({ DiasBloqueados: () => null }));

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

import { Comandas } from "@/app/app/comandas/_client";
import { ListaDeLancamentos } from "@/app/app/faturamento/_lancamentos";
import { Parcelas } from "@/app/app/honorarios/_parcelas";
import { Recorrencias } from "@/app/app/settings/tenant/financeiro/_recorrencias";
import {
  TiposDeAgendamentoClient,
  type TipoRow,
} from "@/app/app/settings/tenant/agenda/_client";

const COMANDA_ID = "comanda-1";
const COMANDA = {
  id: COMANDA_ID,
  number: 1,
  status: "open" as const,
  contact_id: null,
  discount_cents: 0,
  total_cents: 0,
  // A moeda da própria comanda (#1531) — é ela que a tela já usava no total.
  currency: "USD",
  notes: null,
  finalized_at: null,
  reversed_at: null,
  sale_items: [],
};

const TIPO_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TIPO: TipoRow = {
  id: TIPO_ID,
  name: "Atendimento",
  slug: "atendimento",
  description: null,
  category: "consulta",
  duration_minutes: 60,
  location_kind: "in_person",
  location_details: null,
  default_owner_user_id: "user-1",
  requires_confirmation: false,
  is_active: true,
  default_price_cents: null,
  reminder_enabled: false,
  reminder_minutes_before: 1440,
  reminder_extra_offsets_minutes: null,
  reminder_body: null,
  reminder_bodies: null,
};

function renderTela(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderRTL(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  sessao.moeda = "USD";
  api.get.mockReset();
  api.post.mockReset();
  api.patch.mockReset();
  api.delete.mockReset();
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.get.mockResolvedValue({ data: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("comandas — o preço do item é lido na moeda da comanda aberta (#3367)", () => {
  it("⭐ dólar: `1,300` inclui o item com mil e trezentos, e não 1,30", async () => {
    api.get.mockImplementation(async (url: string) => {
      if (url === "/api/v1/financeiro/comandas") return { data: [COMANDA] };
      if (url === `/api/v1/financeiro/comandas/${COMANDA_ID}`) return { data: COMANDA };
      return { data: [] };
    });
    const usuario = userEvent.setup();
    renderTela(<Comandas podeLancar podeEstornar moedaDaOrg="USD" />);

    await usuario.click(await screen.findByTestId(`comanda-${COMANDA.number}`));
    await usuario.type(await screen.findByTestId("item-descricao"), "Corte");
    await usuario.type(screen.getByTestId("item-valor"), "1,300");
    await usuario.click(screen.getByTestId("incluir-item"));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/api/v1/financeiro/comandas/${COMANDA_ID}/itens`,
        expect.objectContaining({ unit_price_cents: 130000 }),
      ),
    );
  });
});

describe("faturamento — o lançamento avulso é lido na moeda da organização (#3367)", () => {
  const montar = (moeda: string) => {
    const onCriar = vi.fn();
    renderRTL(
      <ListaDeLancamentos
        lancamentos={[]}
        contas={[{ id: "conta-1", name: "Caixa" }]}
        moeda={moeda}
        podeLancar
        onCriar={onCriar}
        onPagar={vi.fn()}
        onRemover={vi.fn()}
      />,
    );
    return onCriar;
  };

  const lancar = async (valor: string) => {
    const usuario = userEvent.setup();
    await usuario.selectOptions(screen.getByTestId("lancamento-conta"), "conta-1");
    await usuario.type(screen.getByTestId("lancamento-descricao"), "Aluguel");
    await usuario.type(screen.getByTestId("lancamento-valor"), valor);
    await usuario.click(screen.getByTestId("incluir-lancamento"));
  };

  it("⭐ dólar: `1,300` grava 130000, e não 130", async () => {
    const onCriar = montar("USD");
    await lancar("1,300");
    expect(onCriar).toHaveBeenCalledWith(expect.objectContaining({ amount_cents: 130000 }));
  });

  it("em real nada muda: `1,30` continua um e trinta", async () => {
    // A outra metade do acordo (#3331): o conserto não pode mexer na regra do
    // pt-BR, que é a de quem já usa o produto.
    const onCriar = montar("BRL");
    await lancar("1,30");
    expect(onCriar).toHaveBeenCalledWith(expect.objectContaining({ amount_cents: 130 }));
  });
});

describe("honorários — a parcela é lida na moeda da organização (#3367)", () => {
  it("⭐ dólar: `1,300` cria a parcela com mil e trezentos", async () => {
    api.get.mockImplementation(async (url: string) =>
      url.includes("/parcelas") ? { data: [] } : { data: [{ id: "conta-1", name: "Caixa" }] },
    );
    const usuario = userEvent.setup();
    renderTela(<Parcelas contratoId="contrato-1" podeGerenciar />);

    await usuario.type(await screen.findByTestId("parcela-valor"), "1,300");
    // `type="date"` não aceita digitação caractere a caractere no jsdom.
    fireEvent.change(screen.getByTestId("parcela-vencimento"), {
      target: { value: "2026-02-05" },
    });
    await usuario.click(screen.getByTestId("criar-parcela"));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/v1/honorarios/contratos/contrato-1/parcelas",
        expect.objectContaining({ valor_cents: 130000 }),
      ),
    );
  });
});

describe("agenda — o preço padrão do serviço é lido na moeda da organização (#3367)", () => {
  it("⭐ dólar: `1,300` grava 130000 no preço padrão do tipo", async () => {
    const usuario = userEvent.setup();
    renderTela(
      <TiposDeAgendamentoClient
        tiposIniciais={[TIPO]}
        pessoas={[{ id: "user-1", papel: "admin", nome: "Secretária" }]}
        podeEditar
        usuarioAtualId="user-1"
        podeConfigurarGoogle={false}
        clientePelaAgendaLigado={false}
        colegasPodemMexerNaAgendaLigado={true}
        podeMudarAgendaDosColegas={false}
        podeLigarClientePelaAgenda={false}
        meetAbertoLigado={false}
        podeMudarMeetAberto={false}
      />,
    );

    await usuario.click(await screen.findByTestId(`editar-${TIPO_ID}`));
    const preco = screen.getByTestId(`editar-preco-${TIPO_ID}`);
    await usuario.clear(preco);
    await usuario.type(preco, "1,300");
    await usuario.click(screen.getByTestId(`salvar-${TIPO_ID}`));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/api/v1/agenda/tipos",
        expect.objectContaining({ default_price_cents: 130000 }),
      ),
    );
  });
});

describe("recorrências — o valor do todo-mês é lido na moeda da organização (#3367)", () => {
  it("⭐ dólar: `1,300` grava 130000 na recorrência", async () => {
    const onCriar = vi.fn();
    const usuario = userEvent.setup();
    renderRTL(
      <Recorrencias
        recorrencias={[]}
        contas={[{ id: "conta-1", name: "Caixa" }]}
        podeEditar
        carregando={false}
        onCriar={onCriar}
        onEditar={vi.fn()}
        onInativar={vi.fn()}
      />,
    );

    await usuario.type(screen.getByLabelText("Nome do lançamento"), "Aluguel");
    await usuario.selectOptions(screen.getByLabelText("Conta"), "conta-1");
    await usuario.type(screen.getByLabelText("Valor"), "1,300");
    await usuario.click(screen.getByRole("button", { name: "Adicionar" }));

    expect(onCriar).toHaveBeenCalledWith(
      expect.objectContaining({ amount_cents: 130000, day_of_month: 5 }),
    );
  });
});
