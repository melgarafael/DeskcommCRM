/**
 * O FUNIL ARQUIVADO ABRE — E NÃO ESCREVE (#1298, item 1).
 *
 * O link da gaveta (`abrir-arquivado-<id>`) só é honesto se o quadro que ele
 * abre for LEITURA: o funil arquivado "não recebe negócio novo" é o que a
 * própria gaveta promete, e até aqui o endereço `/app/pipelines/<id>` de um
 * arquivado mostrava o quadro inteiro vivo — criar negócio, arrastar, menu de
 * ações, seleção em lote e dossiê. Medido renderizando a página: nada daquilo
 * olhava `is_archived`, que já vinha no payload do quadro.
 *
 * Cada `it` cai se a guarda dele for revertida.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Pipeline, Stage } from "@/lib/kanban/types";

/** O que o dublê do quadro registrou — é assim que se mede a prop, não a cor. */
const visto = vi.hoisted(() => ({
  somenteLeitura: null as boolean | null,
  podeRenomearEtapa: null as boolean | null,
}));

const arquivado = vi.hoisted(() => ({ valor: true }));
const carregando = vi.hoisted(() => ({ valor: false }));
const parametros = vi.hoisted(() => ({ valor: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/pipelines/p-1",
  useSearchParams: () => new URLSearchParams(parametros.valor),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  // Como o hook real: com `enabled: false` a consulta não roda e não há dado.
  useBoard: (_id: string, _lead: string | null, opcoes?: { enabled?: boolean }) => ({
    data: carregando.valor || opcoes?.enabled === false ? undefined : {
      pipeline: {
        id: "p-1",
        name: "Comercial 2025",
        vocabulary: null,
        settings: {},
        is_archived: arquivado.valor,
      },
      stages: [],
      leads: [],
    },
    isLoading: carregando.valor,
    error: null,
    pulses: [],
    realtimeStatus: "SUBSCRIBED",
    seguranca: { divergencias: 0, ultimaVerificacao: null },
  }),
}));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));
vi.mock("@/components/kanban/BulkActionBar", () => ({ BulkActionBar: () => null }));
vi.mock("@/components/kanban/ListaDoFunil", () => ({ ListaDoFunil: () => null }));
vi.mock("@/components/kanban/CalendarioDoFunil", () => ({ CalendarioDoFunil: () => null }));
vi.mock("@/components/kanban/KanbanBoard", () => ({
  KanbanBoard: (props: { somenteLeitura?: boolean; podeRenomearEtapa?: boolean }) => {
    visto.somenteLeitura = props.somenteLeitura ?? false;
    visto.podeRenomearEtapa = props.podeRenomearEtapa ?? false;
    return <div data-testid="quadro" />;
  },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const FUNIL_LEVE = {
  id: "p-1",
  name: "Comercial 2025",
  vocabulary: null,
  settings: {},
  is_archived: true,
} as unknown as Pipeline;
const ETAPAS = [
  { id: "e-1", name: "Prospecção", position: 0, is_won: false, is_lost: false },
] as unknown as Stage[];

function montarPagina() {
  return import("@/app/app/pipelines/[id]/_client").then(({ PipelinePageClient }) =>
    render(
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Comercial 2025"
        role="admin"
        funis={[]}
        funilInicial={FUNIL_LEVE}
        etapasIniciais={ETAPAS}
      />,
    ),
  );
}

beforeEach(() => {
  arquivado.valor = true;
  carregando.valor = false;
  parametros.valor = "";
  visto.somenteLeitura = null;
  visto.podeRenomearEtapa = null;
});

describe("a página de um funil arquivado (#1298, item 1)", () => {
  it("avisa que é leitura e leva de volta aos Funis", async () => {
    await montarPagina();

    const aviso = screen.getByTestId("funil-arquivado-aviso");
    expect(aviso.textContent).toMatch(/arquivado/i);
    expect(aviso.textContent).toMatch(/leitura/i);
    expect(screen.getByTestId("funil-arquivado-ir-para-funis")).toHaveAttribute(
      "href",
      "/app/kanban",
    );
  });

  it("não oferece criar negócio nem as abas que escrevem (Lista e Calendário)", async () => {
    await montarPagina();

    expect(screen.queryByRole("button", { name: /Novo Lead/ })).toBeNull();
    expect(screen.queryByTestId("visao-quadro")).toBeNull();
    expect(screen.queryByTestId("visao-lista")).toBeNull();
    expect(screen.queryByTestId("visao-calendario")).toBeNull();
  });

  it("entrega o quadro em leitura, e sem renomear etapa nem para quem é admin", async () => {
    await montarPagina();

    expect(visto.somenteLeitura).toBe(true);
    expect(visto.podeRenomearEtapa).toBe(false);
  });

  it("com ?visao=lista na URL, o funil arquivado ainda carrega e mostra o quadro", async () => {
    parametros.valor = "visao=lista";
    await montarPagina();

    expect(screen.getByTestId("quadro")).toBeTruthy();
    expect(visto.somenteLeitura).toBe(true);
  });

  it("enquanto o quadro carrega, o funil do servidor já fecha o Novo Lead e as abas", async () => {
    carregando.valor = true;
    await montarPagina();

    expect(screen.getByTestId("funil-arquivado-aviso")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Novo Lead/ })).toBeNull();
    expect(screen.queryByTestId("visao-lista")).toBeNull();
  });

  it("no funil VIVO nada disso vale: o botão e as abas continuam, e o quadro escreve", async () => {
    arquivado.valor = false;
    await montarPagina();

    expect(screen.queryByTestId("funil-arquivado-aviso")).toBeNull();
    expect(screen.getByRole("button", { name: /Novo Lead/ })).toBeTruthy();
    expect(screen.getByTestId("visao-quadro")).toBeTruthy();
    expect(visto.somenteLeitura).toBe(false);
    expect(visto.podeRenomearEtapa).toBe(true);
  });
});
