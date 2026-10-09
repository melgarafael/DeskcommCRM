/**
 * O AVISO NA TELA (issue #1751) — mostra, dá link, e quem RECUSA não cria nada.
 *
 * ─── Os três casos do critério de aceite ─────────────────────────────────────
 *
 * 1. segundo negócio aberto para o MESMO contato no MESMO funil → o diálogo
 *    para no aviso com link para o que já existe, e o novo só nasce se a
 *    pessoa confirmar ("cria mesmo assim, se confirmado");
 * 2. o negócio aberto do contato está em OUTRO funil → nada de aviso, o
 *    cadastro segue direto (duplicidade é mesma pessoa + mesmo funil);
 * 3. quem recusa o aviso → NENHUMA chamada de criação. Recusar não pode nem
 *    chegar perto da rede.
 *
 * O quarto caso é o caminho sem quadro na mão (Inbox, que já recebe o
 * `contactId`): ali a confirmação prévia não existe, e quem avisa é a
 * `meta.avisos` que a API devolve — a tela mostra o link depois de criar, nunca
 * em silêncio.
 *
 * A régua de produto vem da migration 0256: um cliente PODE ter dois negócios
 * abertos, então isto é aviso, não bloqueio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Contact } from "@/lib/types/contacts";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";

const criarLead = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/kanban/useCreateLead", () => ({
  useCreateLead: () => ({ mutateAsync: criarLead, isPending: false }),
}));

const busca = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: (filtros: { search?: string }) => busca(filtros),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";

const FUNIL = "33333333-3333-4333-8333-333333333333";
const FUNIL_OUTRO = "44444444-4444-4444-8444-444444444444";

const ETAPA_ID = "11111111-1111-4111-8111-111111111111";
const ETAPAS = [
  {
    id: ETAPA_ID,
    name: "Novo",
    is_won: false,
    is_lost: false,
    is_archived: false,
  },
] as unknown as Stage[];

const MICHELLE = {
  id: "22222222-2222-4222-8222-222222222222",
  display_name: "Michelle",
  name: null,
  phone_number: "5511988887777",
  is_anonymized: false,
  tags: [],
} as unknown as Contact;

const NEGOCIO_ABERTO = "55555555-5555-4555-8555-555555555555";

/** Um lead do quadro — o diálogo só precisa de id/title/pipeline/contact/status. */
function negocio(sobrescreve: Partial<Lead> = {}): Lead {
  return {
    id: NEGOCIO_ABERTO,
    title: "Michelle — contrato antigo",
    organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pipeline_id: FUNIL,
    stage_id: ETAPA_ID,
    contact_id: MICHELLE.id,
    status: "open",
    ...sobrescreve,
  } as unknown as Lead;
}

function paginaCom(contatos: Contact[]) {
  return { data: { pages: [{ data: contatos }] }, isLoading: false };
}

/** Escolhe o contato da base e preenche o título — o caminho até o submit. */
async function preencherEEnviar(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Contato"), "Michelle");
  await user.click(await screen.findByRole("button", { name: /Michelle/ }));
  await user.type(screen.getByLabelText("Título"), "Segundo negócio");
  await user.click(screen.getByRole("button", { name: "Criar lead" }));
}

function renderizar(leads?: Lead[], contactId?: string) {
  return render(
    <NewLeadDialog
      open
      onOpenChange={() => {}}
      pipelineId={FUNIL}
      stages={ETAPAS}
      leads={leads}
      contactId={contactId}
    />,
  );
}

beforeEach(() => {
  criarLead.mockReset();
  criarLead.mockResolvedValue({ data: { id: "lead-novo" } });
  busca.mockReset();
  busca.mockReturnValue(paginaCom([MICHELLE]));
  toast.success.mockReset();
  toast.error.mockReset();
  toast.warning.mockReset();
});

afterEach(cleanup);

describe("Novo Lead — aviso de negócio aberto duplicado, sem bloqueio", () => {
  it("mesmo funil: mostra o aviso com link para o existente, e cria só se confirmado", async () => {
    const user = userEvent.setup();
    renderizar([negocio()]);

    await preencherEEnviar(user);

    // O aviso aparece ANTES de qualquer chamada de criação.
    expect(criarLead).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Este contato já tem um negócio aberto neste funil."),
    ).toBeTruthy();
    expect(screen.getByText("Abrir mesmo assim?")).toBeTruthy();

    // O link aponta para o negócio que já está aberto — é ele que a pessoa
    // precisa ver antes de decidir.
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(`/app/pipelines/${FUNIL}?lead=${NEGOCIO_ABERTO}`);
    expect(link.textContent).toBe("Michelle — contrato antigo");

    // Confirmar → cria (aviso, nunca bloqueio).
    await user.click(screen.getByRole("button", { name: "Criar mesmo assim" }));
    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
  });

  it("quem RECUSA o aviso não cria nada — nenhuma chamada de criação", async () => {
    const user = userEvent.setup();
    renderizar([negocio()]);

    await preencherEEnviar(user);
    expect(await screen.findByText("Abrir mesmo assim?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Não criar" }));

    // Nem agora, nem depois: recusar não vira criação adiada.
    await new Promise((r) => setTimeout(r, 50));
    expect(criarLead).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("negócio aberto do contato em OUTRO funil → sem aviso, cria direto", async () => {
    const user = userEvent.setup();
    renderizar([negocio({ pipeline_id: FUNIL_OUTRO })]);

    await preencherEEnviar(user);

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Abrir mesmo assim?")).toBeNull();
  });

  it("sem quadro na mão (Inbox): o aviso vem da meta.avisos da API, com o link", async () => {
    // O diálogo aberto pelo Inbox recebe só o `contactId` — não há lista de
    // negócios do funil para conferir antes. Quem avisa ali é a resposta.
    criarLead.mockResolvedValue({
      data: { id: "lead-novo" },
      meta: {
        avisos: ["negocio_aberto_existente"],
        negocio_aberto_existente: { id: NEGOCIO_ABERTO, title: "Michelle — contrato antigo" },
      },
    });
    const user = userEvent.setup();
    renderizar(undefined, MICHELLE.id);

    await user.type(screen.getByLabelText("Título"), "Segundo negócio");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));

    const [, opcoes] = toast.warning.mock.calls[0] as [string, { description: unknown }];
    const descricao = opcoes.description as { props: { href: string; children: string } };
    expect(descricao.props.href).toBe(`/app/pipelines/${FUNIL}?lead=${NEGOCIO_ABERTO}`);
    expect(descricao.props.children).toBe("Michelle — contrato antigo");
  });
});
