// O dossiê, a revisão e o formulário são reais; as peças vizinhas não participam desta escrita.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import { LeadDossier } from "@/components/kanban/LeadDossier";
import type { Lead } from "@/lib/types/leads";

/**
 * Confirmação e edição local compartilham o formulário real. Uma proposta
 * aceita precisa aparecer no input e no baseline do diff, sem apagar outro
 * campo que a pessoa já estava digitando. A troca de card não repete eventos.
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
// Revisão e formulário reais: a confirmação não pode ficar invisível no campo.


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
  custom_fields: { medida: 0, localizador: "ANTES" },
  owner_kind: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_agent: null,
} as unknown as Lead;


const h = vi.hoisted(() => ({ mutateAsync: vi.fn(async (_input: { leadId: string; patch: Record<string, unknown> }) => undefined) }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));
vi.mock("@/components/inbox/ContactTagsEditor", () => ({ ContactTagsEditor: () => null }));
const FIELD_DEFS = [
  { key: "medida", label: "Medida do documento", type: "number" as const },
  { key: "localizador", label: "Localizador do card", type: "text" as const },
];

beforeEach(() => {
  h.mutateAsync.mockClear();
  let decidida = false;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      decidida = true;
      return new Response(JSON.stringify({ data: { decision: "accepted", campo: "medida", valor: 1.234 } }));
    }
    return new Response(JSON.stringify({ data: { propostas: decidida ? [] : [{
      id: "p1", campo: "medida", rotulo: "Medida do documento", tipo: "number",
      valor_atual: 0, valor_proposto: 1.234, trecho: "Medida sintética: 1,234",
      documento: null, expires_at: "2099-01-01T00:00:00Z",
    }] } }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("confirmar no dossiê atualiza o campo visível sem apagar outro rascunho", () => {
  it("conserva a escala na tela e o próximo Salvar leva somente a outra edição", async () => {
    const user = userEvent.setup();
    render(<LeadDossier open onOpenChange={() => undefined} lead={LEAD}
      pipelineId="funil-1" fieldDefs={FIELD_DEFS} stageName="Novo" />);
    const numero = screen.getByRole("spinbutton", { name: "Medida do documento" });
    const localizador = screen.getByRole("textbox", { name: "Localizador do card" });
    expect(numero).toHaveValue(0);
    await user.clear(localizador);
    await user.type(localizador, "MANUAL456");
    await user.click(await screen.findByRole("button", { name: /^Está certo, salvar$/ }));

    await waitFor(() => expect(numero).toHaveValue(1.234));
    expect(localizador).toHaveValue("MANUAL456");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled());
    expect(h.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      patch: { custom_fields: { localizador: "MANUAL456" } },
    });
    expect(h.mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty("patch.custom_fields.medida");
  });

  it("trocar de card e voltar não reaplica uma confirmação antiga sobre um dado novo", async () => {
    const user = userEvent.setup();
    const props = { open: true, onOpenChange: () => undefined, pipelineId: "funil-1", fieldDefs: FIELD_DEFS, stageName: "Novo" };
    const { rerender } = render(<LeadDossier {...props} lead={LEAD} />);
    await user.click(await screen.findByRole("button", { name: /^Está certo, salvar$/ }));
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Medida do documento" })).toHaveValue(1.234));
    rerender(<LeadDossier {...props} lead={{ ...LEAD, id: "outro-card", custom_fields: { medida: 7 } }} />);
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Medida do documento" })).toHaveValue(7));
    rerender(<LeadDossier {...props} lead={{ ...LEAD, custom_fields: { medida: 5 } }} />);
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Medida do documento" })).toHaveValue(5));
  });
});
