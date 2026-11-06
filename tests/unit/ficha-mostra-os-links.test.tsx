/**
 * A FICHA DO CONTATO MOSTRA OS LINKS (Instagram, site, Google…) — na aba
 * "Visão geral", logo depois do Telefone.
 *
 * Renderiza a ficha de verdade (mesmo molde de `ficha-mostra-a-origem-da-campanha`)
 * e prova três coisas que uma leitura de fonte não daria:
 *
 *  1. `link_site` gravado no `custom_fields` vira um `<a href>` seguro, aberto
 *     em outra aba;
 *  2. sem nenhum link válido a linha "Links" não aparece (nada de rótulo vazio);
 *  3. um `javascript:` vindo do banco não vira link — a leitura passa por
 *     `linksParaExibir`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

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

function abrirFicha(customFields: Record<string, unknown>) {
  contato = { ...BASE, custom_fields: customFields };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const comQuery = (ui: ReactNode) => <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
  render(comQuery(<ContactDetailClient contactId="c-1" />));
  // Controle de vacuidade: a ficha renderizou, então a ausência abaixo é de verdade.
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Joana");
}

/** A linha "Links" da `<dl>` — `null` quando ela não aparece. */
function linhaDeLinks(): HTMLElement | null {
  const dt = screen.queryByText("Links", { selector: "dt" });
  return dt ? (dt.parentElement as HTMLElement) : null;
}

describe("a ficha do contato mostra os links", () => {
  it("⭐ link_site gravado vira link seguro, em outra aba, depois do Telefone", () => {
    abrirFicha({ link_site: "exemplo.com.br" });

    const linha = linhaDeLinks();
    expect(linha).not.toBeNull();
    const site = screen.getByRole("link", { name: "Abrir Site" });
    expect(site).toHaveAttribute("href", "https://exemplo.com.br/");
    expect(site).toHaveAttribute("target", "_blank");
    expect(site).toHaveAttribute("rel", "noopener noreferrer");
    expect(linha).toContainElement(site);
  });

  it("sem nenhum link: a linha 'Links' não aparece", () => {
    abrirFicha({ cor_favorita: "azul" });

    expect(linhaDeLinks()).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("⭐ javascript: gravado no banco não vira link, e a linha some junto", () => {
    abrirFicha({ link_site: "javascript:alert(1)" });

    expect(linhaDeLinks()).toBeNull();
    expect(screen.queryByRole("link", { name: "Abrir Site" })).toBeNull();
  });
});
