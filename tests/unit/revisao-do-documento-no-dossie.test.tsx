// tests/unit/revisao-do-documento-no-dossie.test.tsx
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeadDossier } from "@/components/kanban/LeadDossier";
import type { Lead } from "@/lib/types/leads";

/**
 * A REVISÃO DO DOCUMENTO É ALCANÇÁVEL NA TELA DO CARD (#3316).
 *
 * ─── O defeito que este arquivo mede ───────────────────────────────────────
 *
 * O #3415 entregou `GET`/`POST /api/v1/leads/[id]/field-proposals` com teste de
 * rota verde e NENHUM consumidor: nenhuma tela montava o componente, então a
 * pessoa que anexava o voucher não tinha como decidir nada. O mantenedor
 * chamou isso pelo nome — "a lista/decisão foi entregue como API sem consumidor
 * na tela".
 *
 * ─── Por que este teste é o discriminante, e não o do componente ───────────
 *
 * `RevisaoDoDocumento.test.tsx` prova que o componente FUNCIONA. Se ele for
 * arrancado do dossiê — a regressão exata que fechou o #3415 —, aquele arquivo
 * continua verde. Aqui o dossiê REAL é montado (com as peças vizinhas
 * substituídas por marcadores, como no teste de ordem das seções) e o que se
 * cobra é que a proposta lida no documento chegue ao DOM DO CARD: se a linha
 * `<RevisaoDoDocumento …>` sair de `LeadDossier.tsx`, este teste fica vermelho.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false, support: false }),
  // `agent`: pode confirmar o que o documento disse (a régua da rota).
  useActiveOrg: () => ({ role: "agent" }),
  usePermission: () => false,
}));
vi.mock("@/hooks/leads/useLeadTimeline", () => ({
  useLeadTimeline: () => ({
    itens: [],
    chegouAoVivo: new Set<string>(),
    isLoading: false,
    isError: false,
    realtimeStatus: "connected",
    seguranca: { divergencias: 0 },
  }),
}));

vi.mock("@/components/kanban/ContatoDoNegocio", () => ({ ContatoDoNegocio: () => null }));
vi.mock("@/components/kanban/TarefasDoNegocio", () => ({ TarefasDoNegocio: () => null }));
vi.mock("@/components/kanban/PropostasDoNegocio", () => ({ PropostasDoNegocio: () => null }));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("@/components/kanban/ScoreSlot", () => ({ ScoreSlot: () => null }));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("@/components/kanban/LeadTimeline", () => ({ LeadTimeline: () => null }));
// O formulário é a peça vizinha: o objeto aqui é a REVISÃO estar no card.
vi.mock("@/components/kanban/LeadFieldsForm", () => ({ LeadFieldsForm: () => null }));

window.HTMLElement.prototype.scrollIntoView ??= () => undefined;

const LEAD = {
  id: "lead-1",
  title: "Viagem Rio",
  contact_id: "contato-1",
  contact_phone: null,
  value_cents: 250000,
  currency: "BRL",
  score: null,
  conversa: null,
  custom_fields: {},
  owner_kind: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_agent: null,
} as unknown as Lead;

const PROPOSTA = {
  id: "p1",
  campo: "localizador",
  rotulo: "Localizador",
  tipo: "text",
  valor_atual: null,
  valor_proposto: "ABC123",
  trecho: "Localizador: ABC123 — confirmação da reserva",
  documento: null,
  expires_at: "2099-01-01T00:00:00.000Z",
};

describe("a revisão do documento aparece NO CARD do negócio (#3316)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { propostas: [PROPOSTA] } }),
        } as Response),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("⭐ o dossiê do negócio monta a proposta lida no documento, com trecho e decisão", async () => {
    render(
      <LeadDossier
        open
        onOpenChange={() => undefined}
        lead={LEAD}
        pipelineId="funil-1"
        fieldDefs={[]}
        stageName="Novo"
      />,
    );

    // O DOM do card: a proposta está DENTRO da seção dos campos do negócio.
    const revisao = await screen.findByText(/Localizador: ABC123/);
    const secao = document.querySelector('[data-secao="dados-do-negocio"]');
    expect(secao, "a seção dos campos não está no dossiê").not.toBeNull();
    expect(secao!.contains(revisao)).toBe(true);

    // E com o que se precisa para decidir: o valor, o "hoje" e o botão.
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Está certo, salvar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeInTheDocument();

    // A rota chamada é a do CARD deste negócio — não uma lista global.
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/v1/leads/lead-1/field-proposals");
  });
});
