import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * O PAINEL "ATIVIDADE" DA CONVERSA DIZ QUAL INTEGRAÇÃO AGIU (#5160, item 2).
 *
 * A linha feita por token chega do `crm-summary` com `integracao: { nome }`.
 * O painel desenhava "Sistema" para ela, como para a plataforma agindo
 * sozinha. Agora: "Integração · <nome>"; sem nome, "Integração"; a linha de
 * sistema de verdade (`integracao: null`) segue "Sistema". O nome do token não
 * passa por `t()` (dado do operador, #1046/#3649).
 */

const ORG = "00000000-0000-4000-8000-0000000005bb";
const CONTATO = "c0000000-0000-4000-8000-0000000000b1";

const cenario = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/components/inbox/TarefasDaDemanda", () => ({ TarefasDaDemanda: () => null }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-eu", role: "agent", support: null, is_platform_admin: false },
    activeOrg: { orgId: "00000000-0000-4000-8000-0000000005bb", name: "Org", role: "agent" },
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => cenario.get(...args),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));
vi.mock("@/components/contacts/CartaoDaCarteira", () => ({ CartaoDaCarteira: () => null }));

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

const conversa = {
  id: "cv-1",
  organization_id: ORG,
  contact_id: CONTATO,
  channel_session_id: "cs-1",
  status: "open",
  tags: [],
  assigned_to_user_id: null,
  bot_silenced_until: null,
  service_revision: 1,
  current_demanda_id: null,
  last_inbound_at: "2026-11-14T12:00:00Z",
  unread_count_for_assignee: 0,
  channel_sessions: null,
  contacts: {
    id: CONTATO,
    display_name: "Oficina do Zé",
    name: null,
    phone_number: "5585999998888",
    tags: [],
    is_anonymized: false,
  },
} as unknown as ConversationWithContact;

function linha(id: string, reason: string, integracao: { nome: string | null } | null) {
  return {
    id,
    type: "stage_changed",
    source_module: "crm",
    performed_at: "2026-11-20T12:00:00Z",
    payload: {},
    reason,
    actor_kind: "system",
    performed_by_name: null,
    integracao,
  };
}

cenario.get.mockImplementation(async (url?: string) => {
  if (String(url ?? "").includes("crm-summary")) {
    return {
      data: {
        leads: [],
        orders: [],
        activities: [
          linha("a-1", "Pelo Zapier", { nome: "Zapier" }),
          linha("a-2", "Por token sem nome", { nome: null }),
          linha("a-3", "Pela plataforma", null),
        ],
        demandas: [],
        fatos: [],
        historico: [],
        recusa_de_ofertas: null,
      },
    };
  }
  return { data: [] };
});

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CRMSidePanel conversation={conversa} />
    </QueryClientProvider>,
  );
}

/** O rodapé da linha cuja razão é `razao` ("<autor> · <data>"). */
async function autorDa(razao: string): Promise<string> {
  const motivo = await screen.findByText(razao);
  const item = motivo.closest("li");
  const rodape = item?.lastElementChild?.textContent ?? "";
  return rodape.split(" · ").slice(0, -1).join(" · ");
}

describe("#5160 — painel Atividade: a linha do token diz a integração", () => {
  it("token com nome: «Integração · Zapier»", async () => {
    montar();
    expect(await autorDa("Pelo Zapier")).toBe("Integração · Zapier");
  });

  it("token sem nome: «Integração»", async () => {
    montar();
    expect(await autorDa("Por token sem nome")).toBe("Integração");
  });

  it("sistema de verdade continua «Sistema»", async () => {
    montar();
    expect(await autorDa("Pela plataforma")).toBe("Sistema");
  });
});
