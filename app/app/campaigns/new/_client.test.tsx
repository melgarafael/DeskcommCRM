// app/app/campaigns/new/_client.test.tsx
/**
 * O AVISO DO TETO NA PRÉVIA (#2402, #2404).
 *
 * `buscarCandidatos` devolve `truncado` quando o recorte bate o teto de 20.000
 * linhas de negócio; a tela é o ÚNICO lugar onde esse recibo vira informação
 * para o operador. Sem este teste o campo viaja do banco até aqui sem ninguém
 * conferir a última ponta — e a prévia volta a cortar calada.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NovaCampanha } from "./_client";

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

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/campanhas/useCampanhas", () => ({
  useCriarCampanha: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

describe("prévia da nova campanha: o aviso do teto de 20.000", () => {
  beforeEach(() => {
    previa.data.truncado = false;
    previa.isPending = false;
  });

  it("recorte truncado: o operador VÊ o aviso na prévia", () => {
    previa.data.truncado = true;
    render(<NovaCampanha />);
    expect(screen.getByText(AVISO)).toBeInTheDocument();
  });

  it("recorte inteiro: nenhum aviso — o campo não vira ruído", () => {
    render(<NovaCampanha />);
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
  });
});
