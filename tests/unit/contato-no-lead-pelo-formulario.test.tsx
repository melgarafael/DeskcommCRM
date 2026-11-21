/**
 * O NEGÓCIO JÁ CRIADO PASSA A RECEBER CONTATO PELA TELA (fatia S3 da #852).
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * `updateLeadSchema` aceita `contact_id` desde sempre (`lib/schemas/leads.ts`) e
 * o `PATCH /api/v1/leads/{id}` grava o campo — o servidor nunca foi o
 * obstáculo. Quem nascia pelo funil ficava oco porque NENHUMA TELA mandava o
 * campo: o "Editar lead" do card não tinha contato nenhum, e o dossiê só sabia
 * dizer "Este negócio não tem contato vinculado.".
 *
 * ─── O que estes casos travam ───────────────────────────────────────────────
 *
 * 1. negócio oco + contato escolhido → o PATCH leva o `contact_id` do contato
 *    CERTO (o escolhido, não o primeiro da lista);
 * 2. negócio que já tinha contato → o nome de quem está lá aparece, e trocar
 *    manda o novo;
 * 3. salvar sem mexer no contato → o campo NÃO viaja (nada de revalidação nem
 *    de troca fantasma a cada salvamento);
 * 4. nenhum POST no caminho: este fluxo não cria contato, então não nasce
 *    duplicado por aqui.
 *
 * Sem a linha do `contact_id` no `patch`, os casos 1 e 2 ficam vermelhos.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", currency: "BRL" }),
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: "agent" } }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const CONTATO_A = "6f1b6f5e-0000-4000-8000-0000000000a1";
const CONTATO_B = "6f1b6f5e-0000-4000-8000-0000000000b2";

const api = vi.hoisted(() => {
  const contatos = [
    {
      id: "6f1b6f5e-0000-4000-8000-0000000000a1",
      name: "Ana Prado",
      display_name: null,
      phone_number: "+5531999990001",
    },
    {
      id: "6f1b6f5e-0000-4000-8000-0000000000b2",
      name: "Bruno Lima",
      display_name: null,
      phone_number: "+5531999990002",
    },
  ];
  return {
    contatos,
    get: vi.fn(async (url: string) => {
      // A busca da lista (o seletor) e a leitura de um contato (o nome de quem
      // já está vinculado) são rotas diferentes: o falso respeita as duas.
      if (url.startsWith("/api/v1/contacts?")) {
        const termo = decodeURIComponent(url.split("search=")[1]?.split("&")[0] ?? "");
        const achados = termo
          ? contatos.filter((c) => (c.name ?? "").toLowerCase().includes(termo.toLowerCase()))
          : contatos;
        return { data: achados, meta: { has_more: false } };
      }
      if (url.startsWith("/api/v1/contacts/")) {
        const id = url.split("/").pop();
        return { data: contatos.find((c) => c.id === id) ?? null };
      }
      return { data: [] };
    }),
    post: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: { id: "l-1", title: "Pacote Lisboa" } })),
  };
});

vi.mock("@/lib/api/client", () => ({ apiClient: api }));

import { EditLeadDialog } from "@/components/kanban/EditLeadDialog";

const negocio = (contactId: string | null) =>
  ({
    id: "l-1",
    title: "Pacote Lisboa",
    description: null,
    value_cents: null,
    currency: "BRL",
    tags: [],
    expected_close_date: null,
    custom_fields: {},
    contact_id: contactId,
  }) as never;

function montar(ui: React.ReactElement) {
  const c = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={c}>{ui}</QueryClientProvider>);
}

const corpos = () => api.patch.mock.calls.map((c) => (c as unknown[])[1] as Record<string, unknown>);

beforeEach(() => {
  api.get.mockClear();
  api.post.mockClear();
  api.patch.mockClear();
});
afterEach(() => cleanup());

describe("o contato do negócio no Editar lead (fatia S3 da #852)", () => {
  it("negócio oco: escolher um contato manda o contact_id DELE, sem criar contato novo", async () => {
    const onOpenChange = vi.fn();
    montar(<EditLeadDialog open onOpenChange={onOpenChange} lead={negocio(null)} pipelineId="p-1" />);
    const u = userEvent.setup();

    expect(await screen.findByText("Este negócio não tem contato vinculado.")).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Escolher contato" }));
    await u.type(screen.getByLabelText("Buscar contato"), "Bruno");
    // A lista é a do servidor filtrada pelo termo: sobra o Bruno, e é o botão
    // dele que a pessoa aperta.
    await screen.findByText("Bruno Lima");
    expect(screen.queryByText("Ana Prado")).toBeNull();
    await u.click(screen.getByRole("button", { name: "Usar" }));

    await u.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());

    expect(corpos()[0]).toMatchObject({ contact_id: CONTATO_B });
    // O contato escolhido é o do vínculo — não o primeiro da busca anterior.
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("search=Bruno"));
    // NENHUM contato nasce neste fluxo: a criação tem uma régua só (o cadastro).
    expect(api.post).not.toHaveBeenCalled();
  });

  it("negócio que já tem contato: mostra o nome de quem está lá e troca pelo escolhido", async () => {
    montar(<EditLeadDialog open onOpenChange={vi.fn()} lead={negocio(CONTATO_A)} pipelineId="p-1" />);
    const u = userEvent.setup();

    expect(await screen.findByText("Ana Prado")).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Trocar contato" }));
    await u.type(screen.getByLabelText("Buscar contato"), "Bruno");
    await screen.findByText("Bruno Lima");
    await u.click(screen.getByRole("button", { name: "Usar" }));

    await u.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());

    expect(corpos()[0]).toMatchObject({ contact_id: CONTATO_B });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("salvar sem mexer no contato não reenvia o vínculo que já estava gravado", async () => {
    montar(<EditLeadDialog open onOpenChange={vi.fn()} lead={negocio(CONTATO_A)} pipelineId="p-1" />);
    const u = userEvent.setup();

    expect(await screen.findByText("Ana Prado")).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());

    expect(corpos()[0]).not.toHaveProperty("contact_id");
  });
});
