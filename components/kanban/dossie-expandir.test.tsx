// components/kanban/dossie-expandir.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LeadDossier } from "./LeadDossier";
import type { Lead } from "@/lib/types/leads";

/**
 * O BOTÃO EXPANDIR E O DRAWER QUE NÃO PODE REGREDIR (#4151).
 *
 * ─── Por que os dois no mesmo arquivo ──────────────────────────────────────
 *
 * O botão mora no cabeçalho da gaveta, e o cabeçalho é a peça que qualquer
 * mexida no dossiê toca. Um PR que só provasse "o link existe" deixaria passar o
 * pior desfecho possível desta entrega: a gaveta parar de abrir/fechar porque o
 * cabeçalho virou outra coisa. Os dois casos ficam juntos para que o segundo
 * seja a cerca do primeiro.
 *
 * O que NÃO é medido aqui (e é honesto dizer): a navegação de verdade — clicar e
 * cair em `/app/leads/[id]/pagina` com o documento novo — é e2e. Aqui o contrato é o
 * `href`, que é o que o `<Link>` do Next entrega ao navegador.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false, support: false }),
  useActiveOrg: () => ({ role: "agent" }),
  // O seletor de etapa do cabeçalho lê a régua de mover card.
  usePermission: () => true,
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

vi.mock("./ContatoDoNegocio", () => ({ ContatoDoNegocio: () => <div data-peca="contato" /> }));
vi.mock("./LeadFieldsForm", () => ({ LeadFieldsForm: () => <div data-peca="campos" /> }));
vi.mock("./RevisaoDoDocumento", () => ({ RevisaoDoDocumento: () => null }));
vi.mock("./TarefasDoNegocio", () => ({ TarefasDoNegocio: () => <div data-peca="tarefas" /> }));
vi.mock("./PropostasDoNegocio", () => ({ PropostasDoNegocio: () => null }));
vi.mock("./ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("./ScoreSlot", () => ({ ScoreSlot: () => null }));
vi.mock("./OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("./LeadTimeline", () => ({
  LeadTimeline: () => <ul data-peca="linha-do-tempo" />,
}));

const LEAD = {
  id: "lead-1",
  title: "Viagem Rio",
  contact_id: "contato-1",
  contact_phone: "+552199999999",
  value_cents: 250000,
  currency: "BRL",
  stage_id: "etapa-1",
  status: "open",
  score: null,
  conversa: null,
  owner_kind: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_agent: null,
  updated_at: "2026-11-08T12:00:00.000Z",
} as unknown as Lead;

function montar(opcoes: { expandirHref?: string; onOpenChange?: (v: boolean) => void } = {}) {
  return render(
    <LeadDossier
      open
      onOpenChange={opcoes.onOpenChange ?? (() => undefined)}
      lead={LEAD}
      pipelineId="funil-1"
      fieldDefs={[]}
      stageName="Novo"
      etapas={[
        { id: "etapa-1", name: "Novo" },
        { id: "etapa-2", name: "Fechado" },
      ]}
      onMudarEtapa={() => undefined}
      expandirHref={opcoes.expandirHref}
    />,
  );
}

describe("o botão Expandir (#4151)", () => {
  it("aparece no cabeçalho do painel e aponta para a página do negócio", () => {
    const href = "/app/leads/lead-1/pagina?voltar=%2Fapp%2Fpipelines%2Ffunil-1%3Ftag%3Dquente";
    montar({ expandirHref: href });

    const link = screen.getByTestId("dossie-expandir");
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveTextContent("Expandir");
  });

  it("NÃO aparece sem endereço — a lista e o calendário seguem só com o painel", () => {
    montar();

    expect(screen.queryByTestId("dossie-expandir")).toBeNull();
  });
});

describe("o drawer continua abrindo e fechando (#4151, regressão)", () => {
  it("monta como diálogo e o fechar devolve `false` a quem abriu", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    montar({ onOpenChange });

    // A gaveta é a mesma de antes: diálogo modal, com o título do negócio.
    const painel = await screen.findByRole("dialog");
    expect(painel).toHaveTextContent("Viagem Rio");
    // E o conteúdo montou dentro dela — não sumiu na variante "painel".
    expect(screen.getByText("Dados do negócio")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Fechar" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
