/**
 * A FICHA MOSTRA OS TELEFONES EXTRAS (Spec 31, B1, item 3; tela de B2, item 7).
 *
 * Com extra, o bloco "Telefones" lista o principal e cada extra com tipo,
 * WhatsApp, rótulo e, quando veio de uma junção de fichas, a origem. Sem extra,
 * a linha "Telefone" segue como hoje, com o tipo ao lado do número. Quem tem
 * papel `agent` ou acima vê as ações de editar; quem só lê, não.
 *
 * Mesmo molde de `ficha-mostra-a-origem-da-campanha.test.tsx`: a ficha renderiza
 * com um contato controlado pelo teste, e o controle de vacuidade garante que o
 * título apareceu antes de se afirmar a ausência de qualquer coisa.
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ─────────────────────
 * - Tirar o `BlocoDeTelefones` (a ficha volta a mostrar só o principal): o caso
 *   "mostra o extra" cai.
 * - Trocar o rótulo de origem `fusao` por nada: o caso "veio da junção" cai.
 * - Editar o bloco (B2): os casos de papel e de "Tornar principal" abaixo caem.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContactDetailClient } from "@/app/app/contacts/[id]/_client";
import type { Contact } from "@/lib/types/contacts";

const ORG = { orgId: "org-1", name: "Loja", role: "admin", cliente_pela_agenda: false };
const USER = { id: "u-1", is_platform_admin: false, support: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ORG,
  useAuth: () => ({ user: USER, activeOrg: ORG }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({
    isLoading: false,
    isError: false,
    data: { data: contato },
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null }),
}));
vi.mock("@/components/contacts/TimelineView", () => ({ TimelineView: () => null }));
vi.mock("@/components/contacts/EditContactDialog", () => ({ EditContactDialog: () => null }));
vi.mock("@/components/contacts/AnonymizeDialog", () => ({ AnonymizeDialog: () => null }));
vi.mock("@/components/contacts/PropostasDeDado", () => ({ PropostasDeDado: () => null }));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));

const BASE = {
  id: "c-1",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: "Joana",
  email: null,
  email_normalized: null,
  phone_number: "+5511999998888",
  phone_type: "celular",
  phone_whatsapp: "sim",
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  is_personal: false,
  blocked_reason: null,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: [],
  source: "whatsapp",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-01-01T10:00:00.000Z",
  updated_at: "2026-01-01T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

let contato: Contact = BASE;

function abrirFicha(extra: Partial<Contact>) {
  contato = { ...BASE, ...extra };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const comQuery = (ui: ReactNode) => <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
  render(comQuery(<ContactDetailClient contactId="c-1" />));
  // Controle de vacuidade: a ficha renderizou.
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Joana");
}

/** Só os dígitos do texto: o formato de exibição do número não é o que este teste prova. */
function digitosDoTextoDe(elemento: HTMLElement): string {
  return (elemento.textContent ?? "").replace(/\D/g, "");
}

describe("a ficha do contato mostra os telefones extras", () => {
  it("com extra: o bloco Telefones lista o principal e o extra, com tipo, WhatsApp, rótulo e origem", () => {
    abrirFicha({
      additional_phones: [
        {
          phone_number: "+5521977776666",
          type: "celular",
          whatsapp: "nao_sei",
          label: "Trabalho",
          origin: "fusao",
          created_at: "2026-10-02T10:00:00.000Z",
        },
      ],
    });

    const titulo = screen.getByText("Telefones", { selector: "dt" });
    const bloco = titulo.parentElement as HTMLElement;
    expect(digitosDoTextoDe(bloco)).toContain("5511999998888");
    expect(digitosDoTextoDe(bloco)).toContain("5521977776666");
    expect(bloco).toHaveTextContent("Principal");
    expect(bloco).toHaveTextContent("Trabalho");
    expect(bloco).toHaveTextContent("WhatsApp: não sabemos");
    expect(bloco).toHaveTextContent("Veio da junção de fichas");
    // A linha "Telefone" sozinha não aparece quando há extra.
    expect(screen.queryByText("Telefone", { selector: "dt" })).toBeNull();
  });

  it("sem extra: a linha Telefone segue como hoje, com o tipo ao lado do número", () => {
    abrirFicha({ additional_phones: [] });

    const titulo = screen.getByText("Telefone", { selector: "dt" });
    const linha = titulo.parentElement as HTMLElement;
    expect(digitosDoTextoDe(linha)).toContain("5511999998888");
    expect(linha).toHaveTextContent("Celular");
    expect(screen.queryByText("Telefones", { selector: "dt" })).toBeNull();
  });
});

describe("a ficha editável por papel (Spec 31, B2, item 7)", () => {
  const extraBase = {
    id: "ex-1",
    phone_number: "+5521977776666",
    type: "celular" as const,
    whatsapp: "nao_sei" as const,
    label: "Trabalho",
    origin: "manual" as const,
    created_at: "2026-10-02T10:00:00.000Z",
  };
  const papelOriginal = ORG.role;

  afterEach(() => {
    ORG.role = papelOriginal;
  });

  it("agent ou acima: o extra tem 'Tornar principal' e o principal não tem", () => {
    ORG.role = "agent";
    abrirFicha({ additional_phones: [extraBase] });

    // Sabotagem: mostrar "Tornar principal" também no principal faz este caso contar dois botões.
    expect(screen.getAllByRole("button", { name: "Tornar principal" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Adicionar telefone" })).toBeInTheDocument();
  });

  it("remover o principal com extra existente: botão desabilitado, com a dica", () => {
    ORG.role = "agent";
    abrirFicha({ additional_phones: [extraBase] });

    // O primeiro "Remover" da lista é o do principal (ele vem antes dos extras).
    const [removerDoPrincipal] = screen.getAllByRole("button", { name: "Remover" });
    // Sabotagem: tirar o `disabled` do botão do principal faz este caso cair.
    expect(removerDoPrincipal).toBeDisabled();
    expect(
      screen.getByText("Torne outro número principal antes de remover este."),
    ).toBeInTheDocument();
  });

  it("só leitura (viewer): nenhuma ação de editar aparece", () => {
    ORG.role = "viewer";
    abrirFicha({ additional_phones: [extraBase] });

    // Só o bloco de telefones: a ficha tem outros botões "Editar" fora dele.
    const bloco = screen.getByText("Telefones", { selector: "dt" }).parentElement as HTMLElement;
    // Sabotagem: deixar de checar o papel na ficha faz este caso encontrar botões.
    expect(within(bloco).queryByRole("button", { name: "Tornar principal" })).toBeNull();
    expect(within(bloco).queryByRole("button", { name: "Adicionar telefone" })).toBeNull();
    expect(within(bloco).queryByRole("button", { name: "Editar" })).toBeNull();
    expect(bloco).toHaveTextContent("Trabalho");
  });
});
