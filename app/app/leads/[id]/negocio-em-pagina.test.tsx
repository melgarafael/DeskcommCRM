// app/app/leads/[id]/negocio-em-pagina.test.tsx
/**
 * #4151 — A PÁGINA DO NEGÓCIO, EM DUAS COLUNAS.
 *
 * O painel lateral é uma coluna estreita: ler um resumo de caso longo nele é
 * rolar muito com pouca largura. A página existe para isso, e o desenho pedido
 * é explícito — DADOS DO NEGÓCIO (com a descrição em área alta) de um lado,
 * TAREFAS e LINHA DO TEMPO do outro.
 *
 * O que este arquivo mede é a POSIÇÃO, não a presença: as mesmas peças já
 * estavam na tela do dossiê, e um `getByText` ficaria verde com tudo empilhado
 * numa coluna só. A leitura é pela ordem no DOM (`compareDocumentPosition`) e
 * pelas duas colunas declaradas no layout.
 *
 * As peças de dentro são substituídas por marcadores: o objeto aqui é o
 * LAYOUT, e cada uma delas tem teste próprio. O `LeadFieldsForm` marcado é o
 * único que lê as props, porque é nele que a "descrição em área alta" mora.
 */
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Lead } from "@/lib/types/leads";

const { propsDoFormulario } = vi.hoisted(() => ({
  propsDoFormulario: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false, support: false }),
  useActiveOrg: () => ({ role: "agent" }),
  usePermission: () => true,
}));
vi.mock("@/hooks/leads/useLeadTimeline", () => ({
  useLeadTimeline: () => ({
    itens: [
      { id: "a2", type: "stage_changed" },
      { id: "a1", type: "lead_created" },
    ],
    chegouAoVivo: new Set<string>(),
    isLoading: false,
    isError: false,
    realtimeStatus: "connected",
    seguranca: { divergencias: 0 },
  }),
}));

vi.mock("@/components/kanban/LeadFieldsForm", () => ({
  LeadFieldsForm: (props: Record<string, unknown>) => {
    propsDoFormulario.push(props);
    return <div data-peca="campos" />;
  },
}));
vi.mock("@/components/kanban/RevisaoDoDocumento", () => ({
  RevisaoDoDocumento: () => <div data-peca="revisao" />,
}));
vi.mock("@/components/kanban/TarefasDoNegocio", () => ({
  TarefasDoNegocio: () => <div data-peca="tarefas" />,
}));
vi.mock("@/components/kanban/LeadTimeline", () => ({
  LeadTimeline: ({ itens }: { itens: Array<{ id: string }> }) => (
    <ul data-peca="linha-do-tempo">
      {itens.map((i) => (
        <li key={i.id} data-entrada={i.id} />
      ))}
    </ul>
  ),
}));
vi.mock("@/components/kanban/ContatoDoNegocio", () => ({
  ContatoDoNegocio: () => <div data-peca="contato" />,
}));
vi.mock("@/components/kanban/PropostasDoNegocio", () => ({
  PropostasDoNegocio: () => <div data-peca="propostas" />,
}));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({
  ConversaNoDossie: () => <div data-peca="conversa" />,
}));

import { NegocioEmPagina } from "./_client";

const LEAD = {
  id: "lead-1",
  title: "Viagem Rio",
  description: "Resumo do caso, escrito pelo atendente.",
  contact_id: "contato-1",
  contact_phone: "+552****9999",
  value_cents: 250000,
  currency: "BRL",
  score: null,
  conversa: null,
  owner_kind: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_agent: null,
} as unknown as Lead;

function montar(voltar = "/app/pipelines/funil-1?etapa=e1") {
  return render(
    <NegocioEmPagina
      lead={LEAD}
      pipelineId="funil-1"
      stageName="Novo"
      fieldDefs={[]}
      voltar={voltar}
    />,
  );
}

function coluna(nome: string): HTMLElement {
  const no = document.querySelector(`[data-coluna="${nome}"]`);
  expect(no, `a coluna ${nome} não está no DOM`).not.toBeNull();
  return no as HTMLElement;
}

beforeEach(() => {
  propsDoFormulario.length = 0;
});

describe("#4151 — o negócio em página inteira", () => {
  it("⭐ duas colunas: dados do negócio à esquerda, tarefas e linha do tempo à direita", () => {
    montar();

    expect(within(coluna("negocio")).getByText("Dados do negócio")).toBeInTheDocument();

    // A descrição (dentro dos campos) e a revisão do documento ficam na coluna
    // dos DADOS; tarefas e linha do tempo, na do ACOMPANHAMENTO.
    expect(coluna("negocio").querySelector('[data-peca="campos"]')).not.toBeNull();
    expect(coluna("negocio").querySelector('[data-peca="revisao"]')).not.toBeNull();
    expect(coluna("acompanhamento").querySelector('[data-peca="tarefas"]')).not.toBeNull();
    expect(coluna("acompanhamento").querySelector('[data-peca="linha-do-tempo"]')).not.toBeNull();

    // E as duas colunas são IRMÃS no mesmo grid — não uma dentro da outra, que
    // é o que faria "duas colunas" ser só um nome.
    expect(coluna("negocio").parentElement).toBe(coluna("acompanhamento").parentElement);
  });

  it("⭐ a descrição ganha área ALTA na página (o painel continua com a de 3 linhas)", () => {
    montar();

    expect(propsDoFormulario).toHaveLength(1);
    expect(propsDoFormulario[0].descricaoAlta).toBe(true);
    // O mesmo negócio, o mesmo formulário: nada de um segundo editor.
    expect(propsDoFormulario[0].lead).toBe(LEAD);
  });

  it("⭐ o 'voltar' leva ao quadro com o filtro de quem estava lá", () => {
    montar("/app/pipelines/funil-1?etapa=e1&etiqueta=quente");

    expect(screen.getByRole("link", { name: "Voltar ao quadro" })).toHaveAttribute(
      "href",
      "/app/pipelines/funil-1?etapa=e1&etiqueta=quente",
    );
  });

  it("a página mostra o negócio: título, valor e etapa", () => {
    montar();

    expect(screen.getByRole("heading", { level: 1, name: "Viagem Rio" })).toBeInTheDocument();
    expect(screen.getByText("Novo")).toBeInTheDocument();
  });

  it("contato e propostas também entram — a página não é só o formulário", () => {
    montar();

    expect(document.querySelector('[data-peca="contato"]')).not.toBeNull();
    expect(document.querySelector('[data-peca="propostas"]')).not.toBeNull();
  });
});
