/**
 * AS TELAS DO NEGÓCIO E DO CONTATO PARAM DE ESCREVER BRASIL EM DURO.
 *
 * Medido numa instalação real, em EUR e com o funil em euro: o diálogo do
 * negócio anunciava "Valor (R$)" e o do contato pedia "CPF (opcional)" com o
 * exemplo `+5511999998888`. O valor ERA gravado em euro (a moeda vem da
 * organização desde o #1435) e a API já valida o documento pelo perfil do país
 * (`contactCreateSchemaDoPais`, issue #1033) — quem estava fora do acordo era a
 * tela, que cravava os dois literais.
 *
 * O país sintético é o mesmo recurso que `pais-da-organizacao-governa-documento-
 * e-lei.test.ts` usa: o registro é mutável de propósito, para provar o mecanismo
 * sem publicar citação de lei que ninguém revisou.
 */
import { readFileSync } from "node:fs";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderRTL, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PERFIS_DO_PAIS, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";

const orgAtiva = vi.hoisted(() => ({ atual: null as { currency?: string | null; country?: string | null } | null }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => orgAtiva.atual }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

import { CustomFieldsEditor } from "@/components/contacts/CustomFieldsEditor";
import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";

const XISTAO: PerfilDoPais = {
  codigo: "XI",
  nome: "Xistão",
  // Rótulos da tela da organização do país sintético — o campo é obrigatório
  // no perfil justamente para país novo declarar os seus (#1946, item 4).
  empresa: { rotuloNomeLegal: "Razão do Xistão", rotuloNumero: "CNPJ do Xistão" },
  telefoneExemplo: "+999123456789",
  documento: {
    rotulo: "Bilhete",
    exemplo: "003862011LA042",
    regra: "confere a forma, não o dígito",
    mensagemInvalido: "Bilhete inválido",
    confereDigito: false,
    apelidosDoCabecalho: ["bilhete"],
    valida: () => true,
    normaliza: (v) => v,
  },
  lei: null,
  calendario: { feriados: [], rotulo: "feriados do Xistão" },
  padroesDePii: [],
};

const NEGOCIO = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Negócio",
  description: null,
  value_cents: 24990,
  currency: "EUR",
  stage_id: "22222222-2222-4222-8222-222222222222",
  expected_close_date: null,
  tags: [],
  custom_fields: {},
} as never;

/** O provedor de consultas que os dois diálogos exigem para montar. */
function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderRTL(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeAll(() => {
  PERFIS_DO_PAIS.XI = XISTAO;
});

afterEach(() => {
  cleanup();
  orgAtiva.atual = null;
  vi.clearAllMocks();
});

const FUNIL = "33333333-3333-4333-8333-333333333333";

describe("o valor do negócio usa a moeda certa — e o eco embaixo do campo também", () => {
  it("negócio JÁ GRAVADO manda na moeda, mesmo se a empresa trocou depois", () => {
    // Trocar a moeda da organização não reescreve o que nasceu antes: o cartão
    // e o dossiê mostram a persistida, e a edição precisa concordar com eles.
    orgAtiva.atual = { currency: "BRL", country: null };
    render(<LeadFieldsForm lead={NEGOCIO} pipelineId={FUNIL} />);
    expect(screen.getByText(/Valor \(€\)/)).toBeTruthy();
    expect(screen.getByText(/= 249,90/)).toBeTruthy();
    expect(screen.queryByText(/R\$/)).toBeNull();
  });

  it("moeda SEM centavos: o eco usa a régua do negócio, não a das unidades menores", () => {
    // `value_cents` guarda ×100 em qualquer moeda; `formatCents` lê unidades
    // menores. Em guarani as duas divergem por cem, e o eco mostraria
    // `Gs. 12.500.000` embaixo de um card que diz `Gs. 125.000`.
    orgAtiva.atual = { currency: "PYG", country: null };
    render(
      <LeadFieldsForm
        lead={{ ...(NEGOCIO as object), currency: "PYG", value_cents: 12_500_000 } as never}
        pipelineId={FUNIL}
      />,
    );
    expect(screen.getByText(/= Gs\.\s?125\.000$/)).toBeTruthy();
  });

  it("negócio sem moeda gravada cai na da organização", () => {
    orgAtiva.atual = { currency: "EUR", country: null };
    render(<LeadFieldsForm lead={{ ...(NEGOCIO as object), currency: null } as never} pipelineId={FUNIL} />);
    expect(screen.getByText(/Valor \(€\)/)).toBeTruthy();
  });

  it("e quem está em real continua lendo 'Valor (R$)'", () => {
    orgAtiva.atual = { currency: "BRL", country: null };
    render(<LeadFieldsForm lead={{ ...(NEGOCIO as object), currency: "BRL" } as never} pipelineId={FUNIL} />);
    expect(screen.getByText(/Valor \(R\$\)/)).toBeTruthy();
    expect(screen.getByText(/= R\$\s?249,90/)).toBeTruthy();
  });

  it("negócio NOVO nasce na moeda da organização", () => {
    orgAtiva.atual = { currency: "EUR", country: null };
    render(
      <NewLeadDialog
        open
        onOpenChange={() => {}}
        pipelineId={FUNIL}
        stages={[{ id: "44444444-4444-4444-8444-444444444444", name: "Novo" } as never]}
      />,
    );
    expect(screen.getByText(/Valor \(€\)/)).toBeTruthy();
  });
});

describe("o documento e o exemplo de telefone seguem o país da organização", () => {
  it("país com documento próprio: o rótulo e os dois exemplos são dele", () => {
    orgAtiva.atual = { currency: "EUR", country: "XI" };
    render(<NewContactDialog open onOpenChange={() => {}} />);
    expect(screen.getByText(/Bilhete \(opcional\)/)).toBeTruthy();
    expect(screen.getByPlaceholderText("+999123456789")).toBeTruthy();
    expect(screen.getByPlaceholderText("003862011LA042")).toBeTruthy();
  });

  it("e a tela valida pela MESMA régua do servidor", async () => {
    // Mostrar "Bilhete" e recusá-lo como CPF antes de chamar a API seria
    // contrato quebrado: o formulário barraria o que o servidor aceitaria.
    orgAtiva.atual = { currency: "EUR", country: "XI" };
    api.post.mockResolvedValue({ data: { contact: { id: "c1" }, action: "created" } });
    const usuario = userEvent.setup();
    render(<NewContactDialog open onOpenChange={() => {}} />);

    await usuario.type(screen.getByLabelText(/Telefone/i), "+351912345678");
    await usuario.type(screen.getByLabelText(/Bilhete/i), "003862011LA042");
    await usuario.click(screen.getByRole("button", { name: /Criar contato/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
  });

  it("e o erro de telefone ensina o DDI do país, não o do Brasil", async () => {
    orgAtiva.atual = { currency: "EUR", country: "XI" };
    const usuario = userEvent.setup();
    render(<NewContactDialog open onOpenChange={() => {}} />);

    await usuario.type(screen.getByLabelText(/Telefone/i), "912345678");
    await usuario.click(screen.getByRole("button", { name: /Criar contato/i }));

    expect(await screen.findByText(/\+999123456789/)).toBeTruthy();
    expect(screen.queryByText(/\+5511999998888/)).toBeNull();
  });

  it("a EDIÇÃO do contato usa a mesma régua, e não a brasileira", async () => {
    orgAtiva.atual = { currency: "EUR", country: "XI" };
    const usuario = userEvent.setup();
    render(
      <EditContactDialog
        open
        onOpenChange={() => {}}
        contact={{ id: "c1", display_name: "Rita", name: "Rita", phone_number: null, email: null, tags: [], custom_fields: {} } as never}
      />,
    );

    const telefone = screen.getByLabelText(/Telefone/i);
    await usuario.clear(telefone);
    await usuario.type(telefone, "912345678");
    await usuario.click(screen.getByRole("button", { name: /Salvar/i }));

    expect(await screen.findByText(/\+999123456789/)).toBeTruthy();
    expect(screen.queryByText(/\+5511999998888/)).toBeNull();
  });

  it("o campo personalizado de telefone também mostra o exemplo do país", () => {
    orgAtiva.atual = { currency: "EUR", country: "XI" };
    render(
      <CustomFieldsEditor
        mode="contact"
        fields={[{ key: "tel", label: "Telemóvel", type: "phone" } as never]}
        value={{}}
        onChange={() => {}}
      />,
    );
    expect(screen.getByPlaceholderText("+999123456789")).toBeTruthy();
  });

  it("sem país declarado, vale o Brasil — nada muda para quem já usa", () => {
    orgAtiva.atual = { currency: "BRL", country: null };
    render(<NewContactDialog open onOpenChange={() => {}} />);
    expect(screen.getByText(/CPF \(opcional\)/)).toBeTruthy();
    expect(screen.getByPlaceholderText("+5511999998888")).toBeTruthy();
  });
});

/**
 * Quem prova o fio por COMPORTAMENTO é `auth-falha-alto.test.ts`
 * (`loadAuthUser → resolveActiveOrg`, com a organização e o acompanhamento
 * administrativo). Este caso cobre o degrau que nenhum dublê alcança: o dublê
 * daquele teste devolve as colunas venha o que vier no `select`, então tirá-las
 * do embed não o derrubaria — e a tela cairia no padrão em produção.
 */
describe("a organização ativa leva moeda e país ao cliente", () => {
  it("o embed da membership pede as duas colunas", () => {
    const fonte = readFileSync("lib/auth/server.ts", "utf8");
    expect(fonte).toMatch(/organizations\(display_name, locale, timezone, currency, country, status, suspended_kind\)/);
    expect(fonte).toContain("currency: org?.currency ?? null");
    expect(fonte).toContain("country: org?.country ?? null");
  });
});
