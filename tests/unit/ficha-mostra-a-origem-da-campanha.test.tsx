/**
 * A FICHA MOSTRA DE QUAL CAMPANHA O CONTATO VEIO — E NÃO SÓ O LEITOR SABE.
 *
 * `tests/unit/origem-do-contato.test.ts` prova a precedência por campo de
 * `origemDoContato`. Ele não prova que a ficha a usa: reverter a linha
 * **Origem** para `contact.source`, ou apagar os níveis, deixava aquele
 * arquivo verde — e o único teste que renderiza a ficha usa
 * `source_metadata: {}` e não olha a origem. Este arquivo renderiza a ficha com
 * os dois caminhos de entrada que gravam campanha (link do site e clique em
 * anúncio) e com o contato que não veio de campanha nenhuma.
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
  phone_number: null,
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
} satisfies Contact;

let contato: Contact = BASE;

const FRASE = "A plataforma não informa o posicionamento de cada clique em anúncio.";

/**
 * `source` acompanha o caminho de entrada como a produção grava:
 * `fn_estampar_atribuicao_de_anuncio` faz `source = p_platform` — `site` no
 * link do site, o nome da plataforma no clique em anúncio.
 */
function abrirFicha(sourceMetadata: Record<string, unknown>, source = BASE.source) {
  contato = { ...BASE, source, source_metadata: sourceMetadata };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const comQuery = (ui: ReactNode) => <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
  render(comQuery(<ContactDetailClient contactId="c-1" />));
  // Controle de vacuidade: a ficha renderizou, então um nível ausente abaixo é
  // ausência de verdade, e não tela vazia.
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Joana");
}

/** O valor ao lado do rótulo, na `<dl>` da ficha — ou `null` se o rótulo não está lá. */
function valorDe(rotulo: string): string | null {
  const dt = screen.queryByText(rotulo, { selector: "dt" });
  return dt?.nextElementSibling?.textContent ?? null;
}

describe("a ficha do contato mostra a origem da campanha", () => {
  it("link do site: a origem é a fonte da campanha, e os quatro níveis aparecem", () => {
    abrirFicha(
      {
        ad_platform: "site",
        origem: "site",
        utm_source: "instagram",
        utm_campaign: "black-friday",
        utm_adset: "publico-quente",
        utm_ad: "video-01",
        utm_placement: "stories",
      },
      "site",
    );

    expect(valorDe("Origem")).toBe("instagram");
    expect(valorDe("Campanha")).toBe("black-friday");
    expect(valorDe("Conjunto")).toBe("publico-quente");
    expect(valorDe("Anúncio")).toBe("video-01");
    expect(valorDe("Posicionamento")).toBe("stories");
    expect(screen.queryByText(FRASE)).toBeNull();
  });

  it("clique em anúncio sem posicionamento: a ficha diz que a plataforma não informa", () => {
    abrirFicha({ ad_platform: "meta_ads", ad_title: "Promoção de verão" }, "meta_ads");

    expect(valorDe("Anúncio")).toBe("Promoção de verão");
    expect(screen.getByText(FRASE)).toBeInTheDocument();
  });

  it("contato que não veio de campanha: a coluna `source`, e nenhum nível vazio", () => {
    abrirFicha({});

    expect(valorDe("Origem")).toBe("whatsapp");
    for (const nivel of ["Campanha", "Conjunto", "Anúncio", "Posicionamento"]) {
      expect(valorDe(nivel), nivel).toBeNull();
    }
    expect(screen.queryByText(FRASE)).toBeNull();
  });
});
