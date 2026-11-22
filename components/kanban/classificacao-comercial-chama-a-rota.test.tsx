// components/kanban/classificacao-comercial-chama-a-rota.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import type { Lead } from "@/lib/types/leads";

import { LeadDossier } from "./LeadDossier";

/**
 * #4191, item 1 do mantenedor — A TELA CHAMA A ROTA.
 *
 * O defeito era exatamente este: a rota `POST`/`DELETE …/classificacao-comercial`
 * existia, testada, e NENHUMA tela a chamava. O fragmento em `.changes/` dizia
 * que "a ficha do negócio tem a classificação" e isso não era verdade. Um teste
 * que só renderizasse o bloco deixaria o buraco de pé — a cerca tem de ver o
 * `apiClient` sendo chamado com o caminho e o corpo certos.
 *
 * O segundo caso é o do TEXTO: a frase sai do dicionário (`useT`), e a chave
 * crua é a portuguesa que está no `DICIONARIO`. Se alguém trocar a frase no
 * componente sem entrar no dicionário, a tela em espanhol volta a mostrar
 * português — por isso a asserção do dicionário mora aqui, junto da tela.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false, support: false }),
  useActiveOrg: () => ({ role: "agent" }),
  usePermission: () => true,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => undefined) }),
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
vi.mock("@/hooks/leads/useContatosRelacionados", () => ({
  chaveDosContatosRelacionados: (leadId: string | null) => ["contatos-relacionados", leadId],
  useContatosRelacionados: () => ({ data: { data: [] }, isLoading: false, isError: false }),
}));
vi.mock("./ContatoDoNegocio", () => ({ ContatoDoNegocio: () => <div data-peca="contato" /> }));
// A main trouxe o bloco de vendas para a ficha; ele chama `useQuery`, que este
// teste não monta (o dublê de react-query só tem `useQueryClient`). O que se
// mede aqui é a classificação comercial, então o bloco de vendas é dublado como
// as outras peças da ficha.
vi.mock("@/components/vendas/VendasDoNegocio", () => ({ VendasDoNegocio: () => null }));
vi.mock("./LeadFieldsForm", () => ({ LeadFieldsForm: () => <div data-peca="campos" /> }));
vi.mock("./RevisaoDoDocumento", () => ({ RevisaoDoDocumento: () => null }));
vi.mock("./TarefasDoNegocio", () => ({ TarefasDoNegocio: () => <div data-peca="tarefas" /> }));
vi.mock("./PropostasDoNegocio", () => ({ PropostasDoNegocio: () => null }));
vi.mock("./ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("./ScoreSlot", () => ({ ScoreSlot: () => null }));
vi.mock("./OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("./LeadTimeline", () => ({ LeadTimeline: () => <ul data-peca="linha-do-tempo" /> }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), delete: vi.fn(), patch: vi.fn() },
}));

const CAMINHO = "/api/v1/leads/lead-1/classificacao-comercial";

const leadBase = {
  id: "lead-1",
  title: "Viagem Rio",
  contact_id: "contato-1",
  contact_phone: "+552****9999",
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
  nao_comercial_em: null,
  nao_comercial_motivo: null,
  nao_comercial_por: null,
};

function montar(over: Partial<Lead> = {}) {
  const lead = { ...leadBase, ...over } as unknown as Lead;
  return render(
    <LeadDossier
      open
      onOpenChange={() => undefined}
      lead={lead}
      pipelineId="funil-1"
      fieldDefs={[]}
      stageName="Novo"
      etapas={[
        { id: "etapa-1", name: "Novo" },
        { id: "etapa-2", name: "Fechado" },
      ]}
      onMudarEtapa={() => undefined}
    />,
  );
}

beforeEach(() => {
  vi.mocked(apiClient.post).mockReset();
  vi.mocked(apiClient.delete).mockReset();
});

describe("#4191 item 1 — a ficha do negócio chama a rota", () => {
  it("classifica pelo botão da ficha, com o motivo digitado no corpo do POST", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { lead: { ...leadBase, nao_comercial_em: "2026-11-19T12:00:00.000Z" } },
    });
    montar();

    // O bloco existe e diz o estado de sempre: comercial.
    const bloco = screen.getByTestId("classificacao-comercial");
    expect(bloco).toHaveTextContent("Comercial");

    await user.click(screen.getByRole("button", { name: "Classificar como não comercial" }));
    await user.type(screen.getByRole("textbox"), "golpe");
    await user.click(screen.getByRole("button", { name: "Confirmar classificação" }));

    expect(apiClient.post).toHaveBeenCalledWith(CAMINHO, { motivo: "golpe" });
  });

  it("devolve ao comercial pelo DELETE da mesma rota", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockResolvedValue({ data: { lead: { ...leadBase } } });
    montar({
      nao_comercial_em: "2026-11-18T10:00:00.000Z",
      nao_comercial_motivo: "golpe",
      nao_comercial_por: "11111111-1111-4111-8111-111111111111",
    });

    const bloco = screen.getByTestId("classificacao-comercial");
    expect(bloco).toHaveTextContent("Não comercial");
    expect(screen.getByTestId("classificacao-motivo")).toHaveTextContent("golpe");

    await user.click(screen.getByRole("button", { name: "Restaurar como comercial" }));
    await user.click(screen.getByRole("button", { name: "Confirmar classificação" }));

    expect(apiClient.delete).toHaveBeenCalledWith(CAMINHO);
  });

  it("o motivo curto é recusado ANTES da rota, com a frase da régua", async () => {
    const user = userEvent.setup();
    montar();

    await user.click(screen.getByRole("button", { name: "Classificar como não comercial" }));
    await user.type(screen.getByRole("textbox"), "ab");
    await user.click(screen.getByRole("button", { name: "Confirmar classificação" }));

    expect(apiClient.post).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "O motivo precisa de pelo menos 3 caracteres.",
    );
  });

  it("negócio encerrado não oferece a ação (a régua do servidor recusaria)", () => {
    montar({ status: "won" as Lead["status"] });
    expect(screen.queryByRole("button", { name: "Classificar como não comercial" })).toBeNull();
  });

  it("o texto da tela está no dicionário — a tecla portuguesa traduz para espanhol", () => {
    for (const chave of [
      "Classificação comercial",
      "Comercial",
      "Não comercial",
      "Classificar como não comercial",
      "Restaurar como comercial",
      "Confirmar classificação",
      "Motivo da classificação",
      "Salvando…",
      "Cancelar",
      "Motivo apagado pela anonimização",
      "O negócio não será ganho, perdido nem apagado. A classificação pode ser desfeita.",
      "Restaurar não retoma follow-ups antigos. Uma demanda nova precisa ser iniciada pela equipe.",
      "Histórico preservado. Este negócio fica fora do Radar e das métricas comerciais, e os follow-ups dele não enviam.",
      "Este contato foi anonimizado. A classificação não pode ser restaurada.",
      "Escreva o que decide o caso (golpe, spam, contato sem finalidade comercial…).",
      "Não foi possível confirmar o resultado. Recarregue antes de tentar novamente.",
    ]) {
      // A régua é TER ENTRADA explícita em espanhol, não "a string muda de
      // forma": há palavra idêntica nos dois idiomas ("Cancelar", "Comercial"),
      // e exigir diferença empurraria tradução errada só para o teste passar.
      // Chave ausente do dicionário, ou sem `es`, continua vermelho.
      expect(DICIONARIO[chave]?.es, `sem espanhol: ${chave}`).toBeTruthy();
      expect(traduzir(chave, "es")).toBe(DICIONARIO[chave]?.es);
    }
  });
});
