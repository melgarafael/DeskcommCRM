/**
 * A FICHA DO CONTATO FALA O IDIOMA DA TELA (#4903).
 *
 * A aba "Timeline" e os rótulos "Email" e "Tags" estavam escritos direto no
 * código: com a tela em espanhol, a aba vizinha "Visão geral" virava "Resumen"
 * e esses três ficavam como estavam. Este arquivo renderiza a ficha com o
 * dicionário de verdade (sem mock de `useT`) nos dois idiomas.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContactDetailClient } from "@/app/app/contacts/[id]/_client";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { Contact } from "@/lib/types/contacts";

const ORG = { orgId: "org-1", name: "Loja", role: "admin", cliente_pela_agenda: false };
const USER = { id: "u-1", is_platform_admin: false, support: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ORG,
  useAuth: () => ({ user: USER, activeOrg: ORG }),
}));
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
  phone_number: null,
  cpf_available: false,
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

const contato: Contact = BASE;

afterEach(() => cleanup());

function abrirFicha(locale: "pt-BR" | "es") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <IdiomaProvider locale={locale}>
      <QueryClientProvider client={qc}>
        <ContactDetailClient contactId="c-1" />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
  // Controle de vacuidade: a ficha renderizou.
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Joana");
}

const rotulos = () => screen.getAllByText(/./, { selector: "dt" }).map((dt) => dt.textContent);

describe("a ficha do contato fala o idioma da tela", () => {
  it("em espanhol: a aba e os rótulos traduzidos", () => {
    abrirFicha("es");
    expect(screen.getByRole("tab", { name: "Línea de tiempo" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Timeline" })).toBeNull();
    expect(rotulos()).toContain("Correo");
    expect(rotulos()).toContain("Etiquetas");
    expect(rotulos()).not.toContain("Email");
    expect(rotulos()).not.toContain("Tags");
  });

  it("em português: a aba diz Linha do tempo, e Email e Tags continuam", () => {
    abrirFicha("pt-BR");
    expect(screen.getByRole("tab", { name: "Linha do tempo" })).toBeInTheDocument();
    expect(rotulos()).toContain("Email");
    expect(rotulos()).toContain("Tags");
  });
});
