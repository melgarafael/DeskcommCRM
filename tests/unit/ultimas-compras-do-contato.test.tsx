/**
 * "Últimas compras" do contato (issue #3179).
 *
 * A pergunta que a seção responde é a mais comum do atendimento numa agência de
 * viagens — "para onde esse cliente já foi?" — e o produto não a respondia: era
 * preciso abrir o funil e procurar os negócios GANHOS. Estes casos fixam as
 * propriedades que fazem a seção existir sem mentir:
 *
 *  1. **Compra é negócio GANHO** (`status='won'`), em TODOS os funis, ordenada
 *     pela data do ganho. Em andamento ou perdido NÃO entra — a lista inteira
 *     mentiria se entrasse.
 *  2. **Os campos escolhidos pela organização** aparecem na linha, lidos dos
 *     campos personalizados do negócio; SEM escolha salva, o padrão (data,
 *     título, valor) — e nada de travessão no lugar de campo vazio.
 *  3. **O atalho é a ROTA ESTÁVEL** `/app/leads/<id>` (lição do #3062), nunca a
 *     URL do quadro montada à mão.
 *  4. **A seção aparece nos DOIS lugares** — painel do Inbox e ficha — e some
 *     quando o contato não tem compra ganha (nunca vira bloco vazio).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";
import { UltimasCompras } from "@/components/contacts/UltimasCompras";
import {
  camposDoNegocioDosFunis,
  montarCompras,
  somenteCompras,
  valorLegivel,
  type LeadGanhoRow,
} from "@/lib/leads/compras-do-contato";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));

/* ------- a regra pura ------- */

/** As definições de campo que a organização pode escolher vêm do funil (negócio). */
const FUNIL_VIAGENS = {
  settings: {
    fields: [
      { key: "destino", label: "Destino", type: "text" },
      { key: "hospedagem", label: "Hospedagem", type: "text" },
      // Campo do CONTATO: não pode ser oferecido para a linha da compra.
      { key: "cpf", label: "CPF", type: "text", escopo: "contato" },
    ],
  },
};
const FUNIL_PACOTES = { settings: { fields: [{ key: "destino", label: "Destino", type: "text" }] } };

const ganhaMaceio: LeadGanhoRow = {
  id: "l-maceio",
  pipeline_id: "p-viagens",
  title: "Pacote Maceió",
  status: "won",
  value_cents: 250_000,
  currency: "BRL",
  closed_at: "2026-05-10T12:00:00Z",
  custom_fields: { destino: "Maceió", hospedagem: "Hotel Ponta Verde" },
  crm_pipelines: FUNIL_VIAGENS,
};

/** Segundo funil: a compra do cliente não é do mesmo quadro da primeira. */
const ganhaNatal: LeadGanhoRow = {
  id: "l-natal",
  pipeline_id: "p-pacotes",
  title: "Pacote Natal",
  status: "won",
  value_cents: 120_000,
  currency: "BRL",
  closed_at: "2026-08-01T12:00:00Z",
  custom_fields: { destino: "Natal" },
  crm_pipelines: FUNIL_PACOTES,
};

const emAndamento: LeadGanhoRow = {
  id: "l-aberto",
  pipeline_id: "p-viagens",
  title: "Orçamento Chapada",
  status: "open",
  value_cents: 90_000,
  currency: "BRL",
  closed_at: null,
  custom_fields: { destino: "Chapada" },
  crm_pipelines: FUNIL_VIAGENS,
};

const perdida: LeadGanhoRow = {
  id: "l-perdida",
  pipeline_id: "p-viagens",
  title: "Orçamento Recife",
  status: "lost",
  value_cents: 80_000,
  currency: "BRL",
  closed_at: "2026-07-01T12:00:00Z",
  custom_fields: { destino: "Recife" },
  crm_pipelines: FUNIL_VIAGENS,
};

describe("a regra: só negócio GANHO é compra", () => {
  it("lista os ganhos de DOIS funis, do mais recente para o mais antigo", () => {
    const ids = somenteCompras([ganhaMaceio, emAndamento, ganhaNatal, perdida]).map((r) => r.id);
    expect(ids).toEqual(["l-natal", "l-maceio"]);
  });

  it("CONTROLE: em andamento e perdido não entram", () => {
    const ids = somenteCompras([ganhaMaceio, emAndamento, ganhaNatal, perdida]).map((r) => r.id);
    expect(ids).not.toContain("l-aberto");
    expect(ids).not.toContain("l-perdida");
  });

  it("sem escolha salva, o padrão: nenhum campo extra na linha", () => {
    const compras = montarCompras([ganhaMaceio, ganhaNatal]);
    expect(compras).toHaveLength(2);
    expect(compras.every((c) => c.campos.length === 0)).toBe(true);
  });

  it("com escolha salva, os campos aparecem com rótulo do funil e valor do negócio", () => {
    // Campo escolhido SEM valor no negócio some (não vira "—").
    const [primeira] = montarCompras([ganhaNatal], ["destino", "hospedagem"]);
    expect(primeira!.campos).toEqual([{ chave: "destino", rotulo: "Destino", valor: "Natal" }]);
    const [comDois] = montarCompras([ganhaMaceio], ["destino", "hospedagem"]);
    expect(comDois!.campos.map((c) => c.rotulo)).toEqual(["Destino", "Hospedagem"]);
  });

  it("campo de opções mostra o LABEL da opção, não o value gravado", () => {
    const funil = {
      settings: {
        fields: [
          {
            key: "pacote",
            label: "Pacote",
            type: "select",
            options: [{ value: "ouro", label: "Pacote Ouro" }],
          },
          {
            // Foi o tipo que falhou na prova pela tela (lista pesquisável).
            key: "cidade",
            label: "Cidade",
            type: "searchable_select",
            options: [{ value: "maceio-al", label: "Maceió - AL" }],
          },
          {
            key: "extras",
            label: "Extras",
            type: "multiselect",
            options: [
              { value: "seguro", label: "Seguro viagem" },
              { value: "traslado", label: "Traslado" },
            ],
          },
        ],
      },
    };
    const [compra] = montarCompras(
      [{ ...ganhaNatal, custom_fields: { pacote: "ouro", cidade: "maceio-al", extras: ["seguro", "removida"] }, crm_pipelines: funil }],
      ["pacote", "cidade", "extras"],
    );
    expect(compra!.campos).toEqual([
      { chave: "pacote", rotulo: "Pacote", valor: "Pacote Ouro" },
      { chave: "cidade", rotulo: "Cidade", valor: "Maceió - AL" },
      // Opção apagada do funil depois do ganho: o value cru segue visível.
      { chave: "extras", rotulo: "Extras", valor: "Seguro viagem, removida" },
    ]);
  });

  it("valorLegivel trata lista, booleano e vazio", () => {
    expect(valorLegivel(["A", "B"])).toBe("A, B");
    expect(valorLegivel(true)).toBe("Sim");
    expect(valorLegivel("   ")).toBeNull();
    expect(valorLegivel(null)).toBeNull();
  });

  it("a lista oferece só os campos do NEGÓCIO, sem repetir chave entre funis", () => {
    const chaves = camposDoNegocioDosFunis([FUNIL_VIAGENS, FUNIL_PACOTES]).map((c) => c.key);
    expect(chaves).toEqual(["destino", "hospedagem"]);
    expect(chaves).not.toContain("cpf");
  });
});

describe("a seção desenhada", () => {
  const compras = montarCompras([ganhaMaceio, emAndamento, ganhaNatal, perdida], ["destino", "hospedagem"]);

  it("mostra as duas compras com data do ganho, título e valor", () => {
    render(<UltimasCompras compras={compras} />);
    expect(screen.getByTestId("compra-l-natal")).toHaveTextContent("Pacote Natal");
    expect(screen.getByTestId("compra-l-maceio")).toHaveTextContent("Pacote Maceió");
    // Data do ganho (recorte do quadro clínico em UTC-3).
    expect(screen.getByTestId("compra-l-natal").textContent).toContain("01/08/2026");
    expect(screen.getByTestId("compra-l-maceio").textContent).toContain("10/05/2026");
    expect(screen.getByTestId("compra-l-natal").textContent).toContain("R$");
    // CONTROLE: o negócio em andamento não tem linha nenhuma.
    expect(screen.queryByTestId("compra-l-aberto")).toBeNull();
  });

  it("os campos escolhidos pela organização aparecem na linha", () => {
    render(<UltimasCompras compras={compras} />);
    const linha = screen.getByTestId("compra-l-maceio");
    expect(linha.textContent).toContain("Destino:");
    expect(linha.textContent).toContain("Maceió");
    expect(linha.textContent).toContain("Hospedagem:");
    expect(linha.textContent).toContain("Hotel Ponta Verde");
  });

  it("o atalho aponta para a ROTA ESTÁVEL do negócio", () => {
    render(<UltimasCompras compras={compras} />);
    expect(screen.getByTestId("compra-abrir-l-natal")).toHaveAttribute("href", "/app/leads/l-natal");
    expect(screen.getByTestId("compra-abrir-l-maceio")).toHaveAttribute("href", "/app/leads/l-maceio");
  });

  it("CONTROLE: contato sem compra ganha não desenha a seção", () => {
    render(<UltimasCompras compras={montarCompras([emAndamento, perdida])} />);
    expect(screen.queryByTestId("ultimas-compras")).toBeNull();
  });

  it("leitura que FALHA não vira 'sem compras'", () => {
    render(<UltimasCompras compras={[]} erro onTentarDeNovo={() => {}} />);
    expect(screen.getByTestId("ultimas-compras").textContent).toMatch(/Não consegui ler as compras/);
  });
});

/* ------------------------------------------------------------------ *
 * Os DOIS pontos de montagem: painel do Inbox e ficha do contato.
 * A lista entra pelo DUBLÊ da rota (`apiClient.get`), sem subir banco.
 * ------------------------------------------------------------------ */

const CONTACT_ID = "c0000000-0000-4000-8000-000000000001";

const RESUMO = { leads: [], orders: [], activities: [], demandas: [] };

const get = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({ useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }) }));

/** Dublês da FICHA (o painel não os usa). */
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    data: {
      data: {
        id: "c0000000-0000-4000-8000-000000000001",
        name: "Joana Prado",
        display_name: null,
        email: null,
        phone_number: null,
        birthdate: null,
        tags: [],
        source: "manual",
        source_metadata: {},
        custom_fields: {},
        created_at: "2026-01-01T10:00:00Z",
        last_activity_at: null,
        first_service_at: null,
        is_blocked: false,
        is_personal: false,
        is_anonymized: false,
        ai_opt_out: false,
        address_book_name: null,
        anonymized_at: null,
        conversa: null,
      },
    },
  }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", role: "agent", cliente_pela_agenda: false },
  }),
}));
vi.mock("@/hooks/contacts/useHierarquiaDoAnuncio", () => ({ useHierarquiaDoAnuncio: () => ({ data: null }) }));
vi.mock("@/hooks/contacts/useUnblockContact", () => ({ useUnblockContact: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/contacts/usePersonalContact", () => ({
  useMarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
  useUnmarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/contacts/useAlwaysHumanContact", () => ({
  useMarkAlwaysHumanContact: () => ({ mutate: vi.fn(), isPending: false }),
  useUnmarkAlwaysHumanContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/contacts/CartaoDaCarteira", () => ({ CartaoDaCarteira: () => null }));
vi.mock("@/components/contacts/PropostasDeDado", () => ({ PropostasDeDado: () => null }));
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("@/components/contacts/TimelineView", () => ({ TimelineView: () => null }));
vi.mock("@/components/contacts/EditContactDialog", () => ({ EditContactDialog: () => null }));
vi.mock("@/components/contacts/AnonymizeDialog", () => ({ AnonymizeDialog: () => null }));
vi.mock("@/components/modulos/FichasDoModulo", () => ({ FichasDoModulo: () => null }));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));

const conversa = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTACT_ID,
  tags: [],
  contacts: { id: CONTACT_ID, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

function comProvider(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((url: string) => {
    if (String(url).includes("/compras")) {
      return Promise.resolve({ data: { compras: montarCompras([ganhaMaceio, ganhaNatal], ["destino"]) } });
    }
    return Promise.resolve({ data: RESUMO });
  });
});

describe("painel do Inbox", () => {
  it("monta a seção com as compras do contato", async () => {
    comProvider(<CRMSidePanel conversation={conversa} />);
    await waitFor(() => expect(screen.getByTestId("ultimas-compras")).toBeTruthy());
    expect(screen.getByTestId("compra-l-maceio")).toHaveTextContent("Pacote Maceió");
    expect(screen.getByTestId("compra-abrir-l-natal")).toHaveAttribute("href", "/app/leads/l-natal");
  });

  it("CONTROLE: sem compra ganha, a seção não aparece", async () => {
    get.mockImplementation((url: string) => {
      if (String(url).includes("/compras")) return Promise.resolve({ data: { compras: [] } });
      return Promise.resolve({ data: RESUMO });
    });
    comProvider(<CRMSidePanel conversation={conversa} />);
    await waitFor(() => expect(screen.getByTestId("inbox-campos-lead")).toBeTruthy());
    expect(screen.queryByTestId("ultimas-compras")).toBeNull();
  });
});

describe("ficha do contato", () => {
  it("monta a mesma seção na Visão geral", async () => {
    const { ContactDetailClient } = await import("@/app/app/contacts/[id]/_client");
    comProvider(<ContactDetailClient contactId={CONTACT_ID} />);
    await waitFor(() => expect(screen.getByTestId("ultimas-compras")).toBeTruthy());
    expect(screen.getByTestId("compra-l-maceio")).toHaveTextContent("Pacote Maceió");
    expect(screen.getByTestId("compra-abrir-l-maceio")).toHaveAttribute("href", "/app/leads/l-maceio");
  });
});
