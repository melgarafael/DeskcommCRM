// app/app/campaigns/[id]/edit/_client.test.tsx
/**
 * O AVISO DO TETO NA PRÉVIA DA EDIÇÃO (#2402, #2404).
 *
 * A mesma ponta da tela de criação, com a carga real por trás: o `truncado`
 * de `buscarCandidatos` só protege o operador se a edição — que é onde uma
 * campanha grande é conferida de novo — também mostrar o recibo.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditarCampanha } from "./_client";

const previa = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
  data: {
    total: 20_001,
    elegiveis: 500,
    excluidos: 0,
    motivos: {} as Record<string, number>,
    truncado: false,
    amostra: [] as Array<{ nome: string | null; motivo: string | null }>,
    legenda: {} as Record<string, string>,
  },
}));

const CAMPANHA = {
  id: "c1",
  name: "Reativação de clientes parados",
  status: "draft",
  channel_session_id: "",
  base_legal: "consent",
  lia_ref: null,
  audience_filter: { com_alguma_tag: ["vip"], limite: 100 },
  message_body: "Oi {{nome}}",
  pipeline_id: null,
  stage_id: null,
  agent_id: null,
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/campanhas/useCampanhas", () => ({
  useCampanha: () => ({ data: CAMPANHA, isLoading: false }),
  useEditarCampanha: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePreviaDaAudiencia: () => previa,
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [], isLoading: false }),
  channelLabel: (c: { display_name?: string | null }) => c.display_name ?? "Número sem nome",
}));
vi.mock("@/hooks/campanhas/useDestinoDaCampanha", () => ({
  useFunis: () => ({ data: [], isLoading: false }),
  useEtapas: () => ({ data: [], isLoading: false }),
  useAgentesPublicados: () => ({ data: [], isLoading: false }),
}));

const AVISO = /bateu o teto de 20\.000 negócios desta prévia/;

describe("prévia da edição de campanha: o aviso do teto de 20.000", () => {
  beforeEach(() => {
    previa.data.truncado = false;
    previa.isPending = false;
  });

  it("recorte truncado: a edição mostra o aviso", async () => {
    previa.data.truncado = true;
    render(<EditarCampanha id="c1" />);
    expect(await screen.findByText(AVISO)).toBeInTheDocument();
  });

  it("recorte inteiro: nenhum aviso", async () => {
    render(<EditarCampanha id="c1" />);
    expect(await screen.findByDisplayValue("Reativação de clientes parados")).toBeInTheDocument();
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
  });
});
