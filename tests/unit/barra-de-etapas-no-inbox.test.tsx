import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextRequest } from "next/server";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";
import { createClient } from "@/lib/supabase/server";
import type * as AuthServer from "@/lib/auth/server";
import type * as RequireRole from "@/lib/auth/require-role";

/**
 * A BARRA DE ETAPAS NO PAINEL DA CONVERSA.
 *
 * A mesma barra do dossiê do quadro (`barra-de-etapas.test.tsx` mede a barra em
 * si) aparece no painel do Inbox, acima do seletor "Etapa do funil". Quem atende
 * vê onde o negócio está no funil e há quantos dias, sem sair da conversa.
 *
 *  1. **A rota manda a entrada na etapa.** Sem `stage_changed_at` no `select`, a
 *     barra contaria os dias pelo nascimento do negócio — errado para quem já
 *     andou no funil. O dublê serve a coluna da fixture com ou sem o `select`
 *     pedi-la, então a string do `select` é espionada.
 *  2. **O clique move pelo MESMO caminho do seletor** (`/api/v1/leads/bulk`,
 *     ação `move`) e relê o resumo.
 *  3. **Ganho e perda ficam fora da barra**; o seletor continua no lugar.
 *  4. **Abaixo de `agent` a barra só mostra** — nenhum botão; a mesma régua do
 *     "Levar para outro funil" deste painel.
 *  5. **Resposta antiga (sem as etapas) não desenha barra.**
 *  6. **A faixa não alarga o painel.** A lista da barra não quebra linha; todo
 *     `fieldset` entre ela e a `aside` precisa de `min-w-0`, senão o
 *     `min-width: min-content` do navegador repassa os ~700px da faixa e a
 *     coluna inteira rola de lado. O jsdom não calcula layout, então a classe é
 *     medida no DOM.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthServer>()),
  loadAuthUser: vi.fn(async () => ({ id: "u-1", idioma: "pt-BR", organizations: [] })),
}));
vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof RequireRole>()),
  orgAtivaDaApi: vi.fn(async () => ({ ok: true, org: { orgId: "org-1", name: "Org", role: "agent" } })),
}));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: async () => new Map() }));

const ORG = "org-1";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
type Linha = Record<string, unknown>;

describe("crm-summary: a entrada na etapa vai junto", () => {
  it("o select pede stage_changed_at e created_at, e o lead devolve a entrada", async () => {
    const selects: string[] = [];
    const lead = {
      id: "l-1", organization_id: ORG, contact_id: CONTATO, title: "Pedido", status: "open",
      value_cents: null, currency: null, updated_at: "2026-09-26T12:00:00.000Z",
      stage_changed_at: "2026-09-20T12:00:00.000Z", created_at: "2026-09-01T12:00:00.000Z",
      pipeline_id: "p-1", stage_id: "s-a", custom_fields: {},
      crm_pipelines: { name: "Funil", settings: {}, is_archived: false, etapas: [] },
      crm_stages: { name: "Etapa A" },
    };
    const tabelas: Record<string, Linha[]> = { contacts: [{ id: CONTATO, organization_id: ORG }], crm_leads: [lead] };
    const valor = (l: Linha, c: string) => c.split(".").reduce<unknown>((a, p) => (a as Linha | null)?.[p], l);
    const from = (tabela: string) => {
      let linhas = [...(tabelas[tabela] ?? [])];
      const chain = {
        select: (cols: string) => (selects.push(cols), chain),
        eq: (c: string, v: unknown) => ((linhas = linhas.filter((l) => valor(l, c) === v)), chain),
        is: (c: string, v: unknown) => ((linhas = linhas.filter((l) => (valor(l, c) ?? null) === v)), chain),
        not: (c: string, _o: string, v: unknown) => ((linhas = linhas.filter((l) => (valor(l, c) ?? null) !== v)), chain),
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(res),
      };
      return chain;
    };
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
      from,
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as never);

    const { GET } = await import("@/app/api/v1/contacts/[id]/crm-summary/route");
    const res = await GET(new NextRequest(`http://x/api/v1/contacts/${CONTATO}/crm-summary`), {
      params: Promise.resolve({ id: CONTATO }),
    });
    const body = (await res.json()) as { data: { leads: Linha[] } };

    expect(res.status).toBe(200);
    expect(body.data.leads[0]?.stage_changed_at).toBe("2026-09-20T12:00:00.000Z");
    const doLead = selects.find((s) => s.includes("crm_pipelines!inner")) ?? "";
    expect(doLead).toContain("stage_changed_at");
    expect(doLead).toContain("created_at");
  });
});

// ---- a barra no painel da conversa ----

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn() },
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: () => ({ data: null, isError: false }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({ useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/components/inbox/TarefasDaDemanda", () => ({ TarefasDaDemanda: () => null }));
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));

let papel: string | null = "agent";
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { support: null, is_platform_admin: false }, activeOrg: papel ? { role: papel } : null }),
}));

const conversation = {
  id: "cv-1",
  organization_id: ORG,
  contact_id: CONTATO,
  tags: [],
  contacts: { id: CONTATO, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

const ETAPAS = [
  { id: "s-a", name: "Etapa A", is_won: false, is_lost: false },
  { id: "s-b", name: "Etapa B", is_won: false, is_lost: false },
  { id: "s-c", name: "Etapa C", is_won: false, is_lost: false },
  { id: "s-ganho", name: "Ganhamos", is_won: true, is_lost: false },
  { id: "s-perda", name: "Perdemos", is_won: false, is_lost: true },
];
const TRES_DIAS_E_POUCO = new Date(Date.now() - (3 * 24 + 2) * 3_600_000).toISOString();

function resumo(lead: Linha) {
  return {
    data: {
      leads: [
        {
          id: "l-1", title: "Pedido", status: "open", value_cents: null, currency: null,
          updated_at: "2026-09-26T12:00:00Z", pipeline_id: "p-1", custom_fields: {}, field_defs: [],
          funil_nome: "Funil", etapa_nome: "Etapa B",
          ...lead,
        },
      ],
      orders: [],
      activities: [],
      demandas: [],
    },
  };
}

/** Só o resumo do CRM responde o negócio; o resto do painel (carteira, membros…) recebe lista vazia. */
function servir(lead: Linha) {
  get.mockImplementation(async (url: string) => (String(url).includes("crm-summary") ? resumo(lead) : { data: [] }));
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
  papel = "agent";
  get.mockReset();
  post.mockReset();
  post.mockResolvedValue({ data: { updated_count: 1 } });
});

/*
 * No painel da conversa a barra rolável de etapas SAIU — ela repetia
 * a escolha do seletor "Etapa do funil" e poluía a coluna estreita do Inbox. O
 * seletor basta (ganho e perda continuam nele, com o motivo da perda). No
 * dossiê do quadro a barra segue: `barra-de-etapas.test.tsx`.
 */
describe("painel da conversa — só o seletor de etapa", () => {
  it("sem barra de etapas; o seletor 'Etapa do funil' está no lugar", async () => {
    servir({ stage_id: "s-b", etapas_do_funil: ETAPAS, stage_changed_at: TRES_DIAS_E_POUCO });
    renderPainel();

    expect(await screen.findByRole("combobox", { name: "Etapa do funil" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Etapas do funil" })).not.toBeInTheDocument();
  });

  it("os dias na etapa atual, que só a barra mostrava, ficam ao lado do rótulo", async () => {
    servir({ stage_id: "s-b", etapas_do_funil: ETAPAS, stage_changed_at: TRES_DIAS_E_POUCO });
    renderPainel();

    expect((await screen.findByTestId("inbox-dias-na-etapa")).textContent).toBe("3 dias");
    // O rótulo do seletor continua sendo só "Etapa do funil" (o nome acessível não muda).
    expect(screen.getByRole("combobox", { name: "Etapa do funil" })).toBeInTheDocument();
  });

  it("resposta antiga, sem a data de entrada na etapa, não inventa dias", async () => {
    servir({ stage_id: "s-b", etapas_do_funil: ETAPAS, stage_changed_at: null, created_at: null });
    renderPainel();

    await screen.findByRole("combobox", { name: "Etapa do funil" });
    expect(screen.queryByTestId("inbox-dias-na-etapa")).not.toBeInTheDocument();
  });

  it("o valor do negócio vem DEPOIS de tudo que é do funil", async () => {
    servir({ stage_id: "s-b", etapas_do_funil: ETAPAS, stage_changed_at: TRES_DIAS_E_POUCO });
    renderPainel();

    const abrir = await screen.findByTestId("inbox-abrir-no-funil");
    const valor = await screen.findByTestId("inbox-valor-do-negocio");
    expect(abrir.compareDocumentPosition(valor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
