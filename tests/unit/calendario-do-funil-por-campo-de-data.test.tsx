/**
 * A VISÃO DE CALENDÁRIO DO FUNIL (#2770) MOSTRA O NEGÓCIO NO DIA DA SUA DATA —
 * e só ele.
 *
 * ─── O que está sendo cobrado ──────────────────────────────────────────────
 *
 * O funil guarda datas importantes em campos personalizados (`data_inicio`,
 * `data_fim`, data do evento) e não tinha nenhum lugar para VÊ-LAS por período:
 * a Agenda é para compromissos com horário e não mostra negócio; o quadro mostra
 * a etapa, não a data. A visão nova é a terceira aba do funil, ao lado do
 * quadro.
 *
 * Os dois casos centrais são a régua da feature, e os dois são sobre a MESMA
 * pergunta: quem entra no mês?
 *
 *   1. lead COM `data_inicio` dentro do mês aparece na célula do dia certo;
 *   2. lead SEM data não aparece — um negócio sem data não pode ser inventado
 *      num dia (nem empurrado para "hoje", nem para o fim do mês): ele simples
 *     mente não tem where na grade, e o operador precisa ver essa ausência para
 *      saber que falta preencher o campo.
 *
 * Os outros casos cobrem o resto do escopo fechado da issue: semana, escolha do
 * campo de data (outro campo, outros negócios) e clique abrindo a ficha.
 * Filtro por responsável/etapa/etiqueta e assinatura ICS ficam DE FORA por
 * decisão do escopo — não há teste cobrindo-os.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarioDoFunil } from "@/components/kanban/CalendarioDoFunil";
import { diasDoNegocio, negociosPorDia } from "@/lib/kanban/calendario-do-funil";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// app/app/pipelines/[id]/trocar-funil.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

// O dossiê tem testes próprios; aqui só importa que o clique do calendário ABRE
// ele, com o negócio certo.
vi.mock("@/components/kanban/LeadDossier", () => ({
  LeadDossier: ({ lead }: { lead: Lead | null }) =>
    lead ? (
      <div data-testid="ficha-aberta">{lead.title}</div>
    ) : null,
}));
// Membro do time só serve para o cabeçalho da ficha — rede aqui seria ruído.
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));

afterEach(() => cleanup());

const FUNIL: Pipeline = {
  id: "p-2770",
  organization_id: "org-1",
  name: "Viagens",
  slug: "viagens",
  description: null,
  is_default: true,
  is_archived: false,
  position: 1,
  vocabulary: {},
  settings: {
    fields: [
      { key: "data_inicio", label: "Data de início", type: "date" },
      { key: "data_fim", label: "Data de fim", type: "date" },
    ],
  },
};

const ETAPAS: Stage[] = [
  {
    id: "etapa-1",
    organization_id: "org-1",
    pipeline_id: "p-2770",
    name: "Proposta",
    slug: "proposta",
    position: 1,
    color: null,
    is_won: false,
    is_lost: false,
    is_archived: false,
    expected_duration_hours: null,
  },
];

function negocio(id: string, title: string, custom_fields: Record<string, unknown>): Lead {
  return {
    id,
    organization_id: "org-1",
    pipeline_id: "p-2770",
    stage_id: "etapa-1",
    contact_id: null,
    title,
    description: null,
    status: "open",
    lost_reason: null,
    position_in_stage: 1,
    value_cents: null,
    currency: null,
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    assigned_at: null,
    last_activity_at: null,
    stage_changed_at: null,
    expected_close_date: null,
    closed_at: null,
    source: "manual",
    source_metadata: {},
    external_id: null,
    custom_fields,
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    created_by_user_id: null,
  };
}

/** `YYYY-MM-DD` do dia 15 do mês EM CURSO — sempre dentro do mês da grade. */
function diaDozeDoMes(): string {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-15`;
}

function diaDeHoje(): string {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-${String(
    agora.getDate(),
  ).padStart(2, "0")}`;
}

function montar(leads: Lead[]) {
  return render(
    <CalendarioDoFunil pipelineId={FUNIL.id} pipeline={FUNIL} stages={ETAPAS} leads={leads} />,
  );
}

describe("a visão de mês", () => {
  it("coloca o lead com data_inicio no mês na célula do dia certo", async () => {
    const dia = diaDozeDoMes();
    montar([negocio("l1", "Embarque da Silva", { data_inicio: dia })]);

    const celula = screen.getByTestId(`calendario-dia-${dia}`);
    expect(within(celula).getByText("Embarque da Silva")).toBeInTheDocument();
  });

  it("não mostra o lead SEM data — ele não tem dia na grade", () => {
    const dia = diaDozeDoMes();
    montar([
      negocio("l1", "Embarque da Silva", { data_inicio: dia }),
      negocio("l2", "Sem data marcada", {}),
    ]);

    expect(screen.queryByText("Sem data marcada")).not.toBeInTheDocument();
    expect(screen.getByText("Embarque da Silva")).toBeInTheDocument();
  });

  it("mostra um lead cuja data cai em OUTRO mês só depois de navegar até ele", async () => {
    const dia = diaDozeDoMes();
    montar([negocio("l1", "Embarque do mês que vem", { data_inicio: dia })]);

    await userEvent.click(screen.getByTestId("calendario-proximo"));
    expect(screen.queryByText("Embarque do mês que vem")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("calendario-anterior"));
    expect(screen.getByText("Embarque do mês que vem")).toBeInTheDocument();
  });
});

describe("a visão de semana", () => {
  it("mostra o mesmo negócio e continua sem inventar o sem data", async () => {
    const hoje = diaDeHoje();
    montar([
      negocio("l1", "Retorno de hoje", { data_inicio: hoje }),
      negocio("l2", "Sem data marcada", {}),
    ]);

    await userEvent.click(screen.getByTestId("calendario-semana"));

    expect(screen.getByText("Retorno de hoje")).toBeInTheDocument();
    expect(screen.queryByText("Sem data marcada")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendario-mes")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("calendario-semana")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("a escolha do campo de data", () => {
  it("trocar o campo troca os negócios que aparecem", async () => {
    const dia = diaDozeDoMes();
    montar([
      negocio("l1", "Tem data de início", { data_inicio: dia }),
      negocio("l2", "Tem data de fim", { data_fim: dia }),
    ]);

    // Padrão: primeiro campo de data do funil (`data_inicio`).
    expect(screen.getByText("Tem data de início")).toBeInTheDocument();
    expect(screen.queryByText("Tem data de fim")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("combobox", { name: "Campo de data" }));
    await userEvent.click(await screen.findByRole("option", { name: "Data de fim" }));

    expect(screen.getByText("Tem data de fim")).toBeInTheDocument();
    expect(screen.queryByText("Tem data de início")).not.toBeInTheDocument();
  });
});

describe("clicar no negócio", () => {
  it("abre a ficha dele", async () => {
    const dia = diaDozeDoMes();
    montar([negocio("l1", "Embarque da Silva", { data_inicio: dia })]);

    await userEvent.click(screen.getByTestId("calendario-negocio-l1"));

    expect(screen.getByTestId("ficha-aberta")).toHaveTextContent("Embarque da Silva");
  });
});

describe("o agrupamento por dia", () => {
  it("leva o lead para o dia da data e ignora quem não tem data", () => {
    const leads = [
      negocio("l1", "Ida", { data_inicio: "2026-03-10" }),
      negocio("l2", "Sem data", { descricao: "nada aqui" }),
      negocio("l3", "Data inválida", { data_inicio: "2026-02-30" }),
    ];

    const porDia = negociosPorDia(leads, "data_inicio");

    expect(porDia.get("2026-03-10")?.map((l) => l.id)).toEqual(["l1"]);
    expect([...porDia.values()].flat().map((l) => l.id)).not.toContain("l2");
    expect([...porDia.values()].flat().map((l) => l.id)).not.toContain("l3");
  });

  it("com dois campos, cobre o intervalo inteiro — e não anda para trás", () => {
    const ida = negocio("l1", "Viagem", { data_inicio: "2026-03-10", data_fim: "2026-03-12" });
    const invertida = negocio("l2", "Volta antes da ida", {
      data_inicio: "2026-03-20",
      data_fim: "2026-03-18",
    });

    expect(diasDoNegocio(ida, "data_inicio", "data_fim")).toEqual([
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
    ]);
    // Fim antes do início não é intervalo: fica só o dia do início.
    expect(diasDoNegocio(invertida, "data_inicio", "data_fim")).toEqual(["2026-03-20"]);
  });

  it("sem o segundo campo, é um dia só", () => {
    const l = negocio("l1", "Evento", { data_inicio: "2026-03-10", data_fim: "2026-03-12" });
    expect(diasDoNegocio(l, "data_inicio")).toEqual(["2026-03-10"]);
  });
});
