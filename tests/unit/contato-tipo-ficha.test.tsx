/**
 * O TIPO DO CONTATO NA FICHA E NO PAINEL (issue 3005, fatia 1).
 *
 * ─── O defeito que este arquivo tranca ─────────────────────────────────────
 *
 * Todo contato era tratado como cliente: não havia onde dizer que a conversa é
 * com um fornecedor (operadora, consolidadora, seguradora), e o painel do Inbox
 * mostrava o mesmo cartão para os dois. A fatia 1 desta issue é o TIPO: o
 * seletor na ficha (`EditContactDialog`) e o selo no painel da conversa
 * (`CRMSidePanel`), os dois lendo a coluna `contacts.contact_type` (migration
 * 0763, espelhada no fim do `baseline.sql`).
 *
 * ─── Por que este arquivo roda as TELAS de verdade ─────────────────────────
 *
 * O que interessa é o FIO: o `Select` grava no formulário, o `Salvar` monta o
 * PATCH (via o `apiClient` real, com o `patch` espiado), e o selo do painel lê
 * o campo que a rota de conversas devolve. Um dublê de cada ponta provaria só
 * que os dublês estão ligados.
 *
 * O que cada caso prova:
 *   1. a ficha ABRE com o tipo da coluna ('fornecedor' aparece no gatilho, não
 *      o padrão 'cliente' — é o que distingue "abriu certo" de "sempre cliente");
 *   2. trocar para Fornecedor e salvar manda `contact_type: 'fornecedor'` no
 *      PATCH — o caminho de escrita que o invariante de banco não alcança;
 *   3. cliente salvo continua cliente: o `Select` não inverte o padrão;
 *   4. o painel mostra o selo "Fornecedor" lido da COLUNA;
 *   5. o painel NÃO mostra selo para cliente — o padrão não vira etiqueta de
 *      toda conversa (é o que separa "reflete o tipo" de "carimba todo mundo").
 *
 * A prova de banco (coluna, default, CHECK, índice, e fornecedor SEGUINDO
 * elegível ao envio) mora em `tests/invariants/contato-tipo-coluna.test.ts`,
 * que roda por `pnpm test:db` — invariante de banco não roda por `vitest run`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";
import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import type { Contact } from "@/lib/types/contacts";

/** O `patch` da API, espiado — é o corpo do PATCH que a rota receberia. */
const patch = vi.fn();
const get = vi.fn();

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    patch: (...args: unknown[]) => patch(...args),
  },
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  // A ficha lê o país da org; o painel, o papel do usuário (podeCriarTarefa).
  useActiveOrg: () => ({ currency: "BRL", country: null, orgId: "org-1" }),
  useAuth: () => ({ user: { support: null }, activeOrg: null }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));

const CONTATO_ID = "c0nt4t0-0000-4000-8000-000000000305";

/** O contato que a ficha abre: FORNECEDOR gravado na coluna. */
const CONTATO_FORNECEDOR = {
  id: CONTATO_ID,
  organization_id: "org-1",
  name: "Operadora Sul",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: null,
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  blocked_reason: null,
  is_personal: false,
  contact_type: "fornecedor",
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: [],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-01T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

/** O mesmo contato, cliente (o default da coluna). */
const CONTATO_CLIENTE = { ...CONTATO_FORNECEDOR, contact_type: "cliente" } satisfies Contact;

function envolver(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** O corpo do PATCH que o `Salvar` mandou (prova o que a rota receberia). */
function corpoDoPatch(): Record<string, unknown> {
  expect(patch, "a ficha não mandou PATCH nenhum").toHaveBeenCalled();
  const [, enviado] = patch.mock.calls.at(-1) as [string, Record<string, unknown>];
  return enviado;
}

beforeEach(() => {
  // Radix Select em jsdom: o gatilho usa captura de ponteiro e o conteúdo rola
  // até o item — nenhum dos dois existe aqui (mesma preparação de
  // tests/unit/inbox-filtro-de-tag-nao-desmonta.test.tsx).
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  patch.mockReset();
  patch.mockResolvedValue({ data: { contact: CONTATO_FORNECEDOR } });
  get.mockReset();
  get.mockResolvedValue({
    data: { leads: [], orders: [], activities: [], demandas: [], fatos: [], historico: [] },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ficha do contato — o seletor de tipo (issue 3005, fatia 1)", () => {
  it("abre com o tipo da COLUNA, e não com o padrão", async () => {
    envolver(<EditContactDialog contact={CONTATO_FORNECEDOR} open onOpenChange={vi.fn()} />);

    // O gatilho do Radix mostra o valor atual: 'fornecedor' gravado aparece —
    // se o diálogo abrisse sempre 'cliente', este caso cai.
    const gatilho = await screen.findByRole("combobox", { name: "Tipo de contato" });
    expect(gatilho).toHaveTextContent("Fornecedor");
  });

  it("trocar para Fornecedor e salvar persiste o tipo no PATCH", async () => {
    const user = userEvent.setup({ delay: null });
    envolver(<EditContactDialog contact={CONTATO_CLIENTE} open onOpenChange={vi.fn()} />);

    // Cliente gravado: o gatilho abre em Cliente (o default do banco).
    const gatilho = await screen.findByRole("combobox", { name: "Tipo de contato" });
    expect(gatilho).toHaveTextContent("Cliente");

    await user.click(gatilho);
    await user.click(await screen.findByRole("option", { name: "Fornecedor" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    // O caminho de escrita da ficha: o tipo VAI no payload, com o valor escolhido.
    expect(patch.mock.calls.at(-1)?.[0]).toBe(`/api/v1/contacts/${CONTATO_ID}`);
    expect(corpoDoPatch().contact_type).toBe("fornecedor");
  });

  it("salvar sem mexer no seletor mantém cliente (o padrão não vira fornecedor)", async () => {
    const user = userEvent.setup({ delay: null });
    envolver(<EditContactDialog contact={CONTATO_CLIENTE} open onOpenChange={vi.fn()} />);

    await screen.findByRole("combobox", { name: "Tipo de contato" });
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(corpoDoPatch().contact_type).toBe("cliente");
  });
});

/** A conversa do painel — o mesmo formato que a rota de conversas devolve. */
function conversaCom(tipo: string) {
  return {
    id: "cv-3005",
    organization_id: "org-1",
    contact_id: CONTATO_ID,
    tags: [],
    contacts: {
      id: CONTATO_ID,
      display_name: "Operadora Sul",
      name: null,
      phone_number: "5511999",
      tags: [],
      contact_type: tipo,
    },
  } as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];
}

describe("painel da conversa — o selo do tipo (issue 3005, fatia 1)", () => {
  it("mostra 'Fornecedor' para quem a coluna marca como fornecedor", async () => {
    envolver(<CRMSidePanel conversation={conversaCom("fornecedor")} />);

    expect(await screen.findByText("Fornecedor")).toBeTruthy();
  });

  it("não carimba 'cliente' em toda conversa — o padrão não tem selo", async () => {
    envolver(<CRMSidePanel conversation={conversaCom("cliente")} />);

    // O cartão do contato renderizou (o nome está lá) e NÃO há selo de tipo:
    // um selo em toda conversa não informaria nada (a régua do "Pessoal").
    expect(await screen.findByText("Operadora Sul")).toBeTruthy();
    expect(screen.queryByText("Fornecedor")).toBeNull();
  });
});
